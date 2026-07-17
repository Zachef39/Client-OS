#!/usr/bin/env python3
"""
Pull EVERY weight entry ever recorded per client from Trainerize bodyStat calendar.
Writes to weekly_checkins-equivalent OR direct to a new weights table if needed.

For now: adds latest weight to clients.starting_weight_lbs if missing +
inserts weight_lbs entries into weekly_checkins for backfill.
"""
import os, base64, requests, json
from datetime import date, timedelta, datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

load_dotenv("/Users/zachef/Desktop/Playground - Claude/.env")
TZ_AUTH = base64.b64encode(f"{os.environ['TRAINERIZE_GROUP_ID']}:{os.environ['TRAINERIZE_API_TOKEN']}".encode()).decode()
TZ_H = {"Authorization": f"Basic {TZ_AUTH}", "Content-Type": "application/json"}

SB = "https://sfuvqaoeuajsrvldoiek.supabase.co"
K = os.environ.get("FAERBER_CLIENT_OS_SUPABASE_KEY", "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U")
SH = {"apikey": K, "Authorization": f"Bearer {K}", "Content-Type": "application/json"}


def sb_get(path, params=None):
    r = requests.get(f"{SB}/rest/v1{path}", headers=SH, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_post(path, data):
    r = requests.post(f"{SB}/rest/v1{path}", headers=SH, json=data, timeout=15)
    return r.ok


def sb_patch(path, data, params):
    r = requests.patch(f"{SB}/rest/v1{path}", headers=SH, json=data, params=params, timeout=15)
    return r.ok


def tz_post(path, body):
    r = requests.post(f"https://api.trainerize.com/v03{path}", headers=TZ_H, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def pull_weights_for_client(c):
    tz_id = int(c["trainerize_user_id"])
    weights = []
    # Chunk into 365-day windows going back 3 years
    today = date.today()
    for years_back in range(3):
        end = today - timedelta(days=years_back * 360)
        start = end - timedelta(days=360)
        try:
            cal = tz_post("/calendar/getList", {"userID": tz_id, "startDate": start.isoformat(), "endDate": end.isoformat()})
            for day in cal.get("calendar", []):
                for item in day.get("items", []):
                    if item.get("type") == "bodyStat":
                        w = (item.get("detail") or {}).get("weight")
                        if w:
                            weights.append((day["date"], float(w)))
        except Exception as e:
            return {"name": c["full_name"], "error": str(e)[:60]}
    weights.sort()
    if not weights:
        return {"name": c["full_name"], "weights_found": 0}

    first_w = weights[0][1]
    latest_w = weights[-1][1]

    # Update starting_weight_lbs if missing
    if not c.get("starting_weight_lbs"):
        sb_patch("/clients", {"starting_weight_lbs": first_w}, {"id": f"eq.{c['id']}"})

    # Insert weight entries into weekly_checkins where missing
    existing = sb_get("/weekly_checkins", {"select": "checkin_date", "client_id": f"eq.{c['id']}", "limit": "500"})
    existing_dates = {e["checkin_date"] for e in existing}
    new_rows = []
    for d, w in weights:
        if d in existing_dates:
            continue
        new_rows.append({"client_id": c["id"], "checkin_date": d, "weight_lbs": w, "raw_form_data": {"source": "trainerize_bodyStat"}})
    if new_rows:
        # Bulk insert
        chunk_size = 50
        for i in range(0, len(new_rows), chunk_size):
            sb_post("/weekly_checkins", new_rows[i:i+chunk_size])

    return {
        "name": c["full_name"],
        "weights_found": len(weights),
        "new_rows": len(new_rows),
        "first_date": weights[0][0],
        "latest_date": weights[-1][0],
        "first_w": first_w,
        "latest_w": latest_w,
    }


clients = sb_get("/clients", {
    "select": "id,full_name,trainerize_user_id,starting_weight_lbs,goal_weight_lbs",
    "is_active": "eq.true",
    "is_internal": "eq.false",
    "potential_duplicate_of": "is.null",
    "trainerize_user_id": "not.is.null",
    "limit": "200",
})
print(f"Pulling all weights from Trainerize for {len(clients)} clients...\n")

flagged_no_data = []
total_new = 0
with ThreadPoolExecutor(max_workers=4) as ex:
    futs = {ex.submit(pull_weights_for_client, c): c for c in clients}
    for i, f in enumerate(as_completed(futs), 1):
        r = f.result()
        if r.get("error"):
            print(f"  [{i}/{len(clients)}] {r['name'][:28]:28s} ✗ {r['error']}")
        elif r.get("weights_found", 0) == 0:
            flagged_no_data.append(r["name"])
            print(f"  [{i}/{len(clients)}] {r['name'][:28]:28s} ⚠ NO WEIGHTS EVER RECORDED — flag for manual review")
        else:
            total_new += r.get("new_rows", 0)
            print(f"  [{i}/{len(clients)}] {r['name'][:28]:28s} ✓ {r['weights_found']} weights ({r['first_date']} → {r['latest_date']}) · +{r.get('new_rows',0)} new · {r['first_w']:.0f} → {r['latest_w']:.0f} lb")

print(f"\ntotal new weight records: {total_new}")
print(f"clients w/ no weight data ever: {len(flagged_no_data)}")
if flagged_no_data:
    print("  → " + ", ".join(flagged_no_data))
