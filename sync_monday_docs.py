#!/usr/bin/env python3
"""
Pull Monday.com Notes Docs → Supabase clients.monday_doc_markdown.

Reads server/monday-clients.json (from sync_monday_clients.py) to get
monday_item_id → trainerize_user_id → matches Supabase client.
Fetches full doc markdown from Monday API, updates clients table.

Usage:
  .venv/bin/python sync_monday_docs.py
  .venv/bin/python sync_monday_docs.py --limit 5
  .venv/bin/python sync_monday_docs.py --dry-run
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

MONDAY_TOKEN = os.environ["MONDAY_API_TOKEN"]
MONDAY_URL = "https://api.monday.com/v2"

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

JSON_PATH = Path(__file__).parent / "server" / "monday-clients.json"


# ─── Monday helpers ───
def monday_query(query: str, variables: dict = None) -> dict:
    r = requests.post(
        MONDAY_URL,
        headers={"Authorization": MONDAY_TOKEN, "Content-Type": "application/json"},
        json={"query": query, "variables": variables or {}},
        timeout=30,
    )
    r.raise_for_status()
    data = r.json()
    if "errors" in data:
        raise RuntimeError(f"Monday error: {data['errors']}")
    return data["data"]


def fetch_doc_markdown(object_id: str) -> str:
    """Fetch full doc markdown by object_id."""
    query = """
    query ($id: ID!) {
      docs(object_ids: [$id]) {
        blocks { content type }
      }
    }
    """
    data = monday_query(query, {"id": object_id})
    docs = data.get("docs") or []
    if not docs:
        return ""
    blocks = docs[0].get("blocks") or []
    parts = []
    for b in blocks:
        content = b.get("content")
        if not content:
            continue
        try:
            content_obj = json.loads(content) if isinstance(content, str) else content
        except Exception:
            content_obj = None
        # Extract text
        if isinstance(content_obj, dict):
            text = content_obj.get("plain_text") or content_obj.get("text") or ""
            parts.append(str(text))
        elif isinstance(content, str):
            parts.append(content)
    return "\n\n".join(p for p in parts if p.strip())


# ─── Supabase helpers ───
def sb_get(path: str, params: dict = None) -> list:
    r = requests.get(f"{SUPABASE_URL}/rest/v1{path}", headers=SB_HEADERS, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_patch(path: str, data: dict, params: dict) -> None:
    r = requests.patch(f"{SUPABASE_URL}/rest/v1{path}", headers=SB_HEADERS, json=data, params=params, timeout=15)
    if not r.ok:
        raise RuntimeError(f"Supabase PATCH failed: {r.status_code} {r.text[:200]}")


def find_client_id(name: str, trainerize_user_id: str) -> str | None:
    """Match by trainerize_user_id → name fallback."""
    if trainerize_user_id:
        rows = sb_get("/clients", {"select": "id", "trainerize_user_id": f"eq.{trainerize_user_id}", "limit": "1"})
        if rows:
            return rows[0]["id"]
    if name:
        rows = sb_get("/clients", {"select": "id,full_name", "full_name": f"ilike.{name}", "limit": "1"})
        if rows:
            return rows[0]["id"]
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, help="Only process first N")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    print(f"Loading {JSON_PATH}", flush=True)
    if not JSON_PATH.exists():
        print("⚠ monday-clients.json missing. Run sync_monday_clients.py first.", flush=True)
        return

    d = json.load(open(JSON_PATH))
    clients = d.get("clients", [])
    with_docs = [c for c in clients if c.get("doc_object_id")]
    print(f"  {len(clients)} clients, {len(with_docs)} have doc_object_id", flush=True)

    if args.limit:
        with_docs = with_docs[: args.limit]

    stats = {"processed": 0, "matched": 0, "docs_fetched": 0, "written": 0, "errors": 0, "unmatched": []}

    for i, c in enumerate(with_docs, 1):
        name = c.get("name") or "?"
        try:
            tz_id = str(c.get("trainerize_user_id")) if c.get("trainerize_user_id") else None
            client_id = find_client_id(name, tz_id)
            if not client_id:
                stats["unmatched"].append(name)
                if i <= 20 or i % 25 == 0:
                    print(f"  [{i}/{len(with_docs)}] {name[:35]:35s} ✗ no match in Supabase", flush=True)
                continue
            stats["matched"] += 1
            markdown = fetch_doc_markdown(c["doc_object_id"])
            if not markdown or len(markdown) < 20:
                if i <= 20 or i % 25 == 0:
                    print(f"  [{i}/{len(with_docs)}] {name[:35]:35s} ⚠ empty doc", flush=True)
                continue
            stats["docs_fetched"] += 1

            if args.dry_run:
                print(f"  [dry] {name[:35]:35s} → {len(markdown)} chars", flush=True)
                continue

            sb_patch(
                "/clients",
                {"monday_doc_markdown": markdown, "monday_doc_id": c["doc_object_id"], "monday_item_id": str(c["monday_item_id"])},
                {"id": f"eq.{client_id}"},
            )
            stats["written"] += 1
            if i <= 20 or i % 25 == 0:
                print(f"  [{i}/{len(with_docs)}] {name[:35]:35s} ✓ {len(markdown)} chars", flush=True)
        except Exception as e:
            stats["errors"] += 1
            print(f"  [{i}/{len(with_docs)}] {name[:35]:35s} ✗ {str(e)[:80]}", flush=True)

    print("\n─── summary ───")
    print(f"  processed:    {i}")
    print(f"  matched:      {stats['matched']}")
    print(f"  docs fetched: {stats['docs_fetched']}")
    print(f"  written:      {stats['written']}")
    print(f"  errors:       {stats['errors']}")
    print(f"  unmatched:    {len(stats['unmatched'])}")
    if stats["unmatched"]:
        print(f"  unmatched names: {', '.join(stats['unmatched'][:10])}{'...' if len(stats['unmatched'])>10 else ''}")


if __name__ == "__main__":
    main()
