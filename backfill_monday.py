#!/usr/bin/env python3
"""Backfill Monday Coach Board notes + updates into client_notes."""
import json, os, requests, re
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

SB_URL = "https://sfuvqaoeuajsrvldoiek.supabase.co"
SB_KEY = os.environ.get("FAERBER_CLIENT_OS_SUPABASE_KEY", "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U")
H = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"}


def sb_get(path, params=None):
    r = requests.get(f"{SB_URL}/rest/v1{path}", headers=H, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_post(path, data):
    r = requests.post(f"{SB_URL}/rest/v1{path}", headers=H, json=data, timeout=30)
    if not r.ok:
        raise RuntimeError(f"POST {r.status_code} {r.text[:200]}")


def normalize_name(n):
    n = re.sub(r"[^a-z0-9 ]", "", (n or "").lower())
    return " ".join(n.split())


def find_client(name):
    clean = normalize_name(name)
    rows = sb_get("/clients", {"select": "id,full_name", "limit": "300"})
    by_name = {normalize_name(r["full_name"]): r["id"] for r in rows}
    if clean in by_name:
        return by_name[clean]
    # Try last name
    if " " in clean:
        last = clean.split()[-1]
        matches = [c for c in by_name if last in c.split()]
        if len(matches) == 1:
            return by_name[matches[0]]
    return None


items = json.load(open("/tmp/monday_full.json"))
print(f"Processing {len(items)} Monday Coach Board items...")

notes_batch = []
rules_batch = []
matched = 0
unmatched = 0

for it in items:
    name = it["name"]
    cid = find_client(name)
    if not cid:
        unmatched += 1
        continue
    matched += 1

    # 1. Notes text column → observation
    notes_col = it["column_values"][0]
    notes_text = notes_col.get("text", "").strip()
    if notes_text and len(notes_text) > 5:
        notes_batch.append({
            "client_id": cid,
            "note_type": "observation",
            "body": notes_text,
            "tags": ["monday_notes_column", "coach_board"],
            "created_by": "monday_backfill",
            "created_at": None,
        })

    # 2. Updates (comments) → observations
    for u in it.get("updates") or []:
        body = u.get("text_body") or u.get("body") or ""
        body = re.sub(r"<[^>]+>", "", body).strip()
        if len(body) < 10:
            continue
        note_type = "plan" if "Programming" in body or "Adjusted" in body else "observation"
        notes_batch.append({
            "client_id": cid,
            "note_type": note_type,
            "body": body[:5000],
            "tags": ["monday_update"],
            "created_by": "monday_backfill",
            "created_at": u.get("created_at"),
        })

print(f"matched: {matched}, unmatched: {unmatched}")
print(f"notes to insert: {len(notes_batch)}")

if notes_batch:
    # Insert in chunks of 100
    written = 0
    for i in range(0, len(notes_batch), 100):
        chunk = notes_batch[i:i+100]
        sb_post("/client_notes", chunk)
        written += len(chunk)
        print(f"  ...{written}/{len(notes_batch)}")

print(f"✓ Inserted {len(notes_batch)} notes")
