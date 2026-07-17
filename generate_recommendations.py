#!/usr/bin/env python3
"""
Faerber Client OS — Coach Recommendation Generator

Pulls all available data for a client (Trainerize snapshots, FitMetrics check-ins,
Monday.com Notes Doc context) and uses Claude to generate prioritized,
actionable coaching recommendations.

Usage:
  python3 generate_recommendations.py <trainerize_id>
"""

import argparse
import json
import os
import sys
from pathlib import Path

from anthropic import Anthropic
from dotenv import load_dotenv
from supabase import create_client

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = os.environ.get(
    "FAERBER_CLIENT_OS_SUPABASE_URL", "https://sfuvqaoeuajsrvldoiek.supabase.co"
)
SUPABASE_KEY = os.environ.get(
    "FAERBER_CLIENT_OS_SUPABASE_KEY",
    "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U",
)
ANTHROPIC_API_KEY = os.environ["ANTHROPIC_API_KEY"]

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)
anthropic = Anthropic(api_key=ANTHROPIC_API_KEY)


def fetch_client_bundle(trainerize_id: str) -> dict:
    """Pull everything we know about the client."""
    client_res = (
        supabase.table("clients")
        .select("*")
        .eq("trainerize_user_id", trainerize_id)
        .limit(1)
        .execute()
    )
    if not client_res.data:
        raise SystemExit(f"❌ Client {trainerize_id} not found")
    client = client_res.data[0]

    snapshots = (
        supabase.table("daily_snapshots")
        .select("*")
        .eq("client_id", client["id"])
        .order("snapshot_date", desc=True)
        .limit(30)
        .execute()
        .data
    )

    checkins = (
        supabase.table("weekly_checkins")
        .select("*")
        .eq("client_id", client["id"])
        .order("checkin_date", desc=True)
        .limit(10)
        .execute()
        .data
    )

    milestones = (
        supabase.table("streak_milestones")
        .select("*")
        .eq("client_id", client["id"])
        .order("hit_at", desc=True)
        .execute()
        .data
    )

    return {
        "client": client,
        "snapshots": snapshots,
        "checkins": checkins,
        "milestones": milestones,
    }


def build_context_prompt(bundle: dict) -> str:
    client = bundle["client"]
    snapshots = bundle["snapshots"]
    checkins = bundle["checkins"]
    milestones = bundle["milestones"]

    latest = snapshots[0] if snapshots else None

    # Compress snapshots
    snap_lines = []
    for s in snapshots[:14]:
        snap_lines.append(
            f"  {s['snapshot_date']}: 🚩 {s['flag_color'].upper()} | "
            f"workouts {s['workouts_completed_this_week']}/{s['workouts_scheduled_this_week']} | "
            f"logged {s['days_logged_last_7']}/7 | "
            f"avg protein {s['avg_protein_g_7d']}g | "
            f"avg cal {s['avg_calories_7d']} | "
            f"streaks: wk={s['workout_streak_days']} log={s['log_streak_days']} prot={s['protein_target_streak_days']}"
        )

    # Compress check-ins
    checkin_lines = []
    for c in checkins:
        raw = c.get("raw_form_data", {}) or {}
        checkin_lines.append(
            f"\n--- Check-in {c['checkin_date']} ---\n"
            f"  Stress: {c['stress_1to10']}/10  |  Energy: {c['energy_1to10']}/10\n"
            f"  Weight change: {raw.get('weight_change')}\n"
            f"  Adherence (slider): {raw.get('all_answers',{}).get('Adherence to Diet?')}\n"
            f"  Biggest win: {c.get('wins')}\n"
            f"  Struggles: {c.get('struggles')}\n"
            f"  What they did well: {raw.get('things_did_well')}\n"
            f"  Workout days committed: {raw.get('committing_workout_days')}\n"
            f"  Support request: {c.get('questions')}\n"
            f"  Other: {raw.get('other_comments')}\n"
            f"  Rating: {raw.get('rating')}/10"
        )

    milestone_lines = [f"  {m['hit_at'][:10]}: {m['milestone_value']}-day {m['milestone_type']} streak" for m in milestones]

    return f"""You are an expert fitness + nutrition coach reviewing a client's data to generate the next-best coaching actions.

# CLIENT PROFILE
- **Name:** {client['full_name']}
- **Age:** {client.get('age', '—')}
- **Location:** {client.get('location', '—')}
- **Starting weight:** {client.get('starting_weight_lbs', '—')} lbs
- **Goal weight:** {client.get('goal_weight_lbs', '—')} lbs
- **Goal:** {client.get('goal', '—')}
- **Daily targets:** {client.get('daily_calorie_target')} cal / {client.get('daily_protein_target_g')}g protein / {client.get('weekly_target_workouts')} workouts per week
- **Coach:** {client.get('assigned_coach', '—')}
- **Program:** {client.get('program_term', '—')}
- **Start date:** {client.get('start_date')}

# CONTEXT FROM MONDAY.COM NOTES DOC
{client.get('context_summary', '(none)')}

# CURRENT STATUS
- **Latest flag:** {latest['flag_color'].upper() if latest else '—'}
- **Reasons:** {', '.join(latest.get('flag_reasons', [])) if latest else '—'}

# LAST 14 DAYS OF SNAPSHOTS (newest first)
{chr(10).join(snap_lines)}

# WEEKLY CHECK-INS (most recent first, last 2 months)
{chr(10).join(checkin_lines) if checkin_lines else '(none)'}

# STREAK MILESTONES HIT
{chr(10).join(milestone_lines) if milestone_lines else '(none yet)'}

---

# YOUR TASK

Generate 3–5 prioritized coaching recommendations. Focus on what's HIGHEST LEVERAGE for THIS specific client given everything above. Don't repeat generic fitness advice — use the specific patterns visible in the data.

SCANNABILITY IS CRITICAL. The coach needs to read each rec in 5 seconds. Use BULLETS, not paragraphs.

Each recommendation must include:
- **priority** (1 = most urgent, ascending)
- **title** (action-oriented, MAX 8 words, e.g. "Bump calories to 1500, drop protein target")
- **bullets** (array of 2–3 short bullets, each MAX 15 words, concrete + specific)
- **action_type** (one of: "send_message" | "schedule_call" | "adjust_program" | "send_resource" | "celebrate" | "monitor")
- **rationale** (ONE short sentence with the specific data point, MAX 20 words)

CRITICAL RULES:
1. The #1 recommendation must address the single most important pattern in the data — what's blocking results.
2. If the client has been complying but not getting results, the #1 rec is CHANGE THE PROGRAM, not push compliance harder.
3. Don't waste a slot on generic celebration if there's coaching to do.
4. Use SPECIFIC numbers from their data. "Send protein protocol" → bad. "Send 5 foods to go 84g → 110g" → good.
5. Consider emotional/life context (grief, no support, financial pressure) — coaching ≠ just protocol.
6. NO LONG SENTENCES. Bullets must be punchy. Fragment-style is fine.

Return ONLY a valid JSON array. No prose. No markdown fences.

Example shape:
[
  {{
    "priority": 1,
    "title": "Bump calories to 1500, rebalance protein",
    "bullets": [
      "Raise daily target from 1400 → 1500-1550 cal",
      "Drop protein target from 119g → 100g (more realistic)",
      "Frame as strategic adjustment, not setback"
    ],
    "action_type": "adjust_program",
    "rationale": "31 days perfect logging at 1436 cal avg, weight flat — prescription is wrong, not compliance."
  }}
]
"""


def call_claude(prompt: str) -> list[dict]:
    response = anthropic.messages.create(
        model="claude-opus-4-7",
        max_tokens=4000,
        messages=[{"role": "user", "content": prompt}],
    )
    text = response.content[0].text.strip()
    # Strip markdown fences if present
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    return json.loads(text)


def write_recommendations(client_id: str, recs: list[dict]):
    # Mark existing as not current
    supabase.table("recommendations").update({"is_current": False}).eq(
        "client_id", client_id
    ).execute()

    # Insert new
    payload = [
        {
            "client_id": client_id,
            "priority": r["priority"],
            "title": r["title"],
            "bullets": r.get("bullets") or [],
            "body": " · ".join(r.get("bullets") or []) if r.get("bullets") else r.get("body", ""),
            "action_type": r.get("action_type"),
            "rationale": r.get("rationale"),
            "is_current": True,
        }
        for r in recs
    ]
    supabase.table("recommendations").insert(payload).execute()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("trainerize_id")
    args = parser.parse_args()

    print(f"📋 Fetching client bundle for {args.trainerize_id}...")
    bundle = fetch_client_bundle(args.trainerize_id)
    client = bundle["client"]
    print(f"   ✓ {client['full_name']}")
    print(f"   ✓ {len(bundle['snapshots'])} snapshots")
    print(f"   ✓ {len(bundle['checkins'])} check-ins")
    print(f"   ✓ {len(bundle['milestones'])} milestones")

    print(f"\n🧠 Generating recommendations via Claude Opus 4.7...")
    prompt = build_context_prompt(bundle)
    recs = call_claude(prompt)
    print(f"   ✓ Got {len(recs)} recommendations\n")

    for r in sorted(recs, key=lambda x: x["priority"]):
        print(f"#{r['priority']}: {r['title']}")
        for b in r.get("bullets") or []:
            print(f"   • {b}")
        print(f"   [{r.get('action_type', '—')}] {r.get('rationale', '—')}")
        print()

    print("💾 Writing to Supabase...")
    write_recommendations(client["id"], recs)
    print("✅ Done")


if __name__ == "__main__":
    main()
