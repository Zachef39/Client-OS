#!/usr/bin/env python3
"""
Scan bloodwork PDFs, match to clients, insert into client_bloodwork.
Stores file path + mtime as drawn_date (fallback).
"""
import os, re, requests
from pathlib import Path
from datetime import datetime, timezone
from dotenv import load_dotenv

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

SB_URL = "https://sfuvqaoeuajsrvldoiek.supabase.co"
SB_KEY = os.environ.get("FAERBER_CLIENT_OS_SUPABASE_KEY", "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U")
H = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"}

SEARCH_DIRS = [
    Path.home() / "Downloads",
    Path("/Users/zachef/Desktop/Work /Fitness Business/FF/Programs/Bloodwork "),
    Path("/Users/zachef/Desktop/Work /Fitness Business/FF/Programs"),
]

STOPWORDS = {"bloodwork", "blood", "labs", "lab", "review", "dutch", "results", "final", "phase1", "phase-1", "phase2", "bloods"}


def sb_get(path, params=None):
    r = requests.get(f"{SB_URL}/rest/v1{path}", headers=H, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_post(path, data):
    r = requests.post(f"{SB_URL}/rest/v1{path}", headers=H, json=data, timeout=15)
    if not r.ok:
        raise RuntimeError(f"POST {r.status_code} {r.text[:200]}")


def infer_name_from_filename(fname: str) -> str:
    """Extract client name from filename like 'jenny-kats-bloodwork-review.pdf'."""
    name = fname.rsplit(".", 1)[0]  # strip ext
    name = re.sub(r"[-_]", " ", name)
    name = re.sub(r"\(\d+\)", "", name)  # strip (1)
    # remove stopwords
    parts = [w for w in name.lower().split() if w not in STOPWORDS and not w.isdigit()]
    if not parts:
        return ""
    return " ".join(parts).title().strip()


# Load clients once
clients = sb_get("/clients", {"select": "id,full_name", "limit": "300"})


def match_client(name: str):
    if not name or len(name) < 3:
        return None
    n_low = name.lower()
    # Exact match
    for c in clients:
        if c["full_name"].lower() == n_low:
            return c["id"]
    # Last name match
    if " " in name:
        last = name.split()[-1].lower()
        matches = [c for c in clients if last in c["full_name"].lower().split()]
        if len(matches) == 1:
            return matches[0]["id"]
    # First name match
    first = name.split()[0].lower()
    matches = [c for c in clients if first in c["full_name"].lower().split()]
    if len(matches) == 1:
        return matches[0]["id"]
    return None


# Scan for PDFs
found = []
for d in SEARCH_DIRS:
    if not d.exists():
        continue
    for pdf in d.glob("**/*.pdf"):
        low = pdf.name.lower()
        if "blood" not in low and "lab" not in low and "dutch" not in low:
            continue
        mtime = datetime.fromtimestamp(pdf.stat().st_mtime, tz=timezone.utc).date().isoformat()
        found.append((pdf, mtime))

print(f"Found {len(found)} bloodwork PDFs")

inserted = 0
skipped = 0
orphans = []
for pdf, mtime in found:
    guess = infer_name_from_filename(pdf.name)
    cid = match_client(guess)
    if not cid:
        skipped += 1
        orphans.append(pdf.name)
        continue
    payload = {
        "client_id": cid,
        "drawn_date": mtime,
        "pdf_url": f"file://{pdf}",
        "panel_type": "unknown",
        "lab_name": "unknown",
    }
    try:
        sb_post("/client_bloodwork", payload)
        inserted += 1
        print(f"  ✓ {guess[:30]:30s}  {pdf.name[:60]}", flush=True)
    except Exception as e:
        print(f"  ✗ {guess[:30]:30s}  {e}", flush=True)

print(f"\ninserted: {inserted}")
print(f"skipped (no match): {skipped}")
if orphans:
    print(f"orphans: {', '.join(orphans[:10])}")
