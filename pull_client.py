#!/usr/bin/env python3
"""
Faerber Client OS — Trainerize daily puller (single client)

Usage:
  python3 pull_client.py <trainerize_user_id> [--days 30]

What it does:
  1. Pulls last N days of calendar (workouts + habits + photos)
  2. Pulls last N days of nutrition logs
  3. Computes per-day snapshot rows:
       - workouts scheduled/completed (rolling 7-day)
       - food logged y/n
       - calories/protein/carbs/fat
       - rolling 7-day averages
       - streaks (workout, log, protein-target)
       - flag color (green/yellow/red) with reasons
  4. Upserts to Supabase `daily_snapshots`
  5. Detects new streak milestones (7/14/30/60/90) → writes to `streak_milestones`
  6. Writes coach alerts for yellow/red days → `coach_alerts`

Run after `pip install supabase python-dotenv requests`.
"""

import argparse
import base64
import os
import sys
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv
from supabase import Client, create_client

# ---------- Config ----------
PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
ENV_PATH = PROJECT_ROOT / ".env"
load_dotenv(ENV_PATH)

TRAINERIZE_GROUP_ID = os.environ["TRAINERIZE_GROUP_ID"]
TRAINERIZE_API_TOKEN = os.environ["TRAINERIZE_API_TOKEN"]
SUPABASE_URL = os.environ.get("FAERBER_CLIENT_OS_SUPABASE_URL", "https://sfuvqaoeuajsrvldoiek.supabase.co")
SUPABASE_KEY = os.environ.get(
    "FAERBER_CLIENT_OS_SUPABASE_KEY",
    "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U",
)

TZ_BASE_URL = "https://api.trainerize.com/v03"
STREAK_MILESTONES = [7, 14, 30, 60, 90]

# ---------- Trainerize client ----------
_auth_header = "Basic " + base64.b64encode(
    f"{TRAINERIZE_GROUP_ID}:{TRAINERIZE_API_TOKEN}".encode()
).decode()


def tz_post(path: str, body: dict) -> dict:
    res = requests.post(
        f"{TZ_BASE_URL}{path}",
        headers={"Authorization": _auth_header, "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    res.raise_for_status()
    return res.json()


def pull_calendar(user_id: int, start: date, end: date) -> dict[str, list[dict]]:
    """Returns dict: { 'YYYY-MM-DD': [items...] }"""
    data = tz_post(
        "/calendar/getList",
        {"userID": user_id, "startDate": start.isoformat(), "endDate": end.isoformat()},
    )
    return {day["date"]: day.get("items", []) for day in data.get("calendar", [])}


def pull_nutrition(user_id: int, start: date, end: date) -> dict[str, dict]:
    """Returns dict: { 'YYYY-MM-DD': nutrition_record }"""
    data = tz_post(
        "/dailyNutrition/getList",
        {"userID": user_id, "startDate": start.isoformat(), "endDate": end.isoformat()},
    )
    return {n["date"]: n for n in data.get("nutrition", [])}


# ---------- Per-day extraction ----------
def extract_day(
    snapshot_date: date,
    calendar_by_date: dict,
    nutrition_by_date: dict,
) -> dict:
    """Returns the raw daily metrics (pre-aggregation)."""
    key = snapshot_date.isoformat()
    cal_items = calendar_by_date.get(key, [])
    nut = nutrition_by_date.get(key)

    workouts_scheduled = sum(
        1 for it in cal_items if it.get("type", "").startswith("workout")
    )
    workouts_completed = sum(
        1
        for it in cal_items
        if it.get("type", "").startswith("workout") and it.get("status") == "tracked"
    )

    food_logged = nut is not None and (nut.get("calories") or 0) > 0
    calories = int(round(nut["calories"])) if nut and nut.get("calories") else None
    protein = int(round(nut["proteinGrams"])) if nut and nut.get("proteinGrams") else None
    carbs = int(round(nut["carbsGrams"])) if nut and nut.get("carbsGrams") else None
    fat = int(round(nut["fatGrams"])) if nut and nut.get("fatGrams") else None

    return {
        "date": snapshot_date,
        "workouts_scheduled": workouts_scheduled,
        "workouts_completed": workouts_completed,
        "food_logged": food_logged,
        "calories": calories,
        "protein_g": protein,
        "carbs_g": carbs,
        "fat_g": fat,
    }


# ---------- Aggregation + flag logic ----------
def rolling_avg(values: list[Optional[float]], window: int) -> Optional[float]:
    cleaned = [v for v in values if v is not None]
    if not cleaned:
        return None
    return round(sum(cleaned) / len(cleaned), 1)


def compute_snapshot(
    target_date: date,
    days: list[dict],
    protein_target_g: int,
) -> dict:
    """Given a target date + the previous 30 days of raw daily metrics, compute the snapshot."""
    # Filter to days <= target_date
    history = [d for d in days if d["date"] <= target_date]
    history.sort(key=lambda d: d["date"])

    last_7 = [d for d in history if d["date"] > target_date - timedelta(days=7)]

    # This-week aggregates
    workouts_scheduled_7 = sum(d["workouts_scheduled"] for d in last_7)
    workouts_completed_7 = sum(d["workouts_completed"] for d in last_7)
    workouts_missed_7 = workouts_scheduled_7 - workouts_completed_7
    workout_pct_7 = (
        round((workouts_completed_7 / workouts_scheduled_7) * 100, 1)
        if workouts_scheduled_7
        else None
    )

    avg_cal_7 = rolling_avg([d["calories"] for d in last_7], 7)
    avg_protein_7 = rolling_avg([d["protein_g"] for d in last_7], 7)
    days_logged_7 = sum(1 for d in last_7 if d["food_logged"])

    # Streaks (consecutive days ending at target_date)
    workout_streak = log_streak = protein_streak = 0
    for d in reversed(history):
        if d["workouts_completed"] > 0:
            workout_streak += 1
        else:
            break
    for d in reversed(history):
        if d["food_logged"]:
            log_streak += 1
        else:
            break
    for d in reversed(history):
        if d["protein_g"] is not None and d["protein_g"] >= protein_target_g:
            protein_streak += 1
        else:
            break

    # Yesterday's nutrition (the "freshest" log)
    yesterday = target_date - timedelta(days=1)
    yest = next((d for d in history if d["date"] == yesterday), None)
    food_logged_yesterday = bool(yest and yest["food_logged"])
    yest_cal = yest["calories"] if yest else None
    yest_protein = yest["protein_g"] if yest else None
    yest_carbs = yest["carbs_g"] if yest else None
    yest_fat = yest["fat_g"] if yest else None

    # Flag color + reasons
    reasons = []

    # Gap detection (2+ consecutive unlogged days within last 7)
    consecutive_unlogged = 0
    max_unlogged_gap = 0
    for d in last_7:
        if not d["food_logged"]:
            consecutive_unlogged += 1
            max_unlogged_gap = max(max_unlogged_gap, consecutive_unlogged)
        else:
            consecutive_unlogged = 0

    missed_workouts_7 = workouts_missed_7

    if max_unlogged_gap >= 2:
        reasons.append(f"Logging gap: {max_unlogged_gap} consecutive days")
    if missed_workouts_7 >= 2:
        reasons.append(f"Missed {missed_workouts_7} workouts this week")
    if avg_protein_7 is not None and avg_protein_7 < protein_target_g * 0.8:
        reasons.append(
            f"Protein avg low: {avg_protein_7:.0f}g vs {protein_target_g}g target"
        )

    # Tier classification
    if max_unlogged_gap >= 2 or missed_workouts_7 >= 2:
        flag = "red"
    elif (
        max_unlogged_gap == 1
        or missed_workouts_7 == 1
        or (avg_protein_7 is not None and avg_protein_7 < protein_target_g * 0.9)
    ):
        flag = "yellow"
        if not reasons:
            reasons.append("Minor compliance dip")
    else:
        flag = "green"

    return {
        "snapshot_date": target_date.isoformat(),
        "workouts_scheduled_this_week": workouts_scheduled_7,
        "workouts_completed_this_week": workouts_completed_7,
        "workouts_missed_this_week": workouts_missed_7,
        "workout_completion_pct": workout_pct_7,
        "food_logged_yesterday": food_logged_yesterday,
        "yesterday_calories": yest_cal,
        "yesterday_protein_g": yest_protein,
        "yesterday_carbs_g": yest_carbs,
        "yesterday_fat_g": yest_fat,
        "avg_calories_7d": avg_cal_7,
        "avg_protein_g_7d": avg_protein_7,
        "days_logged_last_7": days_logged_7,
        "workout_streak_days": workout_streak,
        "log_streak_days": log_streak,
        "protein_target_streak_days": protein_streak,
        "flag_color": flag,
        "flag_reasons": reasons,
    }


# ---------- Supabase ----------
def get_client(supabase: Client, trainerize_user_id: str) -> Optional[dict]:
    res = (
        supabase.table("clients")
        .select("*")
        .eq("trainerize_user_id", trainerize_user_id)
        .limit(1)
        .execute()
    )
    return res.data[0] if res.data else None


def upsert_snapshots(supabase: Client, client_id: str, snapshots: list[dict]) -> int:
    payload = [{**s, "client_id": client_id} for s in snapshots]
    res = (
        supabase.table("daily_snapshots")
        .upsert(payload, on_conflict="client_id,snapshot_date")
        .execute()
    )
    return len(res.data or [])


def detect_streak_milestones(
    supabase: Client, client_id: str, snapshots: list[dict]
) -> int:
    """Insert streak_milestones for any new 7/14/30/60/90 day hits."""
    fired = 0
    for snap in snapshots:
        for milestone in STREAK_MILESTONES:
            for streak_type, streak_val in [
                ("workout", snap["workout_streak_days"]),
                ("log", snap["log_streak_days"]),
                ("protein_target", snap["protein_target_streak_days"]),
            ]:
                if streak_val == milestone:
                    payload = {
                        "client_id": client_id,
                        "milestone_type": streak_type,
                        "milestone_value": milestone,
                    }
                    try:
                        supabase.table("streak_milestones").insert(payload).execute()
                        fired += 1
                    except Exception as e:
                        if "duplicate" not in str(e).lower():
                            print(f"  ⚠ milestone insert failed: {e}", file=sys.stderr)
    return fired


def write_alerts(supabase: Client, client_id: str, snapshots: list[dict]) -> int:
    """Write coach alerts for the most recent yellow/red snapshot only."""
    if not snapshots:
        return 0
    latest = snapshots[-1]
    if latest["flag_color"] not in ("yellow", "red"):
        return 0
    title = f"{latest['flag_color'].upper()} flag — {latest['snapshot_date']}"
    msg = "; ".join(latest["flag_reasons"]) or "Compliance issue detected"
    payload = {
        "client_id": client_id,
        "alert_type": f"{latest['flag_color']}_flag",
        "severity": latest["flag_color"],
        "alert_date": latest["snapshot_date"],
        "title": title,
        "message": msg,
    }
    try:
        supabase.table("coach_alerts").insert(payload).execute()
        return 1
    except Exception as e:
        if "duplicate" in str(e).lower():
            return 0
        raise


# ---------- Main ----------
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("trainerize_id", help="Trainerize userID")
    parser.add_argument("--days", type=int, default=30, help="Days of history to pull (default 30)")
    parser.add_argument("--dry-run", action="store_true", help="Don't write to Supabase")
    args = parser.parse_args()

    supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

    client = get_client(supabase, args.trainerize_id)
    if not client:
        print(f"❌ No client found with trainerize_user_id={args.trainerize_id}")
        sys.exit(1)

    print(f"📋 Client: {client['full_name']}")
    print(f"   Trainerize ID: {client['trainerize_user_id']}")
    print(f"   Target: {client['daily_calorie_target']} cal / {client['daily_protein_target_g']}g protein / {client['weekly_target_workouts']} workouts per week")

    end = date.today()
    start = end - timedelta(days=args.days)
    print(f"\n📅 Pulling {start} → {end} ({args.days} days)\n")

    # Pull from Trainerize
    print("  → Pulling calendar (workouts, habits, photos)...")
    calendar = pull_calendar(int(args.trainerize_id), start, end)
    print(f"     Got {len(calendar)} days")

    print("  → Pulling nutrition logs...")
    nutrition = pull_nutrition(int(args.trainerize_id), start, end)
    print(f"     Got {len(nutrition)} days with food data")

    # Extract daily metrics
    days = [
        extract_day(start + timedelta(days=i), calendar, nutrition)
        for i in range(args.days + 1)
    ]

    # Compute snapshot for each day
    snapshots = [
        compute_snapshot(
            target_date=d["date"],
            days=days,
            protein_target_g=client["daily_protein_target_g"] or 100,
        )
        for d in days
    ]

    # Print summary
    print(f"\n📊 Summary (last 30 days):")
    latest = snapshots[-1]
    flag_emoji = {"green": "🟢", "yellow": "🟡", "red": "🔴"}[latest["flag_color"]]
    print(f"   {flag_emoji} Current flag: {latest['flag_color'].upper()}")
    print(f"   Workouts this week: {latest['workouts_completed_this_week']}/{latest['workouts_scheduled_this_week']} ({latest['workout_completion_pct']}%)")
    print(f"   Food logged: {latest['days_logged_last_7']}/7 days")
    print(f"   Avg calories: {latest['avg_calories_7d']}")
    print(f"   Avg protein: {latest['avg_protein_g_7d']}g (target {client['daily_protein_target_g']}g)")
    print(f"   Streaks: workout {latest['workout_streak_days']}d | log {latest['log_streak_days']}d | protein {latest['protein_target_streak_days']}d")
    if latest["flag_reasons"]:
        print(f"   Reasons: {', '.join(latest['flag_reasons'])}")

    # Tier breakdown
    from collections import Counter
    tiers = Counter(s["flag_color"] for s in snapshots)
    print(f"\n   Flag history: 🟢 {tiers.get('green',0)}  🟡 {tiers.get('yellow',0)}  🔴 {tiers.get('red',0)} days")

    if args.dry_run:
        print("\n💤 Dry run — no writes")
        return

    # Write to Supabase
    print(f"\n💾 Writing to Supabase...")
    n_snaps = upsert_snapshots(supabase, client["id"], snapshots)
    print(f"   ✅ {n_snaps} snapshot rows upserted")

    n_streaks = detect_streak_milestones(supabase, client["id"], snapshots)
    print(f"   🎉 {n_streaks} new streak milestones")

    n_alerts = write_alerts(supabase, client["id"], snapshots)
    print(f"   🚨 {n_alerts} coach alerts written")

    print("\n✅ Done")


if __name__ == "__main__":
    main()
