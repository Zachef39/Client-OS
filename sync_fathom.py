#!/usr/bin/env python3
"""
Faerber Client OS — Fathom → client_calls sync.

Backfill mode: takes a JSON list of meetings (dumped from MCP fathom.list_meetings)
and inserts into client_calls, matching client_id by parsing the meeting title.

For live sync, needs FATHOM_API_KEY in .env. Right now works from static input.

Usage:
  python sync_fathom.py --input meetings.json
  python sync_fathom.py --input meetings.json --dry-run
"""
import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

SUPABASE_URL = "https://sfuvqaoeuajsrvldoiek.supabase.co"
SUPABASE_KEY = os.environ.get(
    "FAERBER_CLIENT_OS_SUPABASE_KEY",
    "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U",
)
SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
}


def sb_get(path: str, params: dict = None) -> list:
    r = requests.get(f"{SUPABASE_URL}/rest/v1{path}", headers=SB_HEADERS, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_upsert_calls(rows: list[dict]) -> int:
    hdrs = dict(SB_HEADERS)
    hdrs["Prefer"] = "resolution=merge-duplicates,return=minimal"
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/client_calls?on_conflict=fathom_recording_id",
        headers=hdrs,
        json=rows,
        timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"Upsert failed: {r.status_code} {r.text[:200]}")
    return len(rows)


def infer_call_type(title: str) -> str:
    t = title.lower()
    if "onboard" in t:
        return "onboarding"
    if "bloodwork" in t:
        return "bloodwork_review"
    if "check" in t or "checkin" in t:
        return "checkin"
    if "blueprint" in t or "free blueprint" in t or "discovery" in t:
        return "discovery"
    if "sales" in t or "consult" in t:
        return "sales"
    if "strategy" in t:
        return "strategy"
    if "impromptu" in t or "zoom meeting" in t:
        return "ad_hoc"
    return "other"


NAME_STRIP_PATTERNS = [
    r"^\s*",
    r"\s*'s Onboarding Call.*$",
    r"\s*'s Free Blueprint Call.*$",
    r"\s*'s Blueprint Call.*$",
    r"\s*'s Bloodwork Review.*$",
    r"\s*'s Client Checkin.*$",
    r"\s*'s Onboarding.*$",
    r"\s*'s Discovery Call.*$",
    r"\s*'s Call.*$",
    r"\s*- Bloodwork Review.*$",
    r"\s*- Client Checkin.*$",
    r"\s*: Client Checkin.*$",
    r"\s*: Call.*$",
    r"\s*<.*$",
    r"\s*-\s*$",
]


def extract_name_from_title(title: str) -> str | None:
    """Try to pull client name from various title formats."""
    if not title:
        return None
    # Skip generic titles
    lower = title.lower()
    if any(x in lower for x in ["impromptu", "zoom meeting", "team", "bi-weekly"]):
        return None
    name = title
    for pat in NAME_STRIP_PATTERNS:
        name = re.sub(pat, "", name)
    name = name.strip(" -:.,")
    return name if len(name) >= 3 and " " in name else None


def find_client_id(name: str) -> str | None:
    if not name:
        return None
    rows = sb_get("/clients", {"select": "id,full_name", "full_name": f"ilike.{name}", "limit": "1"})
    if rows:
        return rows[0]["id"]
    # Fuzzy last name
    if " " in name:
        last = name.strip().split()[-1]
        if len(last) >= 3:
            rows = sb_get("/clients", {"select": "id,full_name", "full_name": f"ilike.%{last}%", "limit": "2"})
            if len(rows) == 1:
                return rows[0]["id"]
    return None


def process_meetings(meetings: list[dict], dry_run: bool = False):
    stats = {"total": 0, "matched": 0, "written": 0, "orphan": []}
    rows = []
    for m in meetings:
        stats["total"] += 1
        title = m.get("title", "")
        recording_id = str(m.get("recording_id") or m.get("id"))
        url = m.get("url")
        date = m.get("date")  # ISO YYYY-MM-DD
        call_type = infer_call_type(title)
        client_name = extract_name_from_title(title)
        client_id = find_client_id(client_name) if client_name else None
        if client_id:
            stats["matched"] += 1
        else:
            stats["orphan"].append(title)

        row = {
            "client_id": client_id,
            "call_type": call_type,
            "call_date": date + "T00:00:00Z" if date and "T" not in date else date,
            "fathom_recording_id": recording_id,
            "fathom_url": url,
        }
        rows.append(row)
        marker = "✓" if client_id else "—"
        print(f"  {marker} [{call_type[:10]:10s}] {(client_name or '?')[:30]:30s}  {title[:60]}", flush=True)

    if not dry_run and rows:
        stats["written"] = sb_upsert_calls(rows)
    print("\n─── summary ───")
    print(f"  total meetings: {stats['total']}")
    print(f"  matched to client: {stats['matched']}")
    print(f"  written: {stats['written']}")
    if stats["orphan"]:
        print(f"  orphans ({len(stats['orphan'])}): {', '.join(stats['orphan'][:3])}{'...' if len(stats['orphan'])>3 else ''}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="Path to JSON of meetings")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    meetings = json.load(open(args.input))
    process_meetings(meetings, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
