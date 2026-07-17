#!/usr/bin/env node
// Pull Monday Coach Board (8896739421) "Programmed To" dates and upsert into
// Supabase clients.programmed_to. Matches by monday_item_id first, then by
// full_name (case + whitespace insensitive) as a fallback.
//
// Usage:
//   node scripts/sync-programmed-to.mjs
//
// Suggested cron (nightly at 5:15am):
//   15 5 * * * cd /Users/zachef/Desktop/Playground\ -\ Claude/scripts/faerber-client-os && /usr/local/bin/node scripts/sync-programmed-to.mjs >> ~/Library/Logs/faerber-programmed-to.log 2>&1
//
// Env:
//   MONDAY_API_TOKEN — from /Users/zachef/Desktop/Playground - Claude/.env
//   Supabase publishable key — hardcoded (matches server.js).

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/.env' });
dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/.env' });

const SUPABASE_URL = 'https://sfuvqaoeuajsrvldoiek.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U';
const COACH_BOARD_ID = '8896739421';
const PROGRAMMED_TO_COL = 'date_mkqvn4qe';
const STATUS_COL = 'color_mkpv34wt';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function mondayQuery(query) {
  const token = process.env.MONDAY_API_TOKEN || process.env.MONDAY_API_KEY;
  if (!token) throw new Error('MONDAY_API_TOKEN missing from env');
  const res = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Monday ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Monday errors: ${JSON.stringify(json.errors)}`);
  return json;
}

async function fetchCoachBoardItems() {
  const items = [];
  let cursor = null;
  for (let i = 0; i < 30; i += 1) {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const q = `
      {
        boards(ids: [${COACH_BOARD_ID}]) {
          items_page(limit: 200${cursorArg}) {
            cursor
            items {
              id name
              column_values(ids: ["${PROGRAMMED_TO_COL}", "${STATUS_COL}"]) { id text }
            }
          }
        }
      }
    `;
    const data = await mondayQuery(q);
    const page = data.data?.boards?.[0]?.items_page;
    if (!page) break;
    items.push(...(page.items || []));
    cursor = page.cursor;
    if (!cursor) break;
  }
  return items;
}

function pickCol(item, colId) {
  for (const c of item.column_values || []) {
    if (c.id === colId) return c.text || '';
  }
  return '';
}

function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function main() {
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] fetching Monday Coach Board items...`);
  const items = await fetchCoachBoardItems();
  console.log(`  → ${items.length} items on board`);

  // Build Monday map: prefer active (non-Paused/Expired) items when duplicates exist.
  const byMondayId = new Map();
  const byName = new Map();
  let withDate = 0;
  const PAST_STATUSES = new Set(['Paused', 'Expired']);
  for (const it of items) {
    const raw = pickCol(it, PROGRAMMED_TO_COL);
    const status = pickCol(it, STATUS_COL);
    if (PAST_STATUSES.has(status)) continue;
    const dateStr = raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
    if (!dateStr) continue;
    withDate += 1;
    byMondayId.set(String(it.id), dateStr);
    const key = normalizeName(it.name);
    if (key) byName.set(key, dateStr);
  }
  console.log(`  → ${withDate} items with a Programmed To date`);

  // Load all Supabase clients (id, name, monday_item_id).
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, full_name, monday_item_id, programmed_to')
    .eq('is_active', true);
  if (error) throw error;
  console.log(`  → ${clients.length} active Supabase clients`);

  // Match + build updates.
  const updates = [];
  const matched = { by_id: 0, by_name: 0, unmatched: [] };
  for (const c of clients) {
    let newDate = null;
    if (c.monday_item_id && byMondayId.has(String(c.monday_item_id))) {
      newDate = byMondayId.get(String(c.monday_item_id));
      matched.by_id += 1;
    } else {
      const key = normalizeName(c.full_name);
      if (byName.has(key)) {
        newDate = byName.get(key);
        matched.by_name += 1;
      } else {
        matched.unmatched.push(c.full_name);
      }
    }
    // Skip no-ops
    if (newDate && newDate !== c.programmed_to) {
      updates.push({ id: c.id, programmed_to: newDate });
    }
  }
  console.log(`  → matches: ${matched.by_id} by id · ${matched.by_name} by name · ${matched.unmatched.length} unmatched`);
  if (matched.unmatched.length) {
    console.log(`  → unmatched (up to 10):`, matched.unmatched.slice(0, 10));
  }
  console.log(`  → ${updates.length} client(s) need updating`);

  // Apply updates one at a time. Small volume (~140), simpler than bulk.
  let ok = 0;
  let failed = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from('clients')
      .update({ programmed_to: u.programmed_to })
      .eq('id', u.id);
    if (upErr) {
      failed += 1;
      console.error(`  ! ${u.id} failed:`, upErr.message);
    } else {
      ok += 1;
    }
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[${new Date().toISOString()}] done — ${ok} updated · ${failed} failed · ${elapsed}s`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] fatal:`, e.message);
  process.exit(1);
});
