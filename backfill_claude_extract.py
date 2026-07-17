#!/usr/bin/env python3
"""
Use Claude Haiku to extract structured medical/lifestyle data from checkins.

Per active client:
  1. Aggregate all their weekly_checkins (raw_form_data, wins, struggles, feedback, questions)
  2. Send to Claude → JSON of rules, symptoms, meds, cycle status, program details
  3. Insert into: client_rules, client_symptoms, client_medications, client_cycle_tracking, client_tags
"""
import argparse, json, os, sys, re
from datetime import datetime, timezone
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

SB_URL = "https://sfuvqaoeuajsrvldoiek.supabase.co"
SB_KEY = os.environ.get("FAERBER_CLIENT_OS_SUPABASE_KEY", "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U")
SB = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"}

ANTHROPIC_KEY = os.environ["ANTHROPIC_API_KEY"]
MODEL = "claude-haiku-4-5-20251001"


def sb_get(path, params=None):
    r = requests.get(f"{SB_URL}/rest/v1{path}", headers=SB, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_post(path, data):
    r = requests.post(f"{SB_URL}/rest/v1{path}", headers=SB, json=data, timeout=30)
    if not r.ok:
        raise RuntimeError(f"POST {r.status_code} {r.text[:200]}")


def claude_extract(client_name: str, corpus: str) -> dict:
    system = """Extract structured client info from fitness coaching check-ins.

Return ONLY valid JSON with these keys (all optional, omit if unknown):
{
  "rules": [{"category": "injury|allergy|dietary_restriction|medication_interaction|equipment_limit|schedule_constraint|mental_health|preference|red_flag|other", "text": "...", "severity": "critical|high|normal|low"}],
  "medications": [{"name": "...", "dose": "...", "frequency": "...", "indication": "..."}],
  "supplements": [{"name": "...", "dose": "...", "frequency": "...", "purpose": "..."}],
  "symptoms": [{"symptom": "hot flash|migraine|bloating|cramps|insomnia|fatigue|anxiety|...", "severity": 1-10, "context": "..."}],
  "cycle_status": "regular|irregular|perimenopause|menopause|post_menopause|pregnant|postpartum|on_bc|iud|unknown",
  "tags": ["perimenopause|thyroid|PCOS|GLP1|SAHM|traveler|shift-worker|..."],
  "life_events": ["divorce|death|new_baby|new_job|move|surgery|..."]
}

Rules of extraction:
- Only extract facts EXPLICITLY mentioned. No inference.
- Be conservative — better to miss than fabricate.
- For symptoms: only if mentioned as recurring or notable
- If nothing meaningful found in a category, omit the key entirely
- No commentary, no markdown, JSON only."""

    body = {
        "model": MODEL,
        "max_tokens": 2000,
        "system": system,
        "messages": [{"role": "user", "content": f"CLIENT: {client_name}\n\nCHECK-INS + INTAKE DATA:\n{corpus[:20000]}"}],
    }
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json"},
        json=body, timeout=60,
    )
    if not r.ok:
        raise RuntimeError(f"Claude {r.status_code}: {r.text[:200]}")
    txt = r.json()["content"][0]["text"].strip()
    # Strip markdown fences if any
    txt = re.sub(r"^```json\s*|\s*```$", "", txt, flags=re.MULTILINE).strip()
    try:
        return json.loads(txt)
    except Exception as e:
        return {"_error": str(e), "_raw": txt[:500]}


def build_corpus(client_id: str) -> str:
    checkins = sb_get("/weekly_checkins", {
        "select": "checkin_date,wins,struggles,questions,feedback,raw_form_data,mood",
        "client_id": f"eq.{client_id}",
        "order": "checkin_date.desc",
        "limit": "20",
    })
    parts = []
    for c in checkins:
        parts.append(f"[{c.get('checkin_date','?')}]")
        for k in ("wins","struggles","questions","feedback","mood"):
            if c.get(k) and len(str(c[k])) > 5:
                parts.append(f"  {k}: {str(c[k])[:400]}")
        raw = c.get("raw_form_data")
        if raw and isinstance(raw, dict):
            for k, v in (raw.get("all_answers") or {}).items():
                if isinstance(v, str) and len(v) > 5 and v.lower() != "no answer":
                    parts.append(f"  {k}: {v[:200]}")
    return "\n".join(parts)


def process_client(c: dict) -> dict:
    cid = c["id"]
    corpus = build_corpus(cid)
    if len(corpus) < 100:
        return {"client_id": cid, "name": c["full_name"], "skipped": "no data"}

    try:
        result = claude_extract(c["full_name"], corpus)
    except Exception as e:
        return {"client_id": cid, "name": c["full_name"], "error": str(e)[:100]}
    if "_error" in result:
        return {"client_id": cid, "name": c["full_name"], "error": result["_error"]}

    inserts = {"rules": 0, "meds": 0, "supps": 0, "symptoms": 0, "cycle": 0, "tags": 0, "notes": 0}

    for rule in result.get("rules", []):
        try:
            sb_post("/client_rules", {
                "client_id": cid,
                "category": rule.get("category", "other"),
                "rule_text": rule.get("text", "")[:500],
                "severity": rule.get("severity", "normal"),
                "source": "claude_backfill_checkins",
                "added_by": "claude_haiku",
            })
            inserts["rules"] += 1
        except Exception:
            pass

    for m in result.get("medications", []):
        try:
            sb_post("/client_medications", {
                "client_id": cid,
                "medication_name": m.get("name", "")[:200],
                "dose": m.get("dose"),
                "frequency": m.get("frequency"),
                "indication": m.get("indication"),
                "active": True,
            })
            inserts["meds"] += 1
        except Exception:
            pass

    for s in result.get("supplements", []):
        try:
            sb_post("/client_supplements", {
                "client_id": cid,
                "supplement_name": s.get("name", "")[:200],
                "dose": s.get("dose"),
                "frequency": s.get("frequency"),
                "purpose": s.get("purpose"),
                "active": True,
            })
            inserts["supps"] += 1
        except Exception:
            pass

    for s in result.get("symptoms", []):
        try:
            sb_post("/client_symptoms", {
                "client_id": cid,
                "logged_at": datetime.now(timezone.utc).isoformat(),
                "symptom": s.get("symptom", "")[:100],
                "severity": s.get("severity") if isinstance(s.get("severity"), int) else None,
                "context": s.get("context"),
                "source": "claude_extract",
            })
            inserts["symptoms"] += 1
        except Exception:
            pass

    cycle = result.get("cycle_status")
    if cycle and cycle != "unknown":
        try:
            sb_post("/client_cycle_tracking", {"client_id": cid, "status": cycle, "notes": "extracted from check-ins"})
            inserts["cycle"] += 1
        except Exception:
            pass

    for tag in result.get("tags", []):
        if not tag:
            continue
        try:
            sb_post("/client_tags", {"client_id": cid, "tag": tag.lower()[:50], "added_by": "claude_extract"})
            inserts["tags"] += 1
        except Exception:
            pass

    for le in result.get("life_events", []):
        try:
            sb_post("/client_notes", {
                "client_id": cid,
                "note_type": "life_event",
                "body": le,
                "tags": ["life_event", "claude_extract"],
                "created_by": "claude_haiku",
            })
            inserts["notes"] += 1
        except Exception:
            pass

    return {"client_id": cid, "name": c["full_name"], "inserts": inserts}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int)
    ap.add_argument("--concurrency", type=int, default=4)
    args = ap.parse_args()

    clients = sb_get("/clients", {
        "select": "id,full_name",
        "is_active": "eq.true",
        "is_internal": "eq.false",
        "potential_duplicate_of": "is.null",
        "limit": "200",
    })
    if args.limit:
        clients = clients[:args.limit]
    print(f"Extracting from {len(clients)} clients (concurrency={args.concurrency})...\n", flush=True)

    totals = {"rules": 0, "meds": 0, "supps": 0, "symptoms": 0, "cycle": 0, "tags": 0, "notes": 0}
    done = 0

    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futs = {ex.submit(process_client, c): c for c in clients}
        for f in as_completed(futs):
            done += 1
            r = f.result()
            name = r["name"][:30]
            if "error" in r:
                print(f"  [{done}/{len(clients)}] {name:30s} ✗ {r['error'][:60]}", flush=True)
            elif "skipped" in r:
                print(f"  [{done}/{len(clients)}] {name:30s} ⚠ {r['skipped']}", flush=True)
            else:
                s = r["inserts"]
                for k, v in s.items():
                    totals[k] += v
                summary = " ".join(f"{k}:{v}" for k, v in s.items() if v)
                print(f"  [{done}/{len(clients)}] {name:30s} ✓ {summary}", flush=True)

    print("\n─── totals ───")
    for k, v in totals.items():
        print(f"  {k:12s}: {v}")


if __name__ == "__main__":
    main()
