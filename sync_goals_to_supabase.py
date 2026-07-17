#!/usr/bin/env python3
"""
After extract_goal_weights.py writes goal_weight_lbs into monday-clients.json,
push the new values to Supabase public.clients.

Matches on monday_item_id (primary) then falls back to full_name.
Skips clients where Supabase already has goal_weight_lbs set (idempotent).
Dry-run by default; pass --apply to actually update.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

ENV_PATH = Path("/Users/zachef/Desktop/Playground - Claude/.env")
INPUT_PATH = Path(__file__).resolve().parent / "server" / "monday-clients.json"


def main() -> int:
    load_dotenv(dotenv_path=ENV_PATH)
    url = os.environ.get("SUPABASE_URL") or os.environ.get("CLIENT_OS_SUPABASE_URL")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("CLIENT_OS_SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_KEY")
    )
    if not url or not key:
        print("missing SUPABASE_URL or service-role key in env", file=sys.stderr)
        return 1

    apply = "--apply" in sys.argv
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }

    payload = json.load(open(INPUT_PATH))
    clients = payload.get("clients") or []
    candidates = [
        c for c in clients
        if not c.get("is_past")
        and c.get("goal_weight_lbs") is not None
        and c.get("goal_weight_confidence") != "low"
    ]
    print(f"Candidates to sync: {len(candidates)}")

    updated = 0
    skipped_already_set = 0
    skipped_not_found = 0
    for c in candidates:
        name = c.get("name")
        mid = c.get("monday_item_id")
        goal = c.get("goal_weight_lbs")
        start = c.get("starting_weight_lbs")

        # Find Supabase row — by monday_item_id first, then by full_name
        q = f"{url}/rest/v1/clients?select=id,full_name,goal_weight_lbs,starting_weight_lbs"
        if mid:
            r = requests.get(f"{q}&monday_item_id=eq.{mid}", headers=headers, timeout=15)
        else:
            r = requests.get(f"{q}&full_name=eq.{name}", headers=headers, timeout=15)
        if not r.ok:
            print(f"  [{name}] lookup failed: {r.status_code}")
            continue
        rows = r.json()
        if not rows:
            skipped_not_found += 1
            print(f"  [{name}] not found in Supabase (mid={mid})")
            continue
        row = rows[0]
        if row.get("goal_weight_lbs") is not None:
            skipped_already_set += 1
            continue

        patch = {"goal_weight_lbs": float(goal)}
        if row.get("starting_weight_lbs") is None and start is not None:
            patch["starting_weight_lbs"] = float(start)
        if mid and not row.get("monday_item_id"):
            patch["monday_item_id"] = str(mid)

        if not apply:
            print(f"  [DRY] {name}: would set {patch}")
            updated += 1
            continue

        upd = requests.patch(
            f"{url}/rest/v1/clients?id=eq.{row['id']}",
            headers=headers,
            data=json.dumps(patch),
            timeout=15,
        )
        if upd.ok:
            updated += 1
            print(f"  [OK ] {name}: {patch}")
        else:
            print(f"  [ERR] {name}: {upd.status_code} {upd.text[:200]}")

    print(f"\nSummary: updated={updated}, already_set={skipped_already_set}, not_found={skipped_not_found}")
    if not apply:
        print("Dry-run only. Re-run with --apply to write.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
