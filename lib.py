"""
Faerber Client OS — shared library functions.
Used by pull_client.py, sync_all.py, ingest_checkins.py, generate_recommendations.py.
"""
import base64
import glob
import json
import os
import re
import sys
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
ENV_PATH = Path.home() / ".config" / "faerber" / ".env"
if ENV_PATH.exists():
    load_dotenv(ENV_PATH)
else:
    load_dotenv(PROJECT_ROOT / ".env")

TRAINERIZE_GROUP_ID = os.environ["TRAINERIZE_GROUP_ID"]
TRAINERIZE_API_TOKEN = os.environ["TRAINERIZE_API_TOKEN"]
SUPABASE_URL = os.environ.get(
    "FAERBER_CLIENT_OS_SUPABASE_URL", "https://sfuvqaoeuajsrvldoiek.supabase.co"
)
SUPABASE_KEY = os.environ.get(
    "FAERBER_CLIENT_OS_SUPABASE_KEY",
    "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U",
)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

TZ_BASE_URL = "https://api.trainerize.com/v03"
STREAK_MILESTONES = [7, 14, 30, 60, 90]
CHECKINS_DIR = PROJECT_ROOT / "faerber-checkin" / "clients"

_auth_header = "Basic " + base64.b64encode(
    f"{TRAINERIZE_GROUP_ID}:{TRAINERIZE_API_TOKEN}".encode()
).decode()


def supabase_client() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)


# ---------- Trainerize ----------
def tz_post(path: str, body: dict, timeout: int = 30) -> dict:
    res = requests.post(
        f"{TZ_BASE_URL}{path}",
        headers={"Authorization": _auth_header, "Content-Type": "application/json"},
        json=body,
        timeout=timeout,
    )
    res.raise_for_status()
    return res.json()


def list_active_clients() -> list[dict]:
    """Return all active clients in Trainerize."""
    data = tz_post("/user/getList", {"start": 0, "count": 200})
    users = data.get("users", [])
    return [u for u in users if u.get("status") == "active" and u.get("type") == "client"]


def pull_calendar(user_id: int, start: date, end: date) -> dict[str, list[dict]]:
    data = tz_post(
        "/calendar/getList",
        {"userID": user_id, "startDate": start.isoformat(), "endDate": end.isoformat()},
    )
    return {day["date"]: day.get("items", []) for day in data.get("calendar", [])}


def pull_nutrition(user_id: int, start: date, end: date) -> dict[str, dict]:
    data = tz_post(
        "/dailyNutrition/getList",
        {"userID": user_id, "startDate": start.isoformat(), "endDate": end.isoformat()},
    )
    return {n["date"]: n for n in data.get("nutrition", [])}


def pull_targets(user_id: int) -> dict:
    """Return {calorieGoal, proteinGoal, carbsGoal, fatGoal} from mealPlan or goal endpoint."""
    try:
        mp = tz_post("/mealPlan/get", {"userID": user_id})
        plan = mp.get("mealPlan", {}) or {}
        if plan.get("caloricGoal"):
            return {
                "calories": int(plan.get("caloricGoal") or 0),
                "protein": int(plan.get("proteinGrams") or 0),
                "carbs": int(plan.get("carbsGrams") or 0),
                "fat": int(plan.get("fatGrams") or 0),
            }
    except Exception:
        pass
    try:
        g = tz_post("/goal/getNutrition", {"userID": user_id})
        nut = g.get("goal", {}) or {}
        return {
            "calories": int(nut.get("caloricGoal") or 0),
            "protein": int(nut.get("proteinGrams") or 0),
            "carbs": int(nut.get("carbsGrams") or 0),
            "fat": int(nut.get("fatGrams") or 0),
        }
    except Exception:
        return {"calories": 0, "protein": 0, "carbs": 0, "fat": 0}


# ---------- Snapshot computation ----------
def extract_day(snapshot_date: date, calendar_by_date: dict, nutrition_by_date: dict) -> dict:
    key = snapshot_date.isoformat()
    cal_items = calendar_by_date.get(key, [])
    nut = nutrition_by_date.get(key)
    workouts_scheduled = sum(1 for it in cal_items if it.get("type", "").startswith("workout"))
    workouts_completed = sum(
        1 for it in cal_items
        if it.get("type", "").startswith("workout") and it.get("status") == "tracked"
    )
    food_logged = nut is not None and (nut.get("calories") or 0) > 0
    return {
        "date": snapshot_date,
        "workouts_scheduled": workouts_scheduled,
        "workouts_completed": workouts_completed,
        "food_logged": food_logged,
        "calories": int(round(nut["calories"])) if nut and nut.get("calories") else None,
        "protein_g": int(round(nut["proteinGrams"])) if nut and nut.get("proteinGrams") else None,
        "carbs_g": int(round(nut["carbsGrams"])) if nut and nut.get("carbsGrams") else None,
        "fat_g": int(round(nut["fatGrams"])) if nut and nut.get("fatGrams") else None,
    }


def rolling_avg(values: list[Optional[float]]) -> Optional[float]:
    cleaned = [v for v in values if v is not None]
    return round(sum(cleaned) / len(cleaned), 1) if cleaned else None


def _compute_weight_trajectory(client: dict, checkins: list[dict]) -> tuple[str, Optional[float]]:
    """Use last 4 check-ins' weight_change values to determine trajectory.
    Returns ('good'|'neutral'|'bad'|'unknown', cumulative_change_lbs).
    """
    if not checkins:
        return "unknown", None

    start_w = client.get("starting_weight_lbs")
    goal_w = client.get("goal_weight_lbs")
    if not (start_w and goal_w):
        return "unknown", None

    goal_direction = "down" if goal_w < start_w else "up"

    changes = []
    for c in checkins[:4]:
        raw = c.get("raw_form_data", {}) or {}
        v = raw.get("weight_change_parsed")
        if v is None:
            txt = raw.get("weight_change", "")
            if txt:
                m = re.search(r"[-+]?\d+\.?\d*", str(txt))
                if m:
                    v = float(m.group())
        if v is not None:
            changes.append(v)

    if not changes:
        return "unknown", None

    cumulative = round(sum(changes), 1)

    # Threshold for "neutral": within ±0.5 lb cumulative
    if abs(cumulative) <= 0.5:
        return "neutral", cumulative
    if goal_direction == "down":
        return ("good", cumulative) if cumulative < 0 else ("bad", cumulative)
    else:  # goal up
        return ("good", cumulative) if cumulative > 0 else ("bad", cumulative)


def compute_snapshot(
    target_date: date,
    days: list[dict],
    protein_target_g: int,
    client: dict = None,
    checkins: list[dict] = None,
) -> dict:
    history = sorted([d for d in days if d["date"] <= target_date], key=lambda d: d["date"])
    last_7 = [d for d in history if d["date"] > target_date - timedelta(days=7)]

    workouts_scheduled_7 = sum(d["workouts_scheduled"] for d in last_7)
    workouts_completed_7 = sum(d["workouts_completed"] for d in last_7)
    workouts_missed_7 = workouts_scheduled_7 - workouts_completed_7
    workout_pct_7 = round((workouts_completed_7 / workouts_scheduled_7) * 100, 1) if workouts_scheduled_7 else None

    avg_cal_7 = rolling_avg([d["calories"] for d in last_7])
    avg_protein_7 = rolling_avg([d["protein_g"] for d in last_7])
    avg_carbs_7 = rolling_avg([d["carbs_g"] for d in last_7])
    avg_fat_7 = rolling_avg([d["fat_g"] for d in last_7])
    days_logged_7 = sum(1 for d in last_7 if d["food_logged"])

    workout_streak = log_streak = protein_streak = 0
    for d in reversed(history):
        if d["workouts_completed"] > 0: workout_streak += 1
        else: break
    for d in reversed(history):
        if d["food_logged"]: log_streak += 1
        else: break
    for d in reversed(history):
        if d["protein_g"] is not None and protein_target_g and d["protein_g"] >= protein_target_g: protein_streak += 1
        else: break

    yesterday = target_date - timedelta(days=1)
    yest = next((d for d in history if d["date"] == yesterday), None)

    # Logging gap
    consecutive_unlogged = 0
    max_unlogged_gap = 0
    for d in last_7:
        if not d["food_logged"]:
            consecutive_unlogged += 1
            max_unlogged_gap = max(max_unlogged_gap, consecutive_unlogged)
        else:
            consecutive_unlogged = 0

    # Workout gap (only count when SCHEDULED that day OR rolling — use no-completion streak in last 7)
    consecutive_no_workout = 0
    max_workout_gap = 0
    for d in last_7:
        if d["workouts_completed"] == 0 and d["workouts_scheduled"] > 0:
            consecutive_no_workout += 1
            max_workout_gap = max(max_workout_gap, consecutive_no_workout)
        elif d["workouts_completed"] > 0:
            consecutive_no_workout = 0
        # if not scheduled and not completed, don't break the streak — rest day

    # Onboarding grace period (first 7 days from start_date)
    is_onboarding = False
    if client and client.get("start_date"):
        try:
            start = datetime.fromisoformat(client["start_date"]).date() if isinstance(client["start_date"], str) else client["start_date"]
            days_since_start = (target_date - start).days
            is_onboarding = days_since_start < 7 and days_since_start >= 0
        except Exception:
            pass

    # Weight trajectory
    trajectory, cumulative_change = (
        _compute_weight_trajectory(client, checkins) if client and checkins else ("unknown", None)
    )

    # Determine flag
    reasons = []
    workout_completion = (workouts_completed_7 / workouts_scheduled_7) if workouts_scheduled_7 else None

    no_data = workouts_scheduled_7 == 0 and days_logged_7 == 0

    if is_onboarding:
        flag = "onboarding"
        reasons.append("First week — grace period")
    elif no_data:
        flag = "no_data"
        reasons.append("No activity — program paused or inactive")
    else:
        # RED triggers
        red_triggers = []
        if max_unlogged_gap >= 3:
            red_triggers.append(f"Logging gap: {max_unlogged_gap} days")
        if days_logged_7 <= 2:
            red_triggers.append(f"Only {days_logged_7}/7 days logged")
        if max_workout_gap >= 4:
            red_triggers.append(f"No workouts for {max_workout_gap}+ days when scheduled")
        if trajectory == "bad":
            red_triggers.append(f"Weight trending wrong direction ({cumulative_change:+.1f} lbs over recent check-ins)")

        # YELLOW triggers
        yellow_triggers = []
        if max_unlogged_gap in (1, 2):
            yellow_triggers.append(f"Logging gap: {max_unlogged_gap} day{'s' if max_unlogged_gap > 1 else ''}")
        if days_logged_7 in (3, 4):
            yellow_triggers.append(f"Only {days_logged_7}/7 days logged")
        if workout_completion is not None and workouts_scheduled_7 >= 5 and workout_completion < 0.6:
            yellow_triggers.append(f"Workout completion {int(workout_completion*100)}%")
        if trajectory == "neutral":
            yellow_triggers.append("Weight flat — nudge toward goal")

        if red_triggers:
            flag = "red"
            reasons = red_triggers
        elif yellow_triggers:
            flag = "yellow"
            reasons = yellow_triggers
        else:
            flag = "green"
            reasons.append("Compliance steady, trajectory holding")

    return {
        "snapshot_date": target_date.isoformat(),
        "workouts_scheduled_this_week": workouts_scheduled_7,
        "workouts_completed_this_week": workouts_completed_7,
        "workouts_missed_this_week": workouts_missed_7,
        "workout_completion_pct": workout_pct_7,
        "food_logged_yesterday": bool(yest and yest["food_logged"]),
        "yesterday_calories": yest["calories"] if yest else None,
        "yesterday_protein_g": yest["protein_g"] if yest else None,
        "yesterday_carbs_g": yest["carbs_g"] if yest else None,
        "yesterday_fat_g": yest["fat_g"] if yest else None,
        "avg_calories_7d": avg_cal_7,
        "avg_protein_g_7d": avg_protein_7,
        "avg_carbs_g_7d": avg_carbs_7,
        "avg_fat_g_7d": avg_fat_7,
        "days_logged_last_7": days_logged_7,
        "workout_streak_days": workout_streak,
        "log_streak_days": log_streak,
        "protein_target_streak_days": protein_streak,
        "flag_color": flag,
        "flag_reasons": reasons,
        "weight_trajectory": trajectory,
        "weight_change_last_4wk": cumulative_change,
        "is_onboarding": is_onboarding,
    }


def sync_trainerize_data(supabase: Client, client_row: dict, days: int = 30) -> dict:
    """Pull 30 days for a single client, write snapshots + milestones + alerts.
    Returns summary dict."""
    user_id = int(client_row["trainerize_user_id"])
    protein_target = client_row.get("daily_protein_target_g") or 100

    end = date.today()
    start = end - timedelta(days=days)

    calendar = pull_calendar(user_id, start, end)
    nutrition = pull_nutrition(user_id, start, end)
    days_data = [extract_day(start + timedelta(days=i), calendar, nutrition) for i in range(days + 1)]

    # Fetch latest 5 check-ins for trajectory calc (assumes ingest_all_checkins already ran)
    checkins = (
        supabase.table("weekly_checkins").select("*")
        .eq("client_id", client_row["id"])
        .order("checkin_date", desc=True)
        .limit(5)
        .execute()
        .data
    )

    snapshots = [
        compute_snapshot(d["date"], days_data, protein_target, client=client_row, checkins=checkins)
        for d in days_data
    ]

    # Upsert
    payload = [{**s, "client_id": client_row["id"]} for s in snapshots]
    supabase.table("daily_snapshots").upsert(payload, on_conflict="client_id,snapshot_date").execute()

    # Streak milestones
    new_milestones = 0
    for snap in snapshots:
        for milestone in STREAK_MILESTONES:
            for streak_type, streak_val in [
                ("workout", snap["workout_streak_days"]),
                ("log", snap["log_streak_days"]),
                ("protein_target", snap["protein_target_streak_days"]),
            ]:
                if streak_val == milestone:
                    try:
                        supabase.table("streak_milestones").insert({
                            "client_id": client_row["id"],
                            "milestone_type": streak_type,
                            "milestone_value": milestone,
                        }).execute()
                        new_milestones += 1
                    except Exception:
                        pass

    # Coach alert for latest yellow/red
    latest = snapshots[-1]
    if latest["flag_color"] in ("yellow", "red"):
        try:
            supabase.table("coach_alerts").insert({
                "client_id": client_row["id"],
                "alert_type": f"{latest['flag_color']}_flag",
                "severity": latest["flag_color"],
                "alert_date": latest["snapshot_date"],
                "title": f"{latest['flag_color'].upper()} flag — {latest['snapshot_date']}",
                "message": "; ".join(latest["flag_reasons"]) or "Compliance issue",
            }).execute()
        except Exception:
            pass

    return {
        "snapshots": len(snapshots),
        "milestones": new_milestones,
        "latest_flag": latest["flag_color"],
        "latest_reasons": latest["flag_reasons"],
    }


# ---------- Client seeding ----------
def upsert_client(supabase: Client, tz_user: dict) -> dict:
    """Insert or update a client row from Trainerize user data.
    Always refreshes targets (calories + macros) from latest Trainerize mealPlan/goal.
    """
    trainerize_id = str(tz_user["id"])
    existing = (
        supabase.table("clients").select("*")
        .eq("trainerize_user_id", trainerize_id).limit(1).execute()
    )

    try:
        targets = pull_targets(int(trainerize_id))
    except Exception:
        targets = {"calories": 0, "protein": 0, "carbs": 0, "fat": 0}

    if existing.data:
        # Update targets on existing client (other fields kept as-is)
        client = existing.data[0]
        update_payload = {
            "daily_calorie_target": targets["calories"] or client.get("daily_calorie_target"),
            "daily_protein_target_g": targets["protein"] or client.get("daily_protein_target_g"),
            "daily_carbs_target_g": targets["carbs"] or client.get("daily_carbs_target_g"),
            "daily_fat_target_g": targets["fat"] or client.get("daily_fat_target_g"),
        }
        res = supabase.table("clients").update(update_payload).eq("id", client["id"]).execute()
        return res.data[0] if res.data else client

    # New client
    created = tz_user.get("created", "")[:10] or None
    payload = {
        "trainerize_user_id": trainerize_id,
        "full_name": tz_user.get("name") or f"{tz_user.get('firstName','')} {tz_user.get('lastName','')}".strip(),
        "email": tz_user.get("email"),
        "phone": tz_user.get("phoneNumber"),
        "start_date": created,
        "daily_calorie_target": targets["calories"] or None,
        "daily_protein_target_g": targets["protein"] or None,
        "daily_carbs_target_g": targets["carbs"] or None,
        "daily_fat_target_g": targets["fat"] or None,
        "weekly_target_workouts": 4,
        "is_active": True,
    }
    res = supabase.table("clients").insert(payload).execute()
    return res.data[0]


# ---------- FitMetrics check-ins ----------
def parse_submitted_date(s: str) -> Optional[str]:
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    if not m: return None
    mm, dd, yyyy = m.groups()
    return f"{yyyy}-{mm}-{dd}"


def find_answer(answers: dict, *needles: str) -> Optional[str]:
    for q, a in answers.items():
        q_lower = q.lower()
        if all(n.lower() in q_lower for n in needles):
            return a
    return None


def parse_slider(s: str) -> Optional[int]:
    if not s: return None
    m = re.search(r"\d+", str(s))
    return int(m.group()) if m else None


def parse_rating(s: str) -> Optional[int]:
    if not s: return None
    m = re.search(r"(\d+)", str(s))
    return int(m.group(1)) if m else None


def parse_weight_change(s: str) -> Optional[float]:
    if not s: return None
    m = re.search(r"[-+]?\d+\.?\d*", str(s))
    return float(m.group()) if m else None


def normalize_submission(submission: dict) -> dict:
    answers = submission.get("answers", {})
    return {
        "checkin_date": parse_submitted_date(submission.get("submitted", "")),
        "stress_1to10": parse_slider(find_answer(answers, "stress")),
        "energy_1to10": parse_slider(find_answer(answers, "feel", "physically")),
        "wins": find_answer(answers, "biggest win"),
        "struggles": find_answer(answers, "struggled"),
        "questions": find_answer(answers, "support you"),
        "feedback": find_answer(answers, "improvement"),
        "raw_form_data": {
            "submitted_raw": submission.get("submitted"),
            "personal_goal": find_answer(answers, "personal goal"),
            "weight_change": find_answer(answers, "weight change"),
            "photos_uploaded": find_answer(answers, "uploaded", "check-in"),
            "things_did_well": find_answer(answers, "did well"),
            "committing_workout_days": find_answer(answers, "committing", "working out"),
            "other_comments": find_answer(answers, "other comments"),
            "rating": parse_rating(find_answer(answers, "rate", "program")),
            "referrals": find_answer(answers, "people", "struggling"),
            "all_answers": answers,
        },
    }


def ingest_all_checkins_for_client(supabase: Client, client_row: dict) -> int:
    """Read all checkin-answers JSON files, find this client's submissions, upsert."""
    name_lower = client_row["full_name"].lower()
    seen = {}
    for f in sorted(glob.glob(str(CHECKINS_DIR / "checkin-answers-*.json"))):
        try:
            data = json.loads(Path(f).read_text())
        except Exception:
            continue
        if not isinstance(data, list): continue
        for sub in data:
            cn = sub.get("name", "").lower()
            # Match if either full name appears in sub name or sub name contains client first name
            first = name_lower.split()[0] if name_lower else ""
            if name_lower in cn or (first and first in cn and name_lower.split()[-1] in cn):
                key = sub.get("submitted", "")
                if key and key not in seen:
                    seen[key] = sub

    written = 0
    for raw in seen.values():
        row = normalize_submission(raw)
        if not row["checkin_date"]: continue
        try:
            supabase.table("weekly_checkins").upsert(
                {**row, "client_id": client_row["id"]},
                on_conflict="client_id,checkin_date"
            ).execute()
            written += 1
        except Exception as e:
            pass
    return written


# ---------- Recommendation generation (Sonnet for bulk) ----------
def generate_recs_for_client(supabase: Client, client_row: dict, model: str = "claude-sonnet-4-6") -> int:
    """Pull bundle, ask Claude, write recs. Returns number written."""
    from anthropic import Anthropic
    anthropic = Anthropic(api_key=ANTHROPIC_API_KEY)

    snapshots = (
        supabase.table("daily_snapshots").select("*")
        .eq("client_id", client_row["id"])
        .order("snapshot_date", desc=True).limit(14).execute().data
    )
    checkins = (
        supabase.table("weekly_checkins").select("*")
        .eq("client_id", client_row["id"])
        .order("checkin_date", desc=True).limit(5).execute().data
    )
    milestones = (
        supabase.table("streak_milestones").select("*")
        .eq("client_id", client_row["id"])
        .order("hit_at", desc=True).execute().data
    )

    if not snapshots:
        return 0

    prompt = _build_recs_prompt(client_row, snapshots, checkins, milestones)
    try:
        response = anthropic.messages.create(
            model=model, max_tokens=2500,
            messages=[{"role": "user", "content": prompt}]
        )
        text = response.content[0].text.strip()
        if text.startswith("```"):
            text = text.split("```")[1]
            if text.startswith("json"): text = text[4:]
            text = text.strip()
        recs = json.loads(text)
    except Exception as e:
        print(f"   ⚠ recs gen failed: {e}", file=sys.stderr)
        return 0

    # Mark old as not current
    supabase.table("recommendations").update({"is_current": False}).eq("client_id", client_row["id"]).execute()
    # Insert new
    payload = [{
        "client_id": client_row["id"],
        "priority": r["priority"],
        "title": r["title"],
        "bullets": r.get("bullets") or [],
        "body": " · ".join(r.get("bullets") or []) if r.get("bullets") else r.get("body", ""),
        "action_type": r.get("action_type"),
        "rationale": r.get("rationale"),
        "is_current": True,
    } for r in recs]
    if payload:
        supabase.table("recommendations").insert(payload).execute()
    return len(payload)


def _build_recs_prompt(client, snapshots, checkins, milestones) -> str:
    latest = snapshots[0] if snapshots else None
    snap_lines = []
    for s in snapshots[:14]:
        snap_lines.append(
            f"  {s['snapshot_date']}: {s['flag_color'].upper()} | "
            f"wo {s['workouts_completed_this_week']}/{s['workouts_scheduled_this_week']} | "
            f"log {s['days_logged_last_7']}/7 | prot {s['avg_protein_g_7d']}g | "
            f"cal {s['avg_calories_7d']} | streaks wk={s['workout_streak_days']} log={s['log_streak_days']}"
        )
    checkin_lines = []
    for c in checkins:
        raw = c.get("raw_form_data", {}) or {}
        checkin_lines.append(
            f"\n--- {c['checkin_date']} ---\n"
            f"Stress {c['stress_1to10']}/10 | Energy {c['energy_1to10']}/10 | "
            f"Weight change: {raw.get('weight_change')}\n"
            f"Wins: {c.get('wins')}\nStruggles: {c.get('struggles')}\n"
            f"Asks: {c.get('questions')}\nRating: {raw.get('rating')}/10"
        )
    milestone_lines = [f"  {m['milestone_value']}-day {m['milestone_type']} streak" for m in milestones]
    return f"""You are an expert fitness + nutrition coach. Generate 3-5 prioritized coaching recommendations.

# CLIENT
- {client['full_name']}, age {client.get('age', '—')}, {client.get('location', '—')}
- Targets: {client.get('daily_calorie_target')} cal / {client.get('daily_protein_target_g')}g protein / {client.get('weekly_target_workouts')} workouts per week
- Starting: {client.get('starting_weight_lbs', '—')} lbs → Goal: {client.get('goal_weight_lbs', '—')} lbs
- Goal: {client.get('goal', '—')}
- Context: {client.get('context_summary', '(no Monday notes)')}
- Coach: {client.get('assigned_coach', '—')}, started {client.get('start_date')}

# CURRENT FLAG
{latest['flag_color'].upper() if latest else '—'} — {', '.join(latest.get('flag_reasons', [])) if latest else '—'}

# LAST 14 DAYS
{chr(10).join(snap_lines)}

# CHECK-INS (last 2 months)
{chr(10).join(checkin_lines) if checkin_lines else '(none)'}

# STREAK MILESTONES
{chr(10).join(milestone_lines) if milestone_lines else '(none)'}

---

SCANNABILITY IS CRITICAL. Each rec must read in 5 sec. Use BULLETS not paragraphs.

Each rec includes:
- priority (1 = most urgent)
- title (action-oriented, MAX 8 words)
- bullets (array of 2-3 short bullets, each MAX 15 words)
- action_type (one of: send_message | schedule_call | adjust_program | send_resource | celebrate | monitor)
- rationale (ONE sentence, MAX 20 words, citing specific data point)

CRITICAL RULES:
1. #1 rec = highest-leverage action for THIS client
2. If compliance is good but results aren't, CHANGE PROGRAM, don't push harder
3. Use SPECIFIC numbers from their data
4. Consider emotional/life context (grief, support, finances)
5. NO LONG SENTENCES. Fragments OK.

Return ONLY a JSON array. No prose. No markdown fences.

Example:
[{{"priority":1,"title":"Bump calories 100","bullets":["Raise 1400→1500","Drop protein 119→100g","Frame as adjustment"],"action_type":"adjust_program","rationale":"31 days perfect logging at 1400, weight flat."}}]
"""
