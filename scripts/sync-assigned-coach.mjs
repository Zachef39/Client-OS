#!/usr/bin/env node
// Pull Monday Coach Board `Coach` person column + Clients board `Program` dropdown,
// upsert into Supabase clients.assigned_coach + clients.program_dropdown.
//
// ─────────────────────────────────────────────────────────────────────
// COACH SOURCE-OF-TRUTH NOTE (2026-07-17):
//   The Coach Board `Coach` column (multiple_person_mkpv7h8c) is currently set
//   to "Zach Faerber" on every active client — not actually used to distribute
//   assignments.
//
//   The Clients Board `Coach` column (id "person") IS being used and has
//   distinct values (Zach Faerber / Candice kraus / JJ Crawford). We now
//   prefer that column when available, falling back to Coach Board only when
//   the Clients Board coach is empty.
//
//   Data-model limitation still worth flagging: since the two boards are
//   linked via a board_relation, ownership is duplicated across sources and
//   can drift. Long-term fix would be to standardize on one column of truth.
// ─────────────────────────────────────────────────────────────────────
//
// Matching order:
//   1. monday_item_id (Coach Board pulse id) — most reliable.
//   2. Full name (normalized case + whitespace).
//   3. First name + last initial (handles "Adelaide" vs "Adelaide Caraceni",
//      "Matt Bruhn" vs "Matthew Bruhn", etc.).
//
// Rules:
//   - Never overwrite existing assigned_coach (only fills NULLs).
//   - Backfills monday_item_id when found by name.
//   - Normalizes coach names: "Candice kraus" → "Candice", "Zach Faerber" → "Zach".
//
// Usage:
//   node scripts/sync-assigned-coach.mjs
//
// Env:
//   MONDAY_API_TOKEN — from /Users/zachef/Desktop/Playground - Claude/.env

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/.env' });
dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/.env' });

const SUPABASE_URL = 'https://sfuvqaoeuajsrvldoiek.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U';
const COACH_BOARD_ID = '8896739421';
const CLIENTS_BOARD_ID = '8868569588';
const COACH_COL = 'multiple_person_mkpv7h8c';          // Coach Board — legacy, all "Zach"
const CLIENTS_COACH_COL = 'person';                    // Clients Board — real assignments
const PROGRAM_COL = 'dropdown_mkpq36f8';
// Clients Board → Coach Board relation column. Coach Board's reverse relation is empty
// in this workspace, so we walk from the Clients side.
const CONNECT_COACH_COL = 'board_relation_mkpzghv';

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

async function fetchBoardItems(boardId, columnIds) {
  const items = [];
  let cursor = null;
  const idsArg = columnIds.map(c => `"${c}"`).join(', ');
  for (let i = 0; i < 30; i += 1) {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const q = `
      {
        boards(ids: [${boardId}]) {
          items_page(limit: 200${cursorArg}) {
            cursor
            items {
              id name
              column_values(ids: [${idsArg}]) { id text value }
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

function pickColValue(item, colId) {
  for (const c of item.column_values || []) {
    if (c.id === colId) return c.value || '';
  }
  return '';
}

function normalizeName(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Normalize coach display: "Zach Faerber" → "Zach", "Candice kraus" → "Candice".
// Empty/whitespace becomes null (unassigned).
function normalizeCoach(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  // Common name normalization (case-preserved from Monday but standardized).
  const canonical = {
    zach: 'Zach',
    candice: 'Candice',
    jj: 'JJ',
    daniel: 'Daniel',
    spencer: 'Spencer',
  };
  return canonical[first.toLowerCase()] || first;
}

// Build a first-name + last-initial key like "matt b" from "Matt Bruhn"
// so it matches "Matthew Bruhn" (which becomes "matthew b" → also "matt b" via first-3-char).
function nameKeys(fullName) {
  const norm = normalizeName(fullName);
  if (!norm) return [];
  const parts = norm.split(' ').filter(Boolean);
  const keys = new Set([norm]);
  if (parts.length >= 2) {
    // First name + last name (drops middle names).
    keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
    // First 4 chars of first name + last name initial. Handles Matt/Matthew, Bob/Robert (won't help), Liz/Elizabeth (won't help either but cheap).
    keys.add(`${parts[0].slice(0, 4)} ${parts[parts.length - 1][0]}`);
  } else {
    // Single-word name like "Adelaide" — key by first word only for prefix matching.
    keys.add(parts[0]);
  }
  return Array.from(keys);
}

// Manual name-alias overrides where fuzzy matching would fail.
// Left = Supabase full_name, right = Monday item name on Coach Board.
const NAME_ALIASES = {
  'adelaide caraceni': 'adelaide',
  'ayesha smith': 'ayesha (esshhha_boo2.0)',
  'cathy bedwell': 'cathy sheila 🥂',
  'cee jay': 'cee',
  'cheryl bayman': 'cheryl williams bayman',
  'christine peralta': 'christine (mira)',
  'christine axer': 'kiki axer',
  'kellyann hage': 'kelly ann',
  'lillith bear': 'lillith fields bear',
  'liz simon': 'elizabeth simon',
  'marcus thames': 'marcus - alex husband',
  'matthew bruhn': 'matt bruhn',
  'robert merker': 'bob merker',
  'talitha sherrod': 'talitha p sherade - 45 call',
  'yvette nabayan': 'yvette nicole nabayan',
  'kennedy bynum': 'kennedy bynum',
  'bridget rebro': 'bridget mckenzie',
};

async function main() {
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] fetching Monday Coach Board...`);
  const coachItems = await fetchBoardItems(COACH_BOARD_ID, [COACH_COL]);
  console.log(`  → ${coachItems.length} Coach Board items`);

  console.log(`[${new Date().toISOString()}] fetching Monday Clients Board (Program + Coach + link)...`);
  const clientsBoardItems = await fetchBoardItems(
    CLIENTS_BOARD_ID,
    [PROGRAM_COL, CLIENTS_COACH_COL, CONNECT_COACH_COL],
  );
  console.log(`  → ${clientsBoardItems.length} Clients Board items`);

  // Build maps keyed by Coach Board pulse id (via link) AND by normalized name.
  // Each entry holds { program, clientsBoardCoach } — the coach value on the
  // Clients Board's `person` column is the real assignment source of truth.
  const clientsInfoByCoachId = new Map();   // coach board id → { program, clientsBoardCoach }
  const clientsInfoByName = new Map();      // norm name → { program, clientsBoardCoach } (fallback)
  for (const it of clientsBoardItems) {
    const prog = pickCol(it, PROGRAM_COL) || null;
    const clientsBoardCoach = normalizeCoach(pickCol(it, CLIENTS_COACH_COL));
    if (!prog && !clientsBoardCoach) continue;
    const info = { program: prog, clientsBoardCoach };
    // Name-key fallback so Coach Board items w/o link still get info.
    clientsInfoByName.set(normalizeName(it.name), info);
    const rawValue = pickColValue(it, CONNECT_COACH_COL);
    if (rawValue) {
      try {
        const parsed = JSON.parse(rawValue);
        const linked = parsed.linkedPulseIds || [];
        for (const l of linked) {
          const id = String(l.linkedPulseId || l.id || '');
          if (id) clientsInfoByCoachId.set(id, info);
        }
      } catch (_) { /* skip */ }
    }
  }
  const linkedCount = clientsInfoByCoachId.size;
  const coachAssignedCount = Array.from(clientsInfoByName.values()).filter(v => v.clientsBoardCoach).length;
  console.log(`  → ${linkedCount} Clients-Board records linked via relation · ${clientsInfoByName.size} via name · ${coachAssignedCount} have Clients-Board coach set`);

  function resolveInfoForCoachItem(coachItem) {
    const byId = clientsInfoByCoachId.get(String(coachItem.id));
    if (byId) return byId;
    for (const k of nameKeys(coachItem.name)) {
      if (clientsInfoByName.has(k)) return clientsInfoByName.get(k);
    }
    return null;
  }

  // Build maps keyed by (a) monday item id and (b) all name keys.
  const byMondayId = new Map();      // id → { coach, program }
  const byName = new Map();          // name key → { coach, program, mondayId }
  let withCoach = 0;

  for (const it of coachItems) {
    const coachBoardCoach = normalizeCoach(pickCol(it, COACH_COL));
    const info = resolveInfoForCoachItem(it);
    // Prefer Clients Board coach when set (it distributes across Candice/JJ/etc.),
    // otherwise fall back to Coach Board column value (usually just "Zach").
    const coach = info?.clientsBoardCoach || coachBoardCoach;
    const program = info?.program || null;
    const rec = { coach, program, mondayId: String(it.id), rawName: it.name };
    byMondayId.set(String(it.id), rec);
    if (coach) withCoach += 1;
    for (const k of nameKeys(it.name)) {
      // Don't overwrite if we already have a name collision — first Coach Board item
      // (top of board = active Zach group) wins over later Paused/Expired dupes.
      if (!byName.has(k)) byName.set(k, rec);
    }
  }
  console.log(`  → ${withCoach} coach items have a Coach value`);

  // Load Supabase clients.
  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, full_name, monday_item_id, assigned_coach, program_dropdown')
    .eq('is_active', true);
  if (error) throw error;
  console.log(`  → ${clients.length} active Supabase clients`);

  // Match + build updates.
  const updates = [];
  const stats = {
    matched_by_id: 0,
    matched_by_alias: 0,
    matched_by_name: 0,
    unmatched: [],
    coach_filled: 0,
    coach_skipped_existing: 0,
    coach_mismatches: [],  // Existing SB value disagrees with Monday — surfaced but not overwritten
    program_filled: 0,
    monday_id_backfilled: 0,
  };

  for (const c of clients) {
    let rec = null;
    if (c.monday_item_id && byMondayId.has(String(c.monday_item_id))) {
      rec = byMondayId.get(String(c.monday_item_id));
      stats.matched_by_id += 1;
    }
    if (!rec) {
      const nameNorm = normalizeName(c.full_name);
      // 1. Manual alias.
      const alias = NAME_ALIASES[nameNorm];
      if (alias && byName.has(alias)) {
        rec = byName.get(alias);
        stats.matched_by_alias += 1;
      } else {
        // 2. Try each computed key against the byName map.
        for (const k of nameKeys(c.full_name)) {
          if (byName.has(k)) {
            rec = byName.get(k);
            stats.matched_by_name += 1;
            break;
          }
        }
      }
    }

    if (!rec) {
      stats.unmatched.push(c.full_name);
      continue;
    }

    const patch = {};
    // Backfill monday_item_id when we discovered a match by name.
    if (!c.monday_item_id && rec.mondayId) {
      patch.monday_item_id = rec.mondayId;
      stats.monday_id_backfilled += 1;
    }
    // Fill assigned_coach only when currently NULL/empty (never overwrite manual edits).
    if ((!c.assigned_coach || String(c.assigned_coach).trim() === '') && rec.coach) {
      patch.assigned_coach = rec.coach;
      stats.coach_filled += 1;
    } else if (c.assigned_coach && rec.coach) {
      stats.coach_skipped_existing += 1;
      // Surface disagreements loudly — someone should manually reconcile.
      if (String(c.assigned_coach).trim() !== String(rec.coach).trim()) {
        stats.coach_mismatches.push({ name: c.full_name, supabase: c.assigned_coach, monday: rec.coach });
      }
    }
    // Fill program_dropdown when currently NULL and program known.
    if (!c.program_dropdown && rec.program) {
      patch.program_dropdown = rec.program;
      stats.program_filled += 1;
    }
    if (Object.keys(patch).length > 0) {
      updates.push({ id: c.id, patch, name: c.full_name });
    }
  }

  console.log(
    `  → matches: ${stats.matched_by_id} by id · ${stats.matched_by_alias} by alias · ` +
    `${stats.matched_by_name} by name · ${stats.unmatched.length} unmatched`
  );
  if (stats.unmatched.length) {
    console.log(`  → unmatched:`, stats.unmatched.slice(0, 20));
  }
  console.log(
    `  → patches: coach=${stats.coach_filled} (skipped ${stats.coach_skipped_existing} manual) · ` +
    `program=${stats.program_filled} · monday_id=${stats.monday_id_backfilled}`
  );
  if (stats.coach_mismatches.length) {
    console.log(`  ! ${stats.coach_mismatches.length} coach mismatch(es) — Supabase kept but Monday disagrees:`);
    for (const m of stats.coach_mismatches) {
      console.log(`    - ${m.name}: SB="${m.supabase}" vs Monday="${m.monday}"`);
    }
    console.log(`    (Manual UPDATE required. Script refuses to overwrite non-NULL assigned_coach.)`);
  }
  console.log(`  → ${updates.length} client(s) need updating`);

  // Apply updates.
  let ok = 0;
  let failed = 0;
  for (const u of updates) {
    const { error: upErr } = await supabase
      .from('clients')
      .update(u.patch)
      .eq('id', u.id);
    if (upErr) {
      failed += 1;
      console.error(`  ! ${u.name} (${u.id}) failed:`, upErr.message);
    } else {
      ok += 1;
    }
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[${new Date().toISOString()}] done — ${ok} updated · ${failed} failed · ${elapsed}s`
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] fatal:`, e.message);
  process.exit(1);
});
