#!/usr/bin/env python3
"""
Add a coach to-do via the dashboard API.

Usage:
  add_todo.py <client_name> <category> <note...>
  add_todo.py "Ilona Goykhman" workout "Wants 2 upper days, deflate look. Day 4 swapped 6/9."
  add_todo.py "Kaitlyn" call "Schedule mid-program review w/ bloods context"
  add_todo.py "Matt Bruhn" calorie "Cut to 1800, 160g protein floor"
  add_todo.py --list                       # show all open
  add_todo.py --list --client "Ilona"      # filter

Categories: calorie, workout, mealplan, call, bloodwork, check-in, other
"""
import argparse
import json
import sys
import urllib.request
import urllib.parse

API = "http://localhost:3737/api/todos"
CATEGORIES = ["calorie", "workout", "mealplan", "call", "bloodwork", "check-in", "other"]


def api_get(path, params=None):
    url = f"http://localhost:3737{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url) as r:
        return json.loads(r.read().decode())


def api_post(path, body):
    url = f"http://localhost:3737{path}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read().decode())


def list_todos(client=None):
    params = {"status": "open"}
    if client:
        params["client"] = client
    data = api_get("/api/todos", params)
    todos = data.get("todos", [])
    if not todos:
        print("No open to-dos." + (f" (filter: {client})" if client else ""))
        return
    by_client = {}
    for t in todos:
        by_client.setdefault(t["client_name"], []).append(t)
    for name, items in by_client.items():
        print(f"\n— {name} ({len(items)})")
        for t in items:
            cat = t["category"]
            note = t["note"].replace("\n", " | ")
            print(f"  [{cat:<10}] {note[:120]}")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--list", action="store_true", help="list open to-dos")
    p.add_argument("--client", help="filter list by client")
    p.add_argument("--category", help="category override")
    p.add_argument("--source", default="chat", help="source tag (default: chat)")
    p.add_argument("--priority", default="normal", choices=["low", "normal", "high", "urgent"])
    p.add_argument("args", nargs="*", help="<client> <category> <note...>")
    a = p.parse_args()

    if a.list:
        list_todos(a.client)
        return

    if len(a.args) < 3:
        print(__doc__)
        sys.exit(1)

    client_name = a.args[0]
    category = a.args[1]
    note = " ".join(a.args[2:])

    if category not in CATEGORIES:
        print(f"Bad category: {category}. Must be one of {CATEGORIES}", file=sys.stderr)
        sys.exit(1)

    res = api_post(
        "/api/todos",
        {
            "client_name": client_name,
            "category": category,
            "note": note,
            "source": a.source,
            "priority": a.priority,
        },
    )
    t = res.get("todo", {})
    print(f"✓ Added [{t.get('category')}] to-do for {t.get('client_name')}")
    print(f"  note: {t.get('note')[:120]}")
    print(f"  id:   {t.get('id')}")


if __name__ == "__main__":
    main()
