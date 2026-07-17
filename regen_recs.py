#!/usr/bin/env python3
"""Regenerate recommendations for all active clients (skip Trainerize pull)."""
import time
from lib import supabase_client, generate_recs_for_client

supabase = supabase_client()
clients = supabase.table("clients").select("*").eq("is_active", True).order("full_name").execute().data

print(f"Regenerating recs for {len(clients)} clients...\n")
total = 0
for i, c in enumerate(clients, 1):
    t0 = time.time()
    try:
        n = generate_recs_for_client(supabase, c)
        total += n
        print(f"  [{i:2d}/{len(clients)}] {c['full_name']:30s}  {n} recs  ({time.time()-t0:.1f}s)")
    except Exception as e:
        print(f"  [{i:2d}/{len(clients)}] ❌ {c['full_name']:30s}  {e}")

print(f"\n✅ {total} recommendations written")
