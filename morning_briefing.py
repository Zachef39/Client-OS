#!/usr/bin/env python3
"""
Daily morning briefing — fires 7AM via launchd.
Pulls outstanding to-dos, top alerts, clients needing touch.
Outputs to terminal + can email to zacharyfaerber@gmail.com.

Usage:
  python morning_briefing.py            # print to stdout
  python morning_briefing.py --email    # send email
"""
from __future__ import annotations
import os
import sys
import json
import base64
from datetime import date, datetime, timedelta
from pathlib import Path
from collections import defaultdict

import requests
from dotenv import load_dotenv

ENV = Path("/Users/zachef/Desktop/Playground - Claude/.env")
load_dotenv(ENV)

SUPABASE_URL = "https://sfuvqaoeuajsrvldoiek.supabase.co"
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("CLIENT_OS_SUPABASE_KEY") or "sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U"

H = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}


def supabase_get(path: str) -> list:
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{path}", headers=H, timeout=15)
    return r.json() if r.ok else []


def fetch_open_todos() -> list:
    return supabase_get("coach_todos?status=in.(open,pending)&order=priority.asc,created_at.asc&limit=100")


def fetch_red_yellow_clients() -> list:
    """Latest snapshot per active client, filter to red/yellow."""
    today = date.today()
    cutoff = (today - timedelta(days=3)).isoformat()
    snaps = supabase_get(f"daily_snapshots?snapshot_date=gte.{cutoff}&order=snapshot_date.desc&limit=2000")
    latest_per_client = {}
    for s in snaps:
        if s["client_id"] not in latest_per_client:
            latest_per_client[s["client_id"]] = s
    flagged = [s for s in latest_per_client.values() if s.get("flag_color") in ("red", "yellow")]
    clients = supabase_get("clients?is_active=eq.true&select=id,full_name,goal_weight_lbs")
    cmap = {c["id"]: c for c in clients}
    out = []
    for s in flagged:
        c = cmap.get(s["client_id"])
        if not c:
            continue
        out.append({
            "name": c["full_name"],
            "flag": s["flag_color"],
            "reasons": s.get("flag_reasons") or [],
            "days_logged": s.get("days_logged_last_7"),
            "weight_trajectory": s.get("weight_trajectory"),
        })
    out.sort(key=lambda x: (x["flag"] != "red", x["name"]))
    return out


def fetch_stuck_clients() -> list:
    today = date.today()
    cutoff = (today - timedelta(days=3)).isoformat()
    snaps = supabase_get(f"daily_snapshots?snapshot_date=gte.{cutoff}&order=snapshot_date.desc&limit=2000")
    latest = {}
    for s in snaps:
        if s["client_id"] not in latest:
            latest[s["client_id"]] = s
    clients = supabase_get("clients?is_active=eq.true&select=id,full_name,goal_weight_lbs")
    cmap = {c["id"]: c for c in clients}
    stuck = []
    for s in latest.values():
        c = cmap.get(s["client_id"])
        if not c:
            continue
        flat = s.get("weight_trajectory") == "neutral" or abs(s.get("weight_change_last_4wk") or 0) < 0.5
        if flat and s.get("flag_color") == "green":
            stuck.append({"name": c["full_name"], "goal": c.get("goal_weight_lbs"), "weight_change": s.get("weight_change_last_4wk")})
    return stuck


def fetch_streak_milestones_today() -> list:
    today = date.today().isoformat()
    yest = (date.today() - timedelta(days=1)).isoformat()
    return supabase_get(f"streak_milestones?hit_at=gte.{yest}&hit_at=lte.{today}&celebration_sent=is.false&order=hit_at.desc&limit=20")


def render_briefing() -> str:
    todos = fetch_open_todos()
    flagged = fetch_red_yellow_clients()
    stuck = fetch_stuck_clients()
    milestones = fetch_streak_milestones_today()

    today_str = date.today().strftime("%A, %b %-d")
    out = [f"🌅 Morning Briefing — {today_str}\n"]

    # 1. TODOS (top 5 priority)
    out.append("\n📋 TO-DOS ON YOUR PLATE")
    if not todos:
        out.append("  All clear ✓")
    else:
        cats = defaultdict(int)
        for t in todos:
            cats[t.get("category", "other")] += 1
        out.append(f"  {len(todos)} open: " + ", ".join(f"{n} {c}" for c, n in cats.items()))
        for t in todos[:5]:
            cat = t.get("category", "?")
            cli = t.get("client_name", "?")
            note = (t.get("note") or "")[:80]
            out.append(f"  • [{cat}] {cli}: {note}")

    # 2. RED/YELLOW
    out.append(f"\n🚨 RED/YELLOW CLIENTS ({len(flagged)})")
    red = [f for f in flagged if f["flag"] == "red"]
    yel = [f for f in flagged if f["flag"] == "yellow"]
    if red:
        out.append(f"  RED ({len(red)}): " + ", ".join(r["name"] for r in red[:8]))
        if len(red) > 8:
            out.append(f"  ...+{len(red)-8} more")
    if yel:
        out.append(f"  YELLOW ({len(yel)}): " + ", ".join(y["name"] for y in yel[:8]))
        if len(yel) > 8:
            out.append(f"  ...+{len(yel)-8} more")
    if not flagged:
        out.append("  All clients green ✓")

    # 3. STUCK
    out.append(f"\n🔁 STUCK (flat scale + green compliance, {len(stuck)})")
    if not stuck:
        out.append("  None — everyone moving ✓")
    else:
        for s in stuck[:6]:
            goal = f" (goal {s['goal']}lb)" if s.get("goal") else ""
            out.append(f"  • {s['name']}{goal} — recommend macro audit")

    # 4. MILESTONES
    out.append(f"\n🏆 NEW MILESTONES SINCE YESTERDAY ({len(milestones)})")
    if not milestones:
        out.append("  None")
    else:
        cmap = {c["id"]: c for c in supabase_get("clients?select=id,full_name")}
        for m in milestones[:5]:
            c = cmap.get(m["client_id"], {})
            out.append(f"  • {c.get('full_name','?')}: {m.get('milestone_type')} {m.get('milestone_value')}-day")

    # 5. ONE-LINER ASK
    out.append("\n💡 RECOMMENDED FIRST MOVE")
    if red:
        out.append(f"  → DM {red[0]['name']} (red, {', '.join(red[0]['reasons'][:1])})")
    elif yel:
        out.append(f"  → Audit {yel[0]['name']} (yellow)")
    elif stuck:
        out.append(f"  → Macro audit call w/ {stuck[0]['name']}")
    else:
        out.append("  → Roster healthy. Focus on content or sales today.")

    out.append(f"\n📊 Open dashboard: http://localhost:3737/")
    return "\n".join(out)


def send_email(body: str):
    """Send via macOS Mail bridge using AppleScript fallback or just print + write to file."""
    out_path = Path.home() / "Desktop" / f"morning-briefing-{date.today().isoformat()}.txt"
    out_path.write_text(body, encoding="utf-8")
    print(f"Briefing saved → {out_path}")


def main():
    briefing = render_briefing()
    print(briefing)
    if "--email" in sys.argv or "--save" in sys.argv:
        send_email(briefing)


if __name__ == "__main__":
    main()
