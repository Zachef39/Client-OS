#!/usr/bin/env python3
"""
Faerber Client OS — Stripe sync across 3 accounts (Medical, PandaDoc, Affirm).

Uses direct Supabase REST calls (skips slow supabase-py init).

Usage:
  python sync_stripe.py                    # sync all 3 accounts
  python sync_stripe.py --account medical  # single account
  python sync_stripe.py --dry-run          # print without writing
  python sync_stripe.py --limit 5          # first N customers per account
"""

import argparse
import base64
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import requests
from dotenv import load_dotenv

PROJECT_ROOT = Path("/Users/zachef/Desktop/Playground - Claude")
load_dotenv(PROJECT_ROOT / ".env")

STRIPE_ACCOUNTS = {
    "medical": os.environ.get("STRIPE_SK_MEDICAL", ""),
    "pandadoc": os.environ.get("STRIPE_SK_PANDADOC", ""),
    "affirm": os.environ.get("STRIPE_SK_AFFIRM", ""),
}

STRIPE_BASE = "https://api.stripe.com/v1"
SUPABASE_URL = "https://sfuvqaoeuajsrvldoiek.supabase.co"
SUPABASE_KEY = os.environ.get(
    "FAERBER_CLIENT_OS_SUPABASE_KEY",
    "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U",
)
SB_HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}


# ---------- Supabase REST helpers ----------
def sb_get(path: str, params: dict = None) -> list:
    r = requests.get(f"{SUPABASE_URL}/rest/v1{path}", headers=SB_HEADERS, params=params or {}, timeout=15)
    r.raise_for_status()
    return r.json()


def sb_post(path: str, data: dict | list, extra_prefer: str = "") -> list:
    hdrs = dict(SB_HEADERS)
    if extra_prefer:
        hdrs["Prefer"] = f"return=representation,{extra_prefer}"
    r = requests.post(f"{SUPABASE_URL}/rest/v1{path}", headers=hdrs, json=data, timeout=15)
    if not r.ok:
        raise RuntimeError(f"Supabase POST {path} failed: {r.status_code} {r.text[:200]}")
    return r.json()


def sb_patch(path: str, data: dict, params: dict = None) -> list:
    r = requests.patch(f"{SUPABASE_URL}/rest/v1{path}", headers=SB_HEADERS, json=data, params=params or {}, timeout=15)
    if not r.ok:
        raise RuntimeError(f"Supabase PATCH {path} failed: {r.status_code} {r.text[:200]}")
    return r.json()


def upsert_billing(payload: dict) -> None:
    """Upsert into client_billing on stripe_customer_id."""
    hdrs = dict(SB_HEADERS)
    hdrs["Prefer"] = "resolution=merge-duplicates,return=minimal"
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/client_billing?on_conflict=stripe_customer_id",
        headers=hdrs,
        json=payload,
        timeout=15,
    )
    if not r.ok:
        raise RuntimeError(f"Upsert billing failed: {r.status_code} {r.text[:200]}")


# ---------- Stripe helpers ----------
def stripe_get(key: str, path: str, params: dict = None) -> dict:
    auth = base64.b64encode(f"{key}:".encode()).decode()
    r = requests.get(
        f"{STRIPE_BASE}{path}",
        headers={"Authorization": f"Basic {auth}"},
        params=params or {},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def paginate(key: str, path: str, params: dict = None) -> list[dict]:
    params = dict(params or {})
    params["limit"] = 100
    results = []
    while True:
        data = stripe_get(key, path, params)
        results.extend(data.get("data", []))
        if not data.get("has_more"):
            break
        params["starting_after"] = data["data"][-1]["id"]
    return results


def pull_all_customers(key: str) -> list[dict]:
    return paginate(key, "/customers")


def pull_customer_charges(key: str, customer_id: str) -> list[dict]:
    all_charges = paginate(key, "/charges", {"customer": customer_id})
    return all_charges


def pull_customer_subs(key: str, customer_id: str) -> list[dict]:
    return paginate(key, "/subscriptions", {"customer": customer_id, "status": "all"})


def epoch_to_date(ts: Optional[int]) -> Optional[str]:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).date().isoformat()


def normalize_email(e: Optional[str]) -> Optional[str]:
    return e.strip().lower() if e else None


def find_client_id(email: Optional[str], name: Optional[str]) -> Optional[str]:
    """Match Stripe customer to Supabase client by email → name fallback."""
    if email:
        rows = sb_get("/clients", {"select": "id,full_name,email", "email": f"ilike.{email}", "limit": "1"})
        if rows:
            return rows[0]["id"]
    if not name:
        return None
    # Exact name match
    rows = sb_get("/clients", {"select": "id,full_name", "full_name": f"ilike.{name}", "limit": "1"})
    if rows:
        return rows[0]["id"]
    # Last-name fuzzy
    if " " in name:
        last = name.strip().split()[-1]
        if len(last) >= 3:
            rows = sb_get("/clients", {"select": "id,full_name", "full_name": f"ilike.%{last}%", "limit": "2"})
            if len(rows) == 1:
                return rows[0]["id"]
    return None


def summarize_subscription(subs: list[dict]) -> dict:
    active = [s for s in subs if s.get("status") in ("active", "trialing", "past_due")]
    current = active[0] if active else (subs[0] if subs else None)
    if not current:
        return {}
    plan = current.get("plan") or {}
    if not plan:
        items = (current.get("items") or {}).get("data") or []
        if items:
            plan = items[0].get("plan", {})
    interval = plan.get("interval")
    count = plan.get("interval_count", 1)
    months = None
    if interval == "month":
        months = count
    elif interval == "year":
        months = count * 12
    elif interval == "week":
        months = max(1, count // 4)
    return {
        "sub_status": current.get("status"),
        "contract_length_months": months,
        "current_period_end": epoch_to_date(current.get("current_period_end")),
        "current_period_start": epoch_to_date(current.get("current_period_start")),
    }


def process_customer(account: str, customer: dict, dry_run: bool = False) -> dict:
    key = STRIPE_ACCOUNTS[account]
    email = normalize_email(customer.get("email"))
    name = customer.get("name") or ""
    cust_id = customer["id"]

    client_id = find_client_id(email, name)

    all_charges = pull_customer_charges(key, cust_id)
    successful = [c for c in all_charges if c.get("status") == "succeeded"]
    failed = [c for c in all_charges if c.get("status") == "failed"]
    cash_collected = sum(c["amount"] for c in successful) / 100
    charge_dates = sorted(c["created"] for c in successful)
    first_charge = epoch_to_date(charge_dates[0]) if charge_dates else None
    last_charge = epoch_to_date(charge_dates[-1]) if charge_dates else None

    subs = pull_customer_subs(key, cust_id)
    sub_info = summarize_subscription(subs)

    addr = customer.get("address") or {}
    meta = customer.get("metadata") or {}

    if sub_info.get("sub_status") in ("active", "trialing"):
        contract_type = "payment_plan"
    elif cash_collected >= 2500 and not subs:
        contract_type = "paid_in_full"
    elif cash_collected > 0:
        contract_type = "other"
    else:
        contract_type = "other"

    pandadoc_url = meta.get("pandadoc_url") or meta.get("contract_url")
    contract_months = sub_info.get("contract_length_months")
    if not contract_months and meta.get("contract_months", "").isdigit():
        contract_months = int(meta["contract_months"])

    contract_end = sub_info.get("current_period_end")
    if not contract_end and first_charge and contract_months:
        contract_end = (
            datetime.fromisoformat(first_charge) + timedelta(days=contract_months * 30)
        ).date().isoformat()

    billing = {
        "client_id": client_id,
        "contract_type": contract_type,
        "contract_start": first_charge,
        "contract_end": contract_end,
        "cash_collected": cash_collected,
        "payment_source": "stripe",
        "stripe_customer_id": cust_id,
        "stripe_account": account,
        "billing_address_line1": addr.get("line1"),
        "billing_address_line2": addr.get("line2"),
        "billing_city": addr.get("city"),
        "billing_state": addr.get("state"),
        "billing_postal_code": addr.get("postal_code"),
        "billing_country": addr.get("country"),
        "pandadoc_contract_url": pandadoc_url,
        "contract_length_months": contract_months,
        "first_charge_date": first_charge,
        "last_charge_date": last_charge,
        "payment_failure_count": len(failed),
        "synced_at": datetime.now(timezone.utc).isoformat(),
    }

    # Discrepancy detection
    disc = []
    if not client_id:
        disc.append({
            "discrepancy_type": "stripe_no_client",
            "severity": "warn",
            "message": f"Stripe customer '{name or email}' has no matching client",
            "suggested_action": "Legacy customer or new lead not onboarded",
        })
    if len(failed) > 0 and sub_info.get("sub_status") == "past_due":
        disc.append({
            "discrepancy_type": "payment_failed",
            "severity": "critical",
            "message": f"{len(failed)} failed charges + past_due sub",
            "suggested_action": "Update card immediately",
        })
    if contract_end:
        try:
            end_dt = datetime.fromisoformat(contract_end).date()
            today = date.today()
            if end_dt < today:
                disc.append({
                    "discrepancy_type": "contract_expired",
                    "severity": "warn",
                    "message": f"Contract ended {contract_end}",
                    "suggested_action": "Confirm renewal or offboard",
                })
            elif end_dt < today + timedelta(days=30):
                disc.append({
                    "discrepancy_type": "contract_ending_soon",
                    "severity": "info",
                    "message": f"Contract ends {contract_end} (< 30 days)",
                    "suggested_action": "Schedule renewal call",
                })
        except Exception:
            pass

    if dry_run:
        marker = "✓" if client_id else "—"
        print(f"  [dry] {(name or email or '?')[:38]:38s} {account:9s} {marker} ${cash_collected:>9.2f} · {len(disc)} disc")
        return {"disc": disc, "billing": billing}

    # Upsert billing
    upsert_billing(billing)

    # Insert only new discrepancies
    for d in disc:
        # Check existing unresolved
        existing = sb_get(
            "/billing_discrepancies",
            {
                "select": "id",
                "stripe_customer_id": f"eq.{cust_id}",
                "discrepancy_type": f"eq.{d['discrepancy_type']}",
                "resolved": "eq.false",
                "limit": "1",
            },
        )
        if existing:
            continue
        d.update({
            "client_id": client_id,
            "stripe_customer_id": cust_id,
            "stripe_account": account,
            "raw_data": {"customer_name": name, "email": email},
        })
        sb_post("/billing_discrepancies", d)

    return {"disc": disc, "billing": billing}


def sync_account(account: str, dry_run: bool = False, limit: Optional[int] = None) -> dict:
    key = STRIPE_ACCOUNTS.get(account)
    if not key:
        print(f"⚠ No key for {account}")
        return {}

    print(f"\n═══ {account.upper()} ═══", flush=True)
    customers = pull_all_customers(key)
    if limit:
        customers = customers[:limit]
    print(f"  {len(customers)} customers", flush=True)

    stats = {"processed": 0, "matched": 0, "discrepancies": 0, "cash": 0, "errors": 0}

    for i, cust in enumerate(customers, 1):
        try:
            result = process_customer(account, cust, dry_run=dry_run)
            stats["processed"] += 1
            if result["billing"].get("client_id"):
                stats["matched"] += 1
            stats["discrepancies"] += len(result["disc"])
            stats["cash"] += result["billing"]["cash_collected"] or 0
        except Exception as e:
            stats["errors"] += 1
            print(f"  ✗ {cust.get('name') or cust.get('email','?')}: {e}", flush=True)
        if i % 25 == 0:
            print(f"  ...{i}/{len(customers)}", flush=True)
        time.sleep(0.03)

    print(f"  processed:     {stats['processed']}")
    print(f"  matched:       {stats['matched']}")
    print(f"  discrepancies: {stats['discrepancies']}")
    print(f"  errors:        {stats['errors']}")
    print(f"  cash:          ${stats['cash']:,.2f}")
    return stats


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", choices=list(STRIPE_ACCOUNTS.keys()))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, help="Limit customers per account (testing)")
    args = ap.parse_args()

    accounts = [args.account] if args.account else list(STRIPE_ACCOUNTS.keys())
    grand = {"cash": 0, "matched": 0, "processed": 0, "discrepancies": 0, "errors": 0}
    for acct in accounts:
        s = sync_account(acct, dry_run=args.dry_run, limit=args.limit)
        for k in grand:
            grand[k] += s.get(k, 0)

    print("\n" + "═" * 40)
    print(f"TOTAL processed:     {grand['processed']}")
    print(f"TOTAL matched:       {grand['matched']}")
    print(f"TOTAL discrepancies: {grand['discrepancies']}")
    print(f"TOTAL errors:        {grand['errors']}")
    print(f"TOTAL cash:          ${grand['cash']:,.2f}")


if __name__ == "__main__":
    main()
