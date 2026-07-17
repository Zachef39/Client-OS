#!/usr/bin/env python3
"""
Build tomorrow's per-client review report — HTML page for Zach to walk through.

For each active client:
  - Progress summary (start → current → goal · % · pace)
  - Engagement state (workouts, logging, streaks)
  - Missing data flags (weight? goal? checkin? recent call?)
  - Discussion prompts (what to discuss, what to change)
  - Latest activity (last msg, last call, last checkin date)

Output: /Users/zachef/Desktop/client-review-2026-07-12.html
"""
import os, requests, json
from datetime import date, datetime, timezone, timedelta
from pathlib import Path
from dotenv import load_dotenv

load_dotenv("/Users/zachef/Desktop/Playground - Claude/.env")
SB = "https://sfuvqaoeuajsrvldoiek.supabase.co"
K = os.environ.get("FAERBER_CLIENT_OS_SUPABASE_KEY", "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U")
H = {"apikey": K, "Authorization": f"Bearer {K}"}


def sb(path, params=None):
    r = requests.get(f"{SB}/rest/v1{path}", headers=H, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


clients = sb("/clients", {
    "select": "id,full_name,trainerize_user_id,email,start_date,starting_weight_lbs,goal_weight_lbs,daily_calorie_target,daily_protein_target_g,client_status",
    "is_active": "eq.true",
    "is_internal": "eq.false",
    "potential_duplicate_of": "is.null",
    "order": "full_name.asc",
    "limit": "200",
})

# Batch fetch related data
churn = {c["client_id"]: c for c in sb("/client_churn_risk", {"select": "client_id,risk_score,risk_tier,primary_reasons,recommended_action", "order": "scored_at.desc", "limit": "500"})}
billing_map = {}
for b in sb("/client_billing", {"select": "client_id,cash_collected,contract_end,last_charge_date,payment_failure_count"}):
    if not b.get("client_id"): continue
    if b["client_id"] not in billing_map:
        billing_map[b["client_id"]] = {"cash": 0, "failures": 0, "contract_end": None, "last_charge": None}
    billing_map[b["client_id"]]["cash"] += float(b.get("cash_collected") or 0)
    billing_map[b["client_id"]]["failures"] += (b.get("payment_failure_count") or 0)
    if b.get("contract_end") and (not billing_map[b["client_id"]]["contract_end"] or b["contract_end"] > billing_map[b["client_id"]]["contract_end"]):
        billing_map[b["client_id"]]["contract_end"] = b["contract_end"]
    if b.get("last_charge_date") and (not billing_map[b["client_id"]]["last_charge"] or b["last_charge_date"] > billing_map[b["client_id"]]["last_charge"]):
        billing_map[b["client_id"]]["last_charge"] = b["last_charge_date"]

# Latest snapshot per client
snap_map = {}
for s in sb("/daily_snapshots", {"select": "*", "order": "snapshot_date.desc", "limit": "2000"}):
    if s["client_id"] not in snap_map:
        snap_map[s["client_id"]] = s

# Latest checkin per client
ck_map = {}
weights_by_client = {}
for c in sb("/weekly_checkins", {"select": "client_id,checkin_date,weight_lbs,wins,struggles,questions", "order": "checkin_date.desc", "limit": "3000"}):
    if c["client_id"] not in ck_map:
        ck_map[c["client_id"]] = c
    if c.get("weight_lbs"):
        weights_by_client.setdefault(c["client_id"], []).append((c["checkin_date"], c["weight_lbs"]))

# Latest call per client
call_map = {}
for c in sb("/client_calls", {"select": "client_id,call_date,call_type,fathom_url,fathom_summary", "order": "call_date.desc", "limit": "500"}):
    if c["client_id"] and c["client_id"] not in call_map:
        call_map[c["client_id"]] = c

# Latest inbound msg per client
msg_map = {}
for m in sb("/client_conversations", {"select": "client_id,sent_at,body,direction", "direction": "eq.inbound", "order": "sent_at.desc", "limit": "1000"}):
    if m["client_id"] not in msg_map:
        msg_map[m["client_id"]] = m

# Rules per client
rules_map = {}
for r in sb("/client_rules", {"select": "client_id,category,rule_text,severity", "active": "eq.true"}):
    rules_map.setdefault(r["client_id"], []).append(r)

# Analyze each client and generate discussion points
def analyze(c):
    cid = c["id"]
    flags = []
    discussion = []
    ch = churn.get(cid)
    b = billing_map.get(cid)
    s = snap_map.get(cid)
    ck = ck_map.get(cid)
    call = call_map.get(cid)
    msg = msg_map.get(cid)
    weights = weights_by_client.get(cid, [])
    rules = rules_map.get(cid, [])

    # Data gaps
    if not c.get("starting_weight_lbs"): flags.append("Missing starting weight")
    if not c.get("goal_weight_lbs"): flags.append("Missing goal weight")
    if not c.get("daily_calorie_target"): flags.append("No calorie target set")
    if not c.get("daily_protein_target_g"): flags.append("No protein target set")
    if not weights: flags.append("NO weight entries in database ever")
    if not ck: flags.append("Never submitted a check-in")
    if not call: flags.append("No calls on record")
    if not msg: flags.append("No inbound messages ever")
    if not rules: flags.append("No injuries/prefs/rules recorded — need intake context")

    # Current weight status
    latest_w = weights[0][1] if weights else None
    start_w = c.get("starting_weight_lbs")
    goal_w = c.get("goal_weight_lbs")
    delta = None
    pct = None
    if start_w and latest_w:
        delta = start_w - latest_w
    if start_w and goal_w and latest_w and start_w != goal_w:
        pct = max(0, min(100, ((start_w - latest_w) / (start_w - goal_w)) * 100))

    # Trend from last 4 weeks
    trend_msg = ""
    if weights and len(weights) >= 2:
        recent = weights[0][1]
        four_wks_ago = None
        for d, w in weights:
            days_diff = (date.today() - datetime.fromisoformat(d).date()).days
            if days_diff >= 28:
                four_wks_ago = w
                break
        if four_wks_ago is not None:
            diff = four_wks_ago - recent
            if diff > 2: trend_msg = f"↓ {diff:.1f} lb in last 4 wks (great)"
            elif diff > 0.5: trend_msg = f"↓ {diff:.1f} lb in last 4 wks (steady)"
            elif diff < -2: trend_msg = f"↑ {-diff:.1f} lb in last 4 wks (trending wrong)"
            elif diff < 0: trend_msg = f"↑ {-diff:.1f} lb slight bump"
            else: trend_msg = "Flat last 4 wks"

    # Discussion points
    if ch and ch.get("risk_tier") in ("critical", "high"):
        discussion.append(f"⚠ {ch['risk_tier'].upper()} risk ({ch['risk_score']}/100) — {', '.join((ch.get('primary_reasons') or [])[:2])}")
        if ch.get("recommended_action"):
            discussion.append(f"→ {ch['recommended_action']}")

    if pct is not None:
        if pct >= 90: discussion.append(f"🎉 {pct:.0f}% to goal — plan next chapter (maintenance/new goal)?")
        elif pct >= 50: discussion.append(f"👏 {pct:.0f}% to goal — keep momentum")
        elif pct < 10 and start_w and datetime.fromisoformat(c["start_date"]) if c.get("start_date") else datetime.now().date() < (date.today() - timedelta(days=60)):
            discussion.append(f"Stalled — {pct:.0f}% progress in {(date.today() - datetime.fromisoformat(c['start_date']).date()).days}d. Reassess macros/plan?")

    if trend_msg and "trending wrong" in trend_msg:
        discussion.append(f"Weight trending wrong direction — investigate")

    if s:
        if (s.get("workout_completion_pct") or 100) < 40:
            discussion.append(f"Workouts {s.get('workout_completion_pct',0):.0f}% — schedule mismatch or motivation drop?")
        if (s.get("days_logged_last_7") or 7) < 3:
            discussion.append(f"Only {s['days_logged_last_7']}/7 days logged — check food-logging friction")

    if b and b.get("contract_end"):
        try:
            days = (datetime.fromisoformat(b["contract_end"]).date() - date.today()).days
            if 0 <= days <= 30:
                discussion.append(f"💰 Contract ends in {days}d — plan renewal conversation")
            elif days < 0:
                discussion.append(f"🚨 Contract expired {-days}d ago — no active plan")
        except Exception:
            pass

    if b and b.get("failures", 0) > 0:
        discussion.append(f"💳 {b['failures']} failed charges — update card")

    return {
        "flags": flags,
        "discussion": discussion,
        "latest_w": latest_w,
        "start_w": start_w,
        "goal_w": goal_w,
        "delta": delta,
        "pct": pct,
        "trend_msg": trend_msg,
        "churn": ch,
        "billing": b,
        "snap": s,
        "checkin": ck,
        "call": call,
        "msg": msg,
        "num_weights": len(weights),
        "rules": rules,
    }


analyzed = []
for c in clients:
    a = analyze(c)
    analyzed.append((c, a))

# Sort: most-needing-attention first (has red flags OR high risk)
def priority(item):
    _, a = item
    score = 0
    if a["churn"] and a["churn"].get("risk_tier") == "critical": score += 100
    if a["churn"] and a["churn"].get("risk_tier") == "high": score += 50
    if a["churn"] and a["churn"].get("risk_tier") == "medium": score += 20
    score += len(a["flags"]) * 5
    score += len(a["discussion"]) * 3
    return -score

analyzed.sort(key=priority)


def esc(s): return str(s or "").replace("<", "&lt;").replace(">", "&gt;").replace("&", "&amp;")
def fmtdate(d):
    if not d: return "—"
    try: return datetime.fromisoformat(d.split("+")[0]).strftime("%b %d, %Y")
    except: return d


out = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Client Review · 2026-07-12</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
body{{font-family:'Inter',sans-serif;background:#f8fafc;padding:24px}}
.card{{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:24px;margin-bottom:20px}}
.flag{{background:#fef2f2;color:#b91c1c;padding:4px 10px;border-radius:6px;font-size:12px;font-weight:600;display:inline-block;margin:2px 4px 2px 0}}
.disc{{background:#eff6ff;color:#1d4ed8;padding:8px 12px;border-radius:6px;font-size:13px;margin-bottom:6px}}
.priority-critical{{border-left:6px solid #dc2626}}
.priority-high{{border-left:6px solid #ef4444}}
.priority-medium{{border-left:6px solid #f59e0b}}
.priority-low{{border-left:6px solid #10b981}}
.kpi-mini{{display:inline-block;padding:6px 14px;background:#f1f5f9;border-radius:8px;margin-right:8px;font-size:12px}}
.kpi-mini b{{color:#0f172a;font-size:15px}}
h2 a{{color:#005d93;text-decoration:none}}
h2 a:hover{{text-decoration:underline}}
.checkbox{{margin-right:10px;transform:scale(1.3)}}
</style>
</head><body class="max-w-5xl mx-auto">
<div class="mb-6">
  <h1 class="text-3xl font-bold" style="color:#005d93">Client Review · Tomorrow's Walk-Through</h1>
  <div class="text-slate-500 mt-1">{len(analyzed)} clients · sorted by priority · check the box as you finish each</div>
  <div class="text-xs text-slate-400 mt-2">Generated {datetime.now().strftime('%b %d, %Y %I:%M %p')}</div>
</div>
"""

for c, a in analyzed:
    tier = (a["churn"] or {}).get("risk_tier", "low")
    tier_class = f"priority-{tier}" if tier in ("critical","high","medium","low") else "priority-low"
    delta_str = f"{a['delta']:+.1f}" if a["delta"] is not None else "?"
    pct_str = f"{a['pct']:.0f}%" if a["pct"] is not None else "?"
    out += f'''
<div class="card {tier_class}">
  <div class="flex items-start gap-3">
    <input type="checkbox" class="checkbox mt-2">
    <div class="flex-1">
      <h2 class="text-xl font-bold mb-1"><a href="http://localhost:3737/client.html?id={c['id']}" target="_blank">{esc(c['full_name'])}</a></h2>
      <div class="text-sm text-slate-500 mb-3">
        Trainerize #{c.get('trainerize_user_id','?')} · Started {fmtdate(c.get('start_date'))} · {esc(c.get('email',''))}
      </div>
      <div class="mb-4">
        <span class="kpi-mini">Start: <b>{a['start_w'] or '?'}</b> lb</span>
        <span class="kpi-mini">Current: <b>{a['latest_w'] or '?'}</b> lb</span>
        <span class="kpi-mini">Goal: <b>{a['goal_w'] or '?'}</b> lb</span>
        <span class="kpi-mini">Progress: <b>{pct_str}</b></span>
        <span class="kpi-mini">Δ: <b>{delta_str}</b> lb</span>
        <span class="kpi-mini">{esc(a['trend_msg'] or 'No trend data')}</span>
      </div>
      {"<div class='mb-3'>" + " ".join(f'<span class="flag">{esc(f)}</span>' for f in a['flags']) + "</div>" if a['flags'] else ""}
      {"<div class='mb-3'>" + "".join(f'<div class="disc">{esc(d)}</div>' for d in a['discussion']) + "</div>" if a['discussion'] else ""}
      <div class="text-xs text-slate-500 space-y-1">
        <div>Last check-in: {fmtdate(a['checkin']['checkin_date']) if a['checkin'] else 'never'}</div>
        <div>Last inbound msg: {fmtdate(a['msg']['sent_at']) if a['msg'] else 'never'}</div>
        <div>Last call: {fmtdate(a['call']['call_date']) if a['call'] else 'none'}</div>
        <div>Weight entries in DB: {a['num_weights']}</div>
        <div>Rules on file: {len(a['rules'])}</div>
        {"<div>Cash collected: $" + f"{a['billing']['cash']:,.0f}" + " · Contract ends " + fmtdate(a['billing'].get('contract_end')) + "</div>" if a['billing'] else "<div>No billing record</div>"}
      </div>
    </div>
  </div>
</div>
'''

out += "</body></html>"

out_path = Path.home() / "Desktop" / f"client-review-{date.today().isoformat()}.html"
out_path.write_text(out)
print(f"Report written: {out_path}")
print(f"Total clients: {len(analyzed)}")
print(f"Missing weights entirely: {sum(1 for _,a in analyzed if a['num_weights']==0)}")
print(f"Missing goals: {sum(1 for _,a in analyzed if not a['goal_w'])}")
print(f"Critical risk: {sum(1 for _,a in analyzed if a['churn'] and a['churn'].get('risk_tier')=='critical')}")
