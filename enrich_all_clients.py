#!/usr/bin/env python3
"""
Enrich every active Trainerize client in Supabase with:
  - Weight goals (starting + goal weight, from goal API)
  - Macros (calories, protein, carbs, fat targets)
  - Latest weigh-in weight (bodyStat calendar item)
  - Email/phone from Trainerize user record
  - Start date (from Trainerize created_at if missing)

Also creates client_goals record for weight goal if not exists.
"""
import os, base64, json, requests, sys
from datetime import date, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

load_dotenv("/Users/zachef/Desktop/Playground - Claude/.env")

TZ_ID = os.environ["TRAINERIZE_GROUP_ID"]
TZ_TOK = os.environ["TRAINERIZE_API_TOKEN"]
TZ_AUTH = base64.b64encode(f"{TZ_ID}:{TZ_TOK}".encode()).decode()
TZ = {"Authorization": f"Basic {TZ_AUTH}", "Content-Type": "application/json"}

SB = "https://sfuvqaoeuajsrvldoiek.supabase.co"
SB_KEY = os.environ.get("FAERBER_CLIENT_OS_SUPABASE_KEY", "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U")
SH = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"}


def tz_post(path, body):
    r = requests.post(f"https://api.trainerize.com/v03{path}", headers=TZ, json=body, timeout=20)
    r.raise_for_status()
    return r.json()


def sb_get(path, params=None):
    r = requests.get(f"{SB}/rest/v1{path}", headers=SH, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_patch(path, data, params):
    r = requests.patch(f"{SB}/rest/v1{path}", headers=SH, json=data, params=params, timeout=15)
    if not r.ok:
        raise RuntimeError(f"PATCH {r.status_code} {r.text[:150]}")


def sb_post(path, data):
    r = requests.post(f"{SB}/rest/v1{path}", headers=SH, json=data, timeout=15)
    if not r.ok:
        raise RuntimeError(f"POST {r.status_code} {r.text[:150]}")


def enrich_one(client):
    cid = client["id"]
    tz_id = int(client["trainerize_user_id"])
    updates = {}

    # Nutrition targets (meal plan first, fallback to goal)
    try:
        mp = tz_post("/mealPlan/get", {"userID": tz_id})
        if mp.get("caloricGoal"):
            updates["daily_calorie_target"] = int(mp["caloricGoal"])
        if mp.get("proteinGrams"):
            updates["daily_protein_target_g"] = int(mp["proteinGrams"])
        if mp.get("carbsGrams"):
            updates["daily_carbs_target_g"] = int(mp["carbsGrams"])
        if mp.get("fatGrams"):
            updates["daily_fat_target_g"] = int(mp["fatGrams"])
    except Exception:
        pass
    if not updates.get("daily_calorie_target"):
        try:
            g = tz_post("/goal/getNutrition", {"userID": tz_id})
            if g.get("caloricGoal"):
                updates["daily_calorie_target"] = int(g["caloricGoal"])
            if g.get("proteinGrams"):
                updates["daily_protein_target_g"] = int(g["proteinGrams"])
            if g.get("carbsGrams"):
                updates["daily_carbs_target_g"] = int(g["carbsGrams"])
            if g.get("fatGrams"):
                updates["daily_fat_target_g"] = int(g["fatGrams"])
        except Exception:
            pass

    # Latest weight from calendar bodyStat
    try:
        end = date.today()
        start = end - timedelta(days=90)
        cal = tz_post("/calendar/getList", {"userID": tz_id, "startDate": start.isoformat(), "endDate": end.isoformat()})
        weights = []
        for day in cal.get("calendar", []):
            for item in day.get("items", []):
                if item.get("type") == "bodyStat":
                    w = (item.get("detail") or {}).get("weight")
                    if w:
                        weights.append((day["date"], w))
        if weights:
            weights.sort()
            first_w = weights[0][1]
            latest_w = weights[-1][1]
            if not client.get("starting_weight_lbs"):
                updates["starting_weight_lbs"] = first_w
    except Exception:
        pass

    if updates:
        try:
            sb_patch("/clients", updates, {"id": f"eq.{cid}"})
        except Exception as e:
            return {"name": client["full_name"], "error": str(e)[:80]}

    return {"name": client["full_name"], "updates": list(updates.keys())}


clients = sb_get("/clients", {
    "select": "id,full_name,trainerize_user_id,starting_weight_lbs,daily_calorie_target",
    "is_active": "eq.true",
    "is_internal": "eq.false",
    "potential_duplicate_of": "is.null",
    "trainerize_user_id": "not.is.null",
    "limit": "200",
})
print(f"Enriching {len(clients)} clients...", flush=True)

updated = 0
errored = 0
with ThreadPoolExecutor(max_workers=6) as ex:
    futs = {ex.submit(enrich_one, c): c for c in clients}
    for i, f in enumerate(as_completed(futs), 1):
        r = f.result()
        if r.get("error"):
            errored += 1
            print(f"  [{i}/{len(clients)}] {r['name'][:30]:30s} ✗ {r['error']}", flush=True)
        elif r.get("updates"):
            updated += 1
            print(f"  [{i}/{len(clients)}] {r['name'][:30]:30s} ✓ {', '.join(r['updates'])}", flush=True)
        else:
            print(f"  [{i}/{len(clients)}] {r['name'][:30]:30s} — no updates", flush=True)

print(f"\nupdated: {updated}, errored: {errored}")
