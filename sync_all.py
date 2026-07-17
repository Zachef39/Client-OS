#!/usr/bin/env python3
"""
Faerber Client OS — full sync for ALL active Trainerize clients.

Run from terminal:
  .venv/bin/python sync_all.py
  .venv/bin/python sync_all.py --skip-recs       # faster, just data
  .venv/bin/python sync_all.py --days 30
  .venv/bin/python sync_all.py --client "Adora"  # single client by name

Order of operations per client:
  1. Upsert clients row (seed if new, pull targets from Trainerize)
  2. Pull 30d snapshots + write daily_snapshots
  3. Detect new streak milestones
  4. Write any current yellow/red coach_alerts
  5. Ingest FitMetrics check-ins from local JSON files
  6. Generate Claude recommendations (Sonnet 4.6 for speed)

After all clients sync, write a row to sync_state for the dashboard timestamp.
"""

import argparse
import subprocess
import sys
import threading
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from lib import (
    supabase_client,
    list_active_clients,
    upsert_client,
    sync_trainerize_data,
    ingest_all_checkins_for_client,
    generate_recs_for_client,
)


def run_monday_clients_sync():
    """Pull every Coach Board client + parse weight info from Notes Docs.

    Runs BEFORE the per-client Trainerize pipeline so downstream steps
    (recs, dashboard) can read off server/monday-clients.json.
    """
    script = Path(__file__).resolve().parent / "sync_monday_clients.py"
    if not script.exists():
        print(f"⚠ sync_monday_clients.py not found at {script} — skipping")
        return
    print("📋 Syncing Monday Coach Board → server/monday-clients.json")
    try:
        result = subprocess.run(
            [sys.executable, str(script)],
            cwd=script.parent,
            check=False,
            capture_output=True,
            text=True,
            timeout=600,
        )
        if result.stdout:
            for line in result.stdout.rstrip().splitlines():
                print(f"   {line}")
        if result.returncode != 0:
            print(f"⚠ Monday sync exited with code {result.returncode}")
            if result.stderr:
                print(f"   stderr: {result.stderr[:500]}")
    except Exception as e:
        print(f"⚠ Monday sync failed: {e}")
    print()


def sync_one(tz_user, args, idx, total):
    """Run the full per-client pipeline. Returns dict for summary aggregation."""
    name = tz_user.get("name") or "?"
    supabase = supabase_client()  # one client per worker thread — supabase-py is not thread-safe
    t0 = time.time()
    try:
        before = (
            supabase.table("clients").select("id")
            .eq("trainerize_user_id", str(tz_user["id"])).limit(1).execute()
        )
        is_new = not bool(before.data)
        client_row = upsert_client(supabase, tz_user)

        n_checkins = ingest_all_checkins_for_client(supabase, client_row)
        tz_result = sync_trainerize_data(supabase, client_row, days=args.days)

        n_recs = 0
        if not args.skip_recs:
            n_recs = generate_recs_for_client(supabase, client_row)

        return {
            "ok": True, "name": name, "is_new": is_new,
            "n_checkins": n_checkins, "n_recs": n_recs,
            "flag": tz_result["latest_flag"], "snapshots": tz_result["snapshots"],
            "elapsed": time.time() - t0, "idx": idx, "total": total,
        }
    except Exception as e:
        return {
            "ok": False, "name": name, "error": str(e),
            "elapsed": time.time() - t0, "idx": idx, "total": total,
        }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--skip-recs", action="store_true")
    ap.add_argument("--client", help="Single client name (partial match)")
    ap.add_argument("--limit", type=int, default=None, help="Cap on number of clients to sync")
    ap.add_argument("--workers", type=int, default=8, help="Parallel sync workers (default 8)")
    args = ap.parse_args()

    started = datetime.now()
    print(f"⏱  Sync started at {started.isoformat()}")

    # Step 0: Monday Coach Board → server/monday-clients.json
    # Runs first so the dashboard + downstream recs see fresh client data.
    run_monday_clients_sync()

    print(f"📋 Listing active Trainerize clients...")
    all_clients = list_active_clients()
    print(f"   {len(all_clients)} active clients found")

    if args.client:
        all_clients = [c for c in all_clients if args.client.lower() in (c.get("name") or "").lower()]
        print(f"   Filtered to {len(all_clients)} matching '{args.client}'")
    if args.limit:
        all_clients = all_clients[: args.limit]

    total = len(all_clients)
    workers = max(1, min(args.workers, total))
    print(f"   Running with {workers} parallel worker(s)")
    print()

    summary = {"synced": 0, "failed": 0, "new": 0, "recs_generated": 0, "checkins": 0}
    failures = []
    print_lock = threading.Lock()
    completed = [0]

    EMOJI = {"green": "🟢", "yellow": "🟡", "red": "🔴", "onboarding": "🔵", "no_data": "⚪"}

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(sync_one, c, args, i, total) for i, c in enumerate(all_clients, 1)]
        for fut in as_completed(futures):
            r = fut.result()
            with print_lock:
                completed[0] += 1
                done = completed[0]
                if r["ok"]:
                    summary["synced"] += 1
                    if r["is_new"]:
                        summary["new"] += 1
                    summary["checkins"] += r["n_checkins"]
                    summary["recs_generated"] += r["n_recs"]
                    emoji = EMOJI.get(r["flag"], "❔")
                    tag = " [NEW]" if r["is_new"] else ""
                    print(
                        f"  [{done:2d}/{total}] {emoji} {r['name']:30s}{tag}  "
                        f"snaps {r['snapshots']}  checkins {r['n_checkins']}  recs {r['n_recs']}  ({r['elapsed']:.1f}s)"
                    )
                else:
                    summary["failed"] += 1
                    failures.append((r["name"], r["error"]))
                    print(f"  [{done:2d}/{total}] ❌ {r['name']:30s}  {r['error']}")

    supabase = supabase_client()

    ended = datetime.now()
    duration = (ended - started).total_seconds()

    # Write sync state
    try:
        supabase.table("sync_state").upsert({
            "id": 1,
            "last_synced_at": ended.isoformat(),
            "duration_seconds": int(duration),
            "clients_synced": summary["synced"],
            "clients_failed": summary["failed"],
        }).execute()
    except Exception as e:
        # Table may not exist yet; will be created by migration
        print(f"\n⚠ sync_state write failed (probably no table yet): {e}")

    print()
    print(f"⏱  Done in {duration:.1f}s")
    print(f"   ✅ {summary['synced']} synced  ({summary['new']} new)")
    print(f"   📝 {summary['checkins']} check-ins")
    print(f"   🧠 {summary['recs_generated']} recommendations")
    if summary["failed"]:
        print(f"   ❌ {summary['failed']} failed:")
        for n, e in failures:
            print(f"      - {n}: {e[:80]}")


if __name__ == "__main__":
    main()
