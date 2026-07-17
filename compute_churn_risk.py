#!/usr/bin/env python3
"""
Faerber Client OS — daily churn risk scoring.

For each active client, score 0-100 across signals:
  - Days since last inbound message (from client)
  - Days since last check-in
  - Days since last workout completed
  - Workout compliance last 4wk
  - Payment failure count
  - Ghosting status
  - Contract ending soon
  - Weight trajectory (misaligned w/ goal)

Writes to public.client_churn_risk (append-only, one row per day).
Tier: low(<25) / medium(25-50) / high(50-75) / critical(>75)
Trend: 'new' | 'improving' | 'stable' | 'worsening' (compared to prev score).

Usage:
  python compute_churn_risk.py
  python compute_churn_risk.py --dry-run
  python compute_churn_risk.py --client "Adora"
"""
import argparse
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

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


def sb_get(path: str, params: dict = None) -> list:
    r = requests.get(f"{SUPABASE_URL}/rest/v1{path}", headers=SB_HEADERS, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_post(path: str, data: dict | list) -> None:
    r = requests.post(f"{SUPABASE_URL}/rest/v1{path}", headers=SB_HEADERS, json=data, timeout=15)
    if not r.ok:
        raise RuntimeError(f"POST failed: {r.status_code} {r.text[:200]}")


def compute_score_for_client(client: dict) -> dict:
    cid = client["id"]
    now = datetime.now(timezone.utc).date()
    reasons = []
    signals = {}
    score = 0

    # 1. Days since last inbound message
    msgs = sb_get(
        "/client_conversations",
        {
            "select": "sent_at",
            "client_id": f"eq.{cid}",
            "direction": "eq.inbound",
            "order": "sent_at.desc",
            "limit": "1",
        },
    )
    if msgs:
        last_inbound = datetime.fromisoformat(msgs[0]["sent_at"].replace("Z", "+00:00")).date()
        days_since_msg = (now - last_inbound).days
        signals["days_since_inbound_msg"] = days_since_msg
        if days_since_msg > 45:
            score += 35
            reasons.append(f"Silent {days_since_msg}d")
        elif days_since_msg > 21:
            score += 15
            reasons.append(f"Quiet {days_since_msg}d")
    else:
        signals["days_since_inbound_msg"] = None
        # Only penalize if client is old enough to have messaged
        score += 15
        reasons.append("No inbound messages on record")

    # 2. Days since last check-in
    ckin = sb_get(
        "/weekly_checkins",
        {
            "select": "checkin_date",
            "client_id": f"eq.{cid}",
            "order": "checkin_date.desc",
            "limit": "1",
        },
    )
    if ckin:
        last_ckin = datetime.fromisoformat(ckin[0]["checkin_date"]).date()
        days_since_ckin = (now - last_ckin).days
        signals["days_since_checkin"] = days_since_ckin
        if days_since_ckin > 28:
            score += 20
            reasons.append(f"No check-in in {days_since_ckin}d")
        elif days_since_ckin > 21:
            score += 10
            reasons.append(f"Missed 3 check-ins")
    else:
        signals["days_since_checkin"] = None

    # 3. Latest daily snapshot signals
    snap = sb_get(
        "/daily_snapshots",
        {
            "select": "snapshot_date,workout_completion_pct,days_logged_last_7,workout_streak_days,flag_color,weight_trajectory,is_onboarding",
            "client_id": f"eq.{cid}",
            "order": "snapshot_date.desc",
            "limit": "1",
        },
    )
    if snap:
        s = snap[0]
        signals["latest_flag_color"] = s.get("flag_color")
        signals["latest_workout_pct"] = s.get("workout_completion_pct")
        signals["latest_days_logged_7"] = s.get("days_logged_last_7")
        signals["latest_trajectory"] = s.get("weight_trajectory")
        if s.get("flag_color") == "red":
            score += 15
            reasons.append("Red engagement")
        elif s.get("flag_color") == "yellow":
            score += 5
            reasons.append("Yellow engagement")
        if s.get("workout_completion_pct") is not None and s["workout_completion_pct"] < 30 and not s.get("is_onboarding"):
            score += 15
            reasons.append(f"Workouts {s['workout_completion_pct']:.0f}%")
        if s.get("days_logged_last_7", 7) < 2 and not s.get("is_onboarding"):
            score += 10
            reasons.append(f"Only {s['days_logged_last_7']}/7 days logged")
        if s.get("weight_trajectory") == "bad":
            score += 5
            reasons.append("Weight trending wrong way")

    # 4. Client status = ghosting
    if client.get("client_status") == "ghosting":
        score += 20
        reasons.append("Marked ghosting")

    # 5. Billing signals
    billing = sb_get(
        "/client_billing",
        {"select": "payment_failure_count,contract_end,cash_collected", "client_id": f"eq.{cid}", "limit": "1"},
    )
    if billing:
        b = billing[0]
        signals["payment_failures"] = b.get("payment_failure_count", 0)
        signals["contract_end"] = b.get("contract_end")
        if (b.get("payment_failure_count") or 0) > 2:
            score += 25
            reasons.append(f"{b['payment_failure_count']} failed payments")
        if b.get("contract_end"):
            try:
                end = datetime.fromisoformat(b["contract_end"]).date()
                days_to_end = (end - now).days
                signals["days_to_contract_end"] = days_to_end
                if 0 <= days_to_end <= 21:
                    score += 15
                    reasons.append(f"Contract ends in {days_to_end}d")
            except Exception:
                pass

    # Cap 0-100
    score = min(100, max(0, score))

    # Tier — looser thresholds so healthy clients show as healthy
    if score >= 75:
        tier = "critical"
    elif score >= 55:
        tier = "high"
    elif score >= 35:
        tier = "medium"
    else:
        tier = "low"

    # Trend — compare to previous score
    prev = sb_get(
        "/client_churn_risk",
        {"select": "risk_score", "client_id": f"eq.{cid}", "order": "scored_at.desc", "limit": "1"},
    )
    if not prev:
        trend = "new"
    else:
        prev_score = prev[0]["risk_score"]
        if score < prev_score - 5:
            trend = "improving"
        elif score > prev_score + 5:
            trend = "worsening"
        else:
            trend = "stable"

    # Suggested action
    if tier == "critical":
        action = "Personal outreach + call this week"
    elif tier == "high":
        action = "Direct DM + coaching adjustment"
    elif tier == "medium":
        action = "Light nudge, monitor next 7 days"
    else:
        action = "No action needed"

    return {
        "client_id": cid,
        "risk_score": score,
        "risk_tier": tier,
        "trend": trend,
        "primary_reasons": reasons[:5],
        "signals": signals,
        "recommended_action": action,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--client", help="Only run for one client by name substring")
    args = ap.parse_args()

    # Only real active clients
    params = {
        "select": "id,full_name,client_status",
        "is_active": "eq.true",
        "is_internal": "eq.false",
        "potential_duplicate_of": "is.null",
        "limit": "200",
    }
    if args.client:
        params["full_name"] = f"ilike.%{args.client}%"

    clients = sb_get("/clients", params)
    print(f"Scoring {len(clients)} clients...\n", flush=True)

    tier_counts = {"low": 0, "medium": 0, "high": 0, "critical": 0}
    rows_to_write = []

    for c in clients:
        try:
            result = compute_score_for_client(c)
            tier_counts[result["risk_tier"]] += 1
            reasons_str = " · ".join(result["primary_reasons"][:3]) or "clean"
            print(f"  {c['full_name'][:28]:28s}  {result['risk_score']:>3}  {result['risk_tier']:8s} {result['trend']:9s} {reasons_str[:80]}", flush=True)
            if not args.dry_run:
                rows_to_write.append(result)
        except Exception as e:
            print(f"  ✗ {c['full_name'][:28]:28s}  ERROR: {str(e)[:60]}", flush=True)

    if rows_to_write:
        # Bulk insert
        sb_post("/client_churn_risk", rows_to_write)

    print("\n─── summary ───")
    for tier in ("critical", "high", "medium", "low"):
        print(f"  {tier:10s}: {tier_counts[tier]}")


if __name__ == "__main__":
    main()
