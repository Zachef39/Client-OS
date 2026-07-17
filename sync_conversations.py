#!/usr/bin/env python3
"""
Faerber Client OS — Trainerize conversation sync → client_conversations.

Pulls message threads for all active clients, upserts recent messages.
Runs daily. Idempotent via UNIQUE(source, external_message_id).

Usage:
  python sync_conversations.py                # sync last 30 days
  python sync_conversations.py --days 7       # last week only
  python sync_conversations.py --limit 3      # first N clients (testing)
  python sync_conversations.py --dry-run      # print without writing
"""

import argparse
import base64
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

TZ_GROUP = os.environ["TRAINERIZE_GROUP_ID"]
TZ_TOKEN = os.environ["TRAINERIZE_API_TOKEN"]
TZ_BASE = "https://api.trainerize.com/v03"
TZ_AUTH = base64.b64encode(f"{TZ_GROUP}:{TZ_TOKEN}".encode()).decode()
TZ_HEADERS = {"Authorization": f"Basic {TZ_AUTH}", "Content-Type": "application/json"}
ZACH_TZ_ID = 3525989  # Zach's Trainerize coach user ID (from pull-threads.js)

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


def tz_post(path: str, body: dict) -> dict:
    r = requests.post(f"{TZ_BASE}{path}", headers=TZ_HEADERS, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def sb_get(path: str, params: dict = None) -> list:
    r = requests.get(f"{SUPABASE_URL}/rest/v1{path}", headers=SB_HEADERS, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_upsert_conversations(rows: list[dict]) -> int:
    """Bulk upsert conversations. Returns count written."""
    if not rows:
        return 0
    hdrs = dict(SB_HEADERS)
    hdrs["Prefer"] = "resolution=merge-duplicates,return=minimal"
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/client_conversations?on_conflict=source,external_message_id",
        headers=hdrs,
        json=rows,
        timeout=30,
    )
    if not r.ok:
        raise RuntimeError(f"Upsert failed: {r.status_code} {r.text[:200]}")
    return len(rows)


def get_active_clients() -> list[dict]:
    """Real active clients only — skip internal + duplicates."""
    rows = sb_get(
        "/clients",
        {
            "select": "id,trainerize_user_id,full_name",
            "is_active": "eq.true",
            "is_internal": "eq.false",
            "potential_duplicate_of": "is.null",
            "limit": "200",
        },
    )
    return [r for r in rows if r.get("trainerize_user_id")]


def pull_all_threads() -> list[dict]:
    """Pull all inbox threads for Zach."""
    data = tz_post("/message/getThreads", {"view": "inbox", "userID": ZACH_TZ_ID, "start": 0, "count": 500})
    return data.get("threads", [])


def pull_thread_messages(thread_id: int, count: int = 50, max_msgs: int = 5000) -> list[dict]:
    """Pull messages for a thread. Paginate via start offset."""
    all_msgs = []
    start = 0
    while True:
        data = tz_post("/message/getMessages", {"threadID": thread_id, "start": start, "count": count})
        batch = data.get("messages", [])
        if not batch:
            break
        all_msgs.extend(batch)
        if len(batch) < count or len(all_msgs) >= max_msgs:
            break
        start += count
    return list(reversed(all_msgs))  # oldest first


def match_thread_to_client(thread: dict, clients_by_tz_id: dict[str, dict]) -> dict | None:
    """Match thread to Supabase client via ccUsers[].userID."""
    for user in thread.get("ccUsers", []):
        tz_id = str(user.get("userID"))
        if tz_id and tz_id != str(ZACH_TZ_ID) and tz_id in clients_by_tz_id:
            return clients_by_tz_id[tz_id]
    return None


def build_conversation_row(msg: dict, client_id: str, thread_id: int) -> dict:
    """Transform Trainerize message → client_conversations row."""
    sender = msg.get("sender") or {}
    sender_id = str(sender.get("userID") or "")
    direction = "outbound" if sender_id == str(ZACH_TZ_ID) else "inbound"
    sent_at = msg.get("sentTime")
    if sent_at and "T" not in sent_at:
        sent_at = sent_at.replace(" ", "T") + "Z"
    sender_name = " ".join(
        p for p in [sender.get("firstName"), sender.get("lastName")] if p
    ).strip() or None
    return {
        "client_id": client_id,
        "source": "trainerize",
        "external_thread_id": str(thread_id),
        "external_message_id": f"tz-{msg.get('messageID')}",
        "direction": direction,
        "sender": sender_name,
        "body": msg.get("body") or "",
        "sent_at": sent_at,
        "raw_payload": msg,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="Days back to sync (default 30, use 0 for ALL)")
    ap.add_argument("--limit", type=int, help="Only first N clients")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if args.days > 0:
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.days)
        print(f"Syncing messages since {cutoff.date()}", flush=True)
    else:
        cutoff = datetime(2020, 1, 1, tzinfo=timezone.utc)
        print(f"Syncing ALL messages (no cutoff)", flush=True)

    clients = get_active_clients()
    print(f"  {len(clients)} active clients from Supabase", flush=True)
    clients_by_tz_id = {c["trainerize_user_id"]: c for c in clients}

    threads = pull_all_threads()
    print(f"  {len(threads)} threads in Trainerize inbox", flush=True)

    matched = [(t, c) for t in threads for c in [match_thread_to_client(t, clients_by_tz_id)] if c]
    print(f"  {len(matched)} threads matched to active clients", flush=True)

    if args.limit:
        matched = matched[: args.limit]

    stats = {"threads": 0, "msgs_pulled": 0, "msgs_written": 0, "errors": 0}
    batch = []

    for i, (thread, client) in enumerate(matched, 1):
        try:
            msgs = pull_thread_messages(thread["threadID"], count=100)
            recent = []
            for m in msgs:
                sent_str = m.get("sentTime") or ""
                try:
                    sent_dt = datetime.fromisoformat(sent_str.replace(" ", "T").rstrip("Z"))
                    if sent_dt.tzinfo is None:
                        sent_dt = sent_dt.replace(tzinfo=timezone.utc)
                    if sent_dt < cutoff:
                        continue
                except Exception:
                    pass
                recent.append(m)
            stats["msgs_pulled"] += len(recent)
            rows = [build_conversation_row(m, client["id"], thread["threadID"]) for m in recent]
            batch.extend([r for r in rows if r["sent_at"] and r["external_message_id"] != "tz-None"])

            if args.dry_run:
                print(f"  [{i}/{len(matched)}] {client['full_name'][:30]:30s} {len(recent)} msgs (dry)", flush=True)
            else:
                if len(batch) >= 50:
                    stats["msgs_written"] += sb_upsert_conversations(batch)
                    batch = []
                if i % 10 == 0:
                    print(f"  [{i}/{len(matched)}] processed, running total msgs: {stats['msgs_written']}", flush=True)
            stats["threads"] += 1
            time.sleep(0.05)
        except Exception as e:
            stats["errors"] += 1
            print(f"  ✗ {client.get('full_name','?')}: {str(e)[:100]}", flush=True)

    if batch and not args.dry_run:
        stats["msgs_written"] += sb_upsert_conversations(batch)

    print("\n─── summary ───")
    print(f"  threads processed:  {stats['threads']}")
    print(f"  msgs pulled:        {stats['msgs_pulled']}")
    print(f"  msgs written:       {stats['msgs_written']}")
    print(f"  errors:             {stats['errors']}")


if __name__ == "__main__":
    main()
