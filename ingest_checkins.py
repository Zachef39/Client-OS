#!/usr/bin/env python3
"""
Faerber Client OS — FitMetrics check-in ingester

Reads checkin-answers-*.json files from faerber-checkin/clients/
and upserts each unique submission into Supabase `weekly_checkins`.

Usage:
  python3 ingest_checkins.py "Adora Koot"
  python3 ingest_checkins.py --all
"""

import argparse
import glob
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

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
supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

CHECKINS_DIR = PROJECT_ROOT / "faerber-checkin" / "clients"


# ---------- Parsing helpers ----------
def parse_submitted_date(s: str) -> Optional[str]:
    """'Submitted on 05/10/2026, 07:40 PM' → '2026-05-10'."""
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", s or "")
    if not m:
        return None
    mm, dd, yyyy = m.groups()
    return f"{yyyy}-{mm}-{dd}"


def find_answer(answers: dict, *needles: str) -> Optional[str]:
    """Loose-match a question by any substring."""
    for q, a in answers.items():
        q_lower = q.lower()
        if all(n.lower() in q_lower for n in needles):
            return a
    return None


def parse_slider(s: str) -> Optional[int]:
    """'Slider: 6' → 6."""
    if not s:
        return None
    m = re.search(r"\d+", str(s))
    return int(m.group()) if m else None


def parse_weight_change(s: str) -> Optional[float]:
    """'+0.6' / '-1.2' / 'Maintained the weight' → float or None."""
    if not s:
        return None
    m = re.search(r"[-+]?\d+\.?\d*", str(s))
    return float(m.group()) if m else None


def parse_rating(s: str) -> Optional[int]:
    """'Rating: 9' or 'Rating: 10/10 - Amazing' → 9."""
    if not s:
        return None
    m = re.search(r"(\d+)", str(s))
    return int(m.group(1)) if m else None


def normalize_submission(submission: dict) -> dict:
    """Convert a raw FitMetrics submission into weekly_checkins row data."""
    answers = submission.get("answers", {})
    checkin_date = parse_submitted_date(submission.get("submitted", ""))

    adherence = parse_slider(find_answer(answers, "adherence", "diet"))
    stress = parse_slider(find_answer(answers, "stress"))
    physical = parse_slider(find_answer(answers, "feel", "physically"))
    rating = parse_rating(find_answer(answers, "rate", "program"))

    return {
        "checkin_date": checkin_date,
        "weight_lbs": None,  # FitMetrics asks "change", not absolute
        "stress_1to10": stress,
        "energy_1to10": physical,  # closest match
        "hunger_1to10": None,
        "wins": find_answer(answers, "biggest win"),
        "struggles": find_answer(answers, "struggled"),
        "questions": find_answer(answers, "support you"),
        "feedback": find_answer(answers, "improvement"),
        "raw_form_data": {
            "submitted_raw": submission.get("submitted"),
            "personal_goal": find_answer(answers, "personal goal"),
            "weight_change": find_answer(answers, "weight change"),
            "weight_change_parsed": parse_weight_change(find_answer(answers, "weight change")),
            "photos_uploaded": find_answer(answers, "uploaded", "check-in"),
            "things_did_well": find_answer(answers, "did well"),
            "committing_workout_days": find_answer(answers, "committing", "working out"),
            "other_comments": find_answer(answers, "other comments"),
            "rating": rating,
            "referrals": find_answer(answers, "people", "struggling"),
            "all_answers": answers,
        },
    }


# ---------- Main ----------
def ingest_for_name(name: str):
    files = sorted(glob.glob(str(CHECKINS_DIR / "checkin-answers-*.json")))
    print(f"📁 Scanning {len(files)} check-in files for '{name}'...")

    target_lower = name.lower()
    seen_submissions = {}  # submitted_raw → submission (dedupe)

    for f in files:
        with open(f) as fh:
            try:
                data = json.load(fh)
            except json.JSONDecodeError:
                continue
        if not isinstance(data, list):
            continue
        for sub in data:
            client_name = sub.get("name", "").lower()
            if target_lower not in client_name:
                continue
            key = sub.get("submitted", "")
            if key and key not in seen_submissions:
                seen_submissions[key] = sub

    if not seen_submissions:
        print(f"❌ No submissions found for '{name}'")
        return

    print(f"✅ Found {len(seen_submissions)} unique check-ins\n")

    # Look up client in Supabase
    res = (
        supabase.table("clients")
        .select("*")
        .ilike("full_name", f"%{name}%")
        .limit(1)
        .execute()
    )
    if not res.data:
        print(f"❌ Client '{name}' not in Supabase clients table")
        return
    client = res.data[0]

    # Upsert each
    written = 0
    for raw in seen_submissions.values():
        row = normalize_submission(raw)
        if not row["checkin_date"]:
            print(f"  ⚠ skip — no parsable date: {raw.get('submitted')}")
            continue
        payload = {**row, "client_id": client["id"]}
        try:
            supabase.table("weekly_checkins").upsert(
                payload, on_conflict="client_id,checkin_date"
            ).execute()
            written += 1
            print(f"  ✅ {row['checkin_date']} — stress {row['stress_1to10']}, energy {row['energy_1to10']}")
        except Exception as e:
            print(f"  ❌ {row['checkin_date']} failed: {e}")

    print(f"\n💾 {written} check-ins written for {client['full_name']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("name", help="Client name (partial match OK)")
    args = parser.parse_args()
    ingest_for_name(args.name)
