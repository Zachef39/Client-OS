#!/usr/bin/env node
// Reconcile Supabase clients.is_active with Monday Coach Board groups.
//
// Data model on Monday Coach Board (8896739421):
//   Group "Zach"            → active clients coached by Zach              → is_active=true
//   Group "Bloodwork Only"  → paying bloodwork-only clients                → is_active=true
//   Group "Paused Clients"  → temporarily paused                            → is_active=false
//   Group "Expired"         → contract ended / fell off                    → is_active=false
//
// Any group not in the maps above is left untouched with a warning
// so we notice new coach-arrangement groups instead of guessing.
//
// Rules:
//   - Read-only against Monday.
//   - Idempotent — safe to re-run.
//   - Only flips is_active based on the group mapping. Everything else is untouched.
//   - Skips clients flagged is_internal (Zach Faerber, JJ Crawford, Julia Borba, etc.)
//     because those rows are intentional and unrelated to Monday state.
//   - Skips clients with a "terminal" client_status (left_trainerize/left/removed)
//     even if Monday still shows them in an active group — the coach flag wins.
//   - Deactivation (Paused/Expired → is_active=false) accepts id OR name matches.
//   - Reactivation (Zach/Bloodwork Only → is_active=true) requires a monday_item_id
//     match. Name-only matches are refused to avoid resurrecting stale duplicate rows
//     (e.g. "Ghavier Robinson" exists twice — old row was manually deactivated).
//
// Usage:
//   node scripts/sync-client-status.mjs
//   node scripts/sync-client-status.mjs --dry-run
//
// Suggested cron (nightly at 5:00 AM, right before sync-programmed-to at 5:15):
//   0 5 * * * cd /Users/zachef/Desktop/Playground\ -\ Claude/scripts/faerber-client-os && /usr/local/bin/node scripts/sync-client-status.mjs >> ~/Library/Logs/faerber-client-status.log 2>&1

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/.env' });
dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/.env' });

const SUPABASE_URL = 'https://sfuvqaoeuajsrvldoiek.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U';
const COACH_BOARD_ID = '8896739421';

const ACTIVE_GROUPS = new Set(['Zach', 'Bloodwork Only']);
const INACTIVE_GROUPS = new Set(['Paused Clients', 'Expired']);

// If client_status is one of these, never re-activate — coach has intentionally
// marked them as done. Deactivation is still allowed.
const TERMINAL_STATUSES = new Set(['left_trainerize', 'left', 'removed']);

const DRY_RUN = process.argv.includes('--dry-run');
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
              id
              name
              group { id title }
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

function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function main() {
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] fetching Monday Coach Board items...`);
  const items = await fetchCoachBoardItems();
  console.log(`  → ${items.length} items on board`);

  // Build a map: monday_item_id → { desired_active, group_title }
  // and byName as fallback.
  const byMondayId = new Map();
  const byName = new Map();
  const unknownGroups = new Map();

  for (const it of items) {
    const groupTitle = it.group?.title || '(none)';
    let desiredActive = null; // null = leave untouched
    if (ACTIVE_GROUPS.has(groupTitle)) desiredActive = true;
    else if (INACTIVE_GROUPS.has(groupTitle)) desiredActive = false;
    else {
      unknownGroups.set(groupTitle, (unknownGroups.get(groupTitle) || 0) + 1);
    }
    const rec = { desiredActive, groupTitle };
    byMondayId.set(String(it.id), rec);
    const key = normalizeName(it.name);
    // Prefer active-group record when name collides across groups.
    if (!byName.has(key) || (desiredActive === true && byName.get(key).desiredActive !== true)) {
      byName.set(key, rec);
    }
  }

  if (unknownGroups.size > 0) {
    console.log(`  ! unknown group(s) (left untouched):`);
    for (const [g, n] of unknownGroups.entries()) {
      console.log(`    - "${g}" (${n} item${n === 1 ? '' : 's'})`);
    }
  }

  // Before snapshot — active count.
  const { count: beforeActive, error: bErr } = await supabase
    .from('clients')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);
  if (bErr) throw bErr;

  // Load all Supabase clients (both active and inactive so we can flip either way).
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, full_name, monday_item_id, is_active, is_internal, client_status, potential_duplicate_of');
  if (error) throw error;

  const updates = [];
  const stats = {
    matched_by_id: 0,
    matched_by_name: 0,
    unmatched: [],
    skipped_internal: 0,
    skipped_terminal_status: [],
    skipped_duplicate: 0,
    skipped_no_change: 0,
    skipped_unknown_group: 0,
    skipped_name_only_reactivate: [],
    to_activate: [],
    to_deactivate: [],
  };

  for (const c of clients) {
    if (c.is_internal) { stats.skipped_internal += 1; continue; }
    if (c.potential_duplicate_of) { stats.skipped_duplicate += 1; continue; }

    let rec = null;
    let matchedById = false;
    if (c.monday_item_id && byMondayId.has(String(c.monday_item_id))) {
      rec = byMondayId.get(String(c.monday_item_id));
      matchedById = true;
      stats.matched_by_id += 1;
    } else {
      const key = normalizeName(c.full_name);
      if (byName.has(key)) {
        rec = byName.get(key);
        stats.matched_by_name += 1;
      } else {
        stats.unmatched.push(c.full_name);
        continue;
      }
    }

    if (rec.desiredActive === null) {
      stats.skipped_unknown_group += 1;
      continue;
    }
    if (rec.desiredActive === c.is_active) {
      stats.skipped_no_change += 1;
      continue;
    }

    // Terminal status wins — never re-activate a coach-marked-done client.
    if (rec.desiredActive === true && TERMINAL_STATUSES.has(c.client_status)) {
      stats.skipped_terminal_status.push(`${c.full_name} (${c.client_status})`);
      continue;
    }
    // Refuse to reactivate on a name-only match (risk of resurrecting a stale
    // duplicate row where the newer row is the real active one).
    if (rec.desiredActive === true && !matchedById) {
      stats.skipped_name_only_reactivate.push(c.full_name);
      continue;
    }

    updates.push({ id: c.id, is_active: rec.desiredActive, name: c.full_name, group: rec.groupTitle });
    if (rec.desiredActive) stats.to_activate.push(c.full_name);
    else stats.to_deactivate.push(c.full_name);
  }

  console.log(`  → matches: ${stats.matched_by_id} by id · ${stats.matched_by_name} by name · ${stats.unmatched.length} unmatched · ${stats.skipped_internal} internal · ${stats.skipped_duplicate} dupes`);
  if (stats.unmatched.length) {
    console.log(`  → unmatched (up to 20):`, stats.unmatched.slice(0, 20));
  }
  console.log(`  → active before: ${beforeActive}`);
  console.log(`  → planned flips: ${stats.to_deactivate.length} to deactivate, ${stats.to_activate.length} to reactivate`);
  if (stats.to_deactivate.length) {
    console.log(`    deactivate:`, stats.to_deactivate);
  }
  if (stats.to_activate.length) {
    console.log(`    reactivate:`, stats.to_activate);
  }
  if (stats.skipped_terminal_status.length) {
    console.log(`  → skipped (terminal client_status, refused reactivation):`, stats.skipped_terminal_status);
  }
  if (stats.skipped_name_only_reactivate.length) {
    console.log(`  → skipped (name-only match, refused reactivation):`, stats.skipped_name_only_reactivate);
  }
  console.log(`  → no-op (already correct): ${stats.skipped_no_change}`);

  if (DRY_RUN) {
    console.log(`[${new Date().toISOString()}] DRY RUN — no writes.`);
    process.exit(0);
  }

  // Apply.
  let ok = 0;
  let failed = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from('clients')
      .update({ is_active: u.is_active })
      .eq('id', u.id);
    if (upErr) {
      failed += 1;
      console.error(`  ! ${u.name} (${u.id}) failed:`, upErr.message);
    } else {
      ok += 1;
    }
  }

  const { count: afterActive } = await supabase
    .from('clients')
    .select('*', { count: 'exact', head: true })
    .eq('is_active', true);

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[${new Date().toISOString()}] done — ${ok} updated · ${failed} failed · active ${beforeActive} → ${afterActive} · ${elapsed}s`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] fatal:`, e.message);
  process.exit(1);
});
