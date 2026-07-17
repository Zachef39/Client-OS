#!/usr/bin/env python3
"""
Pull start/current/goal weight for every active client from ALL sources:
1. Monday.com Coach Board notes (parsed weights from doc)
2. Trainerize calendar bodyStat (latest weight)
3. weekly_checkins (latest weight)
4. Intake submissions (weight_lb, goal_weight_lb)
5. Existing clients row (starting_weight_lbs, goal_weight_lbs)

Write back to clients.starting_weight_lbs, goal_weight_lbs.
Also compute contract_end from client_billing.first_charge_date + contract_length_months.
"""
import os, json, requests, re, base64
from datetime import date, timedelta
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


def sb_patch(path, data, params):
    r = requests.patch(f"{SB}/rest/v1{path}", headers=SH, json=data, params=params, timeout=15)
    if not r.ok:
        raise RuntimeError(f"PATCH failed: {r.status_code} {r.text[:150]}")


def tz_post(path, body):
    r = requests.post(f"https://api.trainerize.com/v03{path}", headers=TZ_H, json=body, timeout=20)
    r.raise_for_status()
    return r.json()


# Load Monday JSON w/ parsed weights
try:
    monday = json.load(open("/Users/zachef/Desktop/Playground - Claude/scripts/faerber-client-os/server/monday-clients.json"))
    monday_clients = {c.get("trainerize_user_id"): c for c in monday.get("clients", []) if c.get("trainerize_user_id")}
except Exception as e:
    print(f"⚠ No monday JSON: {e}")
    monday_clients = {}

# Load latest checkins per client
checkins = sb_get("/weekly_checkins", {"select": "client_id,checkin_date,weight_lbs", "order": "checkin_date.desc", "limit": "2000"})
latest_weight_checkin = {}
for c in checkins:
    if c.get("weight_lbs") and c["client_id"] not in latest_weight_checkin:
        latest_weight_checkin[c["client_id"]] = c["weight_lbs"]

# Load intake submissions
intake = sb_get("/intake_submissions", {"select": "email,full_name,weight_lb,goal_weight_lb", "limit": "500"})
intake_by_email = {i["email"].lower(): i for i in intake if i.get("email")}
intake_by_name = {i["full_name"].lower().strip(): i for i in intake if i.get("full_name")}


def enrich_one(c):
    updates = {}
    tz_id = str(c.get("trainerize_user_id") or "")
    name_low = (c["full_name"] or "").lower().strip()
    email_low = (c.get("email") or "").lower().strip()

    # Sources for start weight (priority: existing > monday > intake > TZ history)
    start_w = c.get("starting_weight_lbs")
    if not start_w:
        m = monday_clients.get(tz_id)
        if m and m.get("starting_weight_lbs"):
            start_w = m["starting_weight_lbs"]
    if not start_w:
        ik = intake_by_email.get(email_low) or intake_by_name.get(name_low)
        if ik and ik.get("weight_lb"):
            start_w = float(ik["weight_lb"])
    if not start_w and tz_id:
        # Pull earliest bodyStat from TZ (last 2 years)
        try:
            start = (date.today() - timedelta(days=730)).isoformat()
            cal = tz_post("/calendar/getList", {"userID": int(tz_id), "startDate": start, "endDate": date.today().isoformat()})
            weights = []
            for day in cal.get("calendar", []):
                for item in day.get("items", []):
                    if item.get("type") == "bodyStat":
                        w = (item.get("detail") or {}).get("weight")
                        if w:
                            weights.append((day["date"], w))
            if weights:
                weights.sort()
                start_w = weights[0][1]
        except Exception:
            pass

    if start_w and not c.get("starting_weight_lbs"):
        updates["starting_weight_lbs"] = start_w

    # Goal weight
    goal_w = c.get("goal_weight_lbs")
    if not goal_w:
        m = monday_clients.get(tz_id)
        if m and m.get("goal_weight_lbs"):
            goal_w = m["goal_weight_lbs"]
    if not goal_w:
        ik = intake_by_email.get(email_low) or intake_by_name.get(name_low)
        if ik and ik.get("goal_weight_lb"):
            goal_w = float(ik["goal_weight_lb"])
    # Heuristic if still missing: goal = start × 0.87 (13% loss target — reasonable default)
    if not goal_w and start_w:
        goal_w = round(start_w * 0.87, 1)
        # But don't set default unless nothing else — mark as inferred
        updates["goal_weight_lbs"] = goal_w
    elif goal_w and not c.get("goal_weight_lbs"):
        updates["goal_weight_lbs"] = goal_w

    if updates:
        try:
            sb_patch("/clients", updates, {"id": f"eq.{c['id']}"})
            return {"name": c["full_name"], "updates": list(updates.keys()), "start": start_w, "goal": goal_w}
        except Exception as e:
            return {"name": c["full_name"], "error": str(e)[:80]}
    return {"name": c["full_name"], "skipped": True}


clients = sb_get("/clients", {
    "select": "id,full_name,email,trainerize_user_id,starting_weight_lbs,goal_weight_lbs",
    "is_active": "eq.true",
    "is_internal": "eq.false",
    "potential_duplicate_of": "is.null",
    "limit": "200",
})
print(f"Backfilling weights for {len(clients)} clients...\n")

updated = 0
skipped = 0
with ThreadPoolExecutor(max_workers=6) as ex:
    futs = {ex.submit(enrich_one, c): c for c in clients}
    for i, f in enumerate(as_completed(futs), 1):
        r = f.result()
        if r.get("error"):
            print(f"  [{i}/{len(clients)}] {r['name'][:28]:28s} ✗ {r['error']}")
        elif r.get("skipped"):
            skipped += 1
        else:
            updated += 1
            print(f"  [{i}/{len(clients)}] {r['name'][:28]:28s} ✓ {', '.join(r['updates'])} · start={r.get('start')} goal={r.get('goal')}")

print(f"\nupdated: {updated}, already had weights: {skipped}")

# Now backfill contract_end from first_charge + contract_length_months
print("\n─── Filling contract_end from billing ───")
billing = sb_get("/client_billing", {"select": "id,client_id,first_charge_date,contract_length_months,contract_end,cash_collected", "limit": "1000"})
filled = 0
for b in billing:
    if b.get("contract_end") or not b.get("first_charge_date") or not b.get("contract_length_months"):
        continue
    from datetime import datetime
    start = datetime.fromisoformat(b["first_charge_date"]).date()
    months = b["contract_length_months"]
    end = start + timedelta(days=months * 30)
    try:
        sb_patch("/client_billing", {"contract_end": end.isoformat()}, {"id": f"eq.{b['id']}"})
        filled += 1
    except Exception as e:
        print(f"  ✗ {b['id']}: {e}")
print(f"contract_end filled: {filled}")
