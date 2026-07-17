#!/usr/bin/env node
// Fill empty `Lost Reason` dropdown values on the Booked Calls board (18372257888).
//
// For every item where the outcome is a "lost" outcome AND lost_reason is empty,
// this script:
//   1. pulls the Monday item's Updates (via GraphQL, not MCP)
//   2. looks up any cached Fathom call summary in Supabase `client_calls`
//   3. asks Sonnet to pick ONE existing dropdown label (or "Other" w/ a short reason)
//   4. writes the label back via `change_column_value` (unless --dry-run)
//
// Usage:
//   node scripts/fill-lost-reasons.mjs --dry-run --limit 5
//   node scripts/fill-lost-reasons.mjs --limit 20
//   node scripts/fill-lost-reasons.mjs
//
// Env (loaded from ~/Desktop/Playground - Claude/.env):
//   MONDAY_API_TOKEN
//   ANTHROPIC_API_KEY

import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import os from 'os';

dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/.env' });
dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/.env' });

// ── Config ──────────────────────────────────────────────
const BOARD_ID = '18372257888';
const LOST_REASON_COL = 'dropdown_mm2qma67';
const OUTCOME_COL = 'status';
const OUTCOME_NOTES_COL = 'text_mkq7r20t';
const NAME_COL = null; // uses item.name

const SUPABASE_URL = 'https://sfuvqaoeuajsrvldoiek.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U';

// Outcomes that count as "lost" — every one of these should have a lost_reason.
const LOST_OUTCOMES = new Set([
  'Unsuccessful',
  'Needs Rebooking',
  'No Show',
  'DQ',
  'Canceled',
  'Nurture',
]);

const LOG_PATH = path.join(os.homedir(), 'Library/Logs/faerber-lost-reason-fill.log');
const MONDAY_API = 'https://api.monday.com/v2';
const CONFIDENCE_MIN = 0.5;

// ── CLI args ────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(args[limitIdx + 1]) : Infinity;

// ── Helpers ─────────────────────────────────────────────
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function appendLog(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.appendFileSync(LOG_PATH, stamped);
  } catch (e) {
    // If log dir doesn't exist yet, best-effort mkdir once then retry.
    try {
      fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
      fs.appendFileSync(LOG_PATH, stamped);
    } catch { /* ignore */ }
  }
  process.stdout.write(stamped);
}

async function mondayQuery(query, variables = null) {
  const token = requireEnv('MONDAY_API_TOKEN');
  const body = variables ? { query, variables } : { query };
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json', 'API-Version': '2024-01' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Monday ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Monday errors: ${JSON.stringify(json.errors)}`);
  return json;
}

function pickCol(item, cid) {
  for (const c of item.column_values || []) {
    if (c.id === cid) return c.text || '';
  }
  return '';
}

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ── Load Lost Reason dropdown labels (live) ─────────────
async function loadLostReasonLabels() {
  const q = `{ boards(ids:[${BOARD_ID}]) { columns(ids:["${LOST_REASON_COL}"]) { id title type settings_str } } }`;
  const data = await mondayQuery(q);
  const col = data.data?.boards?.[0]?.columns?.[0];
  if (!col) throw new Error('Lost Reason column not found');
  const settings = JSON.parse(col.settings_str || '{}');
  const labels = (settings.labels || [])
    .filter(l => !(settings.deactivated_labels || []).includes(l.id))
    .map(l => l.name);
  return labels;
}

// ── Fetch candidates ─────────────────────────────────────
async function fetchLostItemsMissingReason() {
  const items = [];
  let cursor = null;
  for (let i = 0; i < 30; i += 1) {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const q = `
      {
        boards(ids: [${BOARD_ID}]) {
          items_page(limit: 200${cursorArg}) {
            cursor
            items {
              id name
              column_values(ids: ["${OUTCOME_COL}","${LOST_REASON_COL}","${OUTCOME_NOTES_COL}"]) { id text value }
            }
          }
        }
      }
    `;
    const data = await mondayQuery(q);
    const page = data.data?.boards?.[0]?.items_page;
    if (!page) break;
    for (const it of page.items || []) {
      const outcome = pickCol(it, OUTCOME_COL);
      const reason = pickCol(it, LOST_REASON_COL);
      const notes = pickCol(it, OUTCOME_NOTES_COL);
      if (LOST_OUTCOMES.has(outcome) && !reason) {
        items.push({ id: it.id, name: it.name, outcome, notes });
      }
    }
    cursor = page.cursor;
    if (!cursor) break;
  }
  return items;
}

// ── Monday Updates ──────────────────────────────────────
async function fetchItemUpdates(itemId) {
  const q = `
    {
      items(ids: [${itemId}]) {
        updates(limit: 10) {
          text_body
          creator { name }
          created_at
        }
      }
    }
  `;
  const data = await mondayQuery(q);
  const updates = data.data?.items?.[0]?.updates || [];
  return updates
    .filter(u => u.text_body && u.text_body.trim())
    .map(u => ({
      author: u.creator?.name || '',
      when: u.created_at,
      body: u.text_body.trim(),
    }));
}

// ── Supabase-cached Fathom calls ────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchFathomForLead(leadName) {
  if (!leadName) return null;
  const norm = leadName.trim();
  // Try direct client match, then case-insensitive.
  const { data: clients } = await supabase
    .from('clients')
    .select('id, full_name')
    .ilike('full_name', norm)
    .limit(2);
  const clientIds = (clients || []).map(c => c.id);
  if (clientIds.length === 0) {
    // Try last-name only fuzzy match — sales leads are often not full clients.
    const parts = norm.split(/\s+/);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const { data: fuzz } = await supabase
        .from('clients')
        .select('id, full_name')
        .ilike('full_name', `%${last}%`)
        .limit(3);
      if (fuzz && fuzz.length === 1) clientIds.push(fuzz[0].id);
    }
  }
  if (clientIds.length === 0) return null;
  const { data: calls } = await supabase
    .from('client_calls')
    .select('call_date, call_type, fathom_url, fathom_summary')
    .in('client_id', clientIds)
    .order('call_date', { ascending: false })
    .limit(3);
  return (calls || []).filter(c => c.fathom_summary || c.fathom_url);
}

// ── Sonnet classifier ───────────────────────────────────
const anthropic = new Anthropic({ apiKey: requireEnv('ANTHROPIC_API_KEY') });

async function classifyLostReason({ leadName, outcome, outcomeNotes, updates, fathomCalls, allowedLabels }) {
  const labelList = allowedLabels.map(l => `- ${l}`).join('\n');
  const updatesBlock = updates.length
    ? updates.map(u => `[${u.when} · ${u.author}] ${u.body}`).join('\n---\n')
    : '(none)';
  const fathomBlock = (fathomCalls || []).length
    ? fathomCalls.map(c => `[${c.call_date} · ${c.call_type}] ${c.fathom_summary || '(no summary — call exists at ' + c.fathom_url + ')'}`).join('\n---\n')
    : '(none)';
  const notesBlock = outcomeNotes ? outcomeNotes : '(none)';

  const sys = `You classify sales-call lost reasons for a fitness coaching business.
You MUST return ONE label from the allowed list — verbatim, character-for-character.
If none of the labels fit, return "Other" and include a short note (<=40 chars).
Return a confidence score 0.0-1.0 reflecting how sure you are.
If you have insufficient info to be at least 0.5 confident, still pick the most likely label but set confidence < 0.5.
Respond ONLY with valid JSON — no prose.

Response schema:
{"label": "<one allowed label>", "note": "<short reason iff label is Other, else empty>", "confidence": <0..1>, "reasoning": "<one sentence>"}`;

  const user = `Allowed labels:
${labelList}

Lead: ${leadName}
Monday outcome: ${outcome}

Monday Outcome Notes column:
${notesBlock}

Monday Updates:
${updatesBlock}

Fathom call summaries:
${fathomBlock}

Pick the best-fit label now.`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content?.[0]?.text || '';
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error(`Sonnet returned non-JSON: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(s, e + 1));
}

// ── Monday write ────────────────────────────────────────
async function writeLostReason(itemId, label) {
  // Dropdown col: value is `{"labels":["Label Name"]}` per Monday docs.
  const value = JSON.stringify({ labels: [label] });
  const q = `
    mutation ($board: ID!, $item: ID!, $col: String!, $val: JSON!) {
      change_column_value(board_id: $board, item_id: $item, column_id: $col, value: $val) {
        id
      }
    }
  `;
  const variables = {
    board: BOARD_ID,
    item: String(itemId),
    col: LOST_REASON_COL,
    val: value,
  };
  const data = await mondayQuery(q, variables);
  if (!data.data?.change_column_value?.id) {
    throw new Error(`Monday write returned no id: ${JSON.stringify(data)}`);
  }
}

// ── Main ────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  appendLog(`=== fill-lost-reasons run START · dry=${DRY_RUN} · limit=${LIMIT === Infinity ? 'all' : LIMIT} ===`);

  const allowedLabels = await loadLostReasonLabels();
  appendLog(`allowed labels: ${allowedLabels.join(' | ')}`);

  const candidates = await fetchLostItemsMissingReason();
  // Sort newest-first (higher item id = more recent) so we start with items that
  // most likely have Updates and Fathom evidence.
  candidates.sort((a, b) => Number(b.id) - Number(a.id));
  appendLog(`candidates: ${candidates.length} items with lost outcome + empty lost_reason (newest-first)`);

  const stats = { updated: 0, skipped_low_conf: 0, no_source: 0, errors: 0, total: 0 };
  const slice = candidates.slice(0, LIMIT);

  for (const item of slice) {
    stats.total += 1;
    try {
      const [updates, fathomCalls] = await Promise.all([
        fetchItemUpdates(item.id).catch(err => { appendLog(`  ! updates fetch failed for ${item.id}: ${err.message}`); return []; }),
        fetchFathomForLead(item.name).catch(err => { appendLog(`  ! fathom lookup failed for ${item.name}: ${err.message}`); return []; }),
      ]);

      const outcomeNotes = (item.notes || '').trim();
      const hasSource = updates.length > 0 || (fathomCalls || []).length > 0 || outcomeNotes.length > 0;
      if (!hasSource) {
        stats.no_source += 1;
        appendLog(`- ${item.name} (${item.id}) [${item.outcome}] → NO SOURCE (no updates, no fathom, no notes)`);
        continue;
      }

      const result = await classifyLostReason({
        leadName: item.name,
        outcome: item.outcome,
        outcomeNotes,
        updates,
        fathomCalls: fathomCalls || [],
        allowedLabels,
      });

      const source = [];
      if (outcomeNotes) source.push('notes');
      if (updates.length) source.push(`monday(${updates.length})`);
      if ((fathomCalls || []).length) source.push(`fathom(${fathomCalls.length})`);
      const sourceStr = source.join('+');

      if (typeof result.confidence !== 'number' || result.confidence < CONFIDENCE_MIN) {
        stats.skipped_low_conf += 1;
        appendLog(`SKIP low-conf · ${item.name} (${item.id}) [${item.outcome}] · conf=${result.confidence} · pick=${result.label} · src=${sourceStr} · reason=${result.reasoning}`);
        continue;
      }
      if (!allowedLabels.includes(result.label)) {
        stats.errors += 1;
        appendLog(`SKIP bad-label · ${item.name} (${item.id}) · Sonnet returned "${result.label}" not in allowed list`);
        continue;
      }

      const finalLabel = result.label === 'Other' && result.note
        ? 'Other' // dropdown label stays "Other" — the note goes into log only (Monday dropdown can't hold ad-hoc text)
        : result.label;

      if (DRY_RUN) {
        appendLog(`DRY · ${item.name} (${item.id}) [${item.outcome}] · WOULD-SET="${finalLabel}"${result.note ? ` (note: ${result.note})` : ''} · conf=${result.confidence} · src=${sourceStr} · reason=${result.reasoning}`);
      } else {
        await writeLostReason(item.id, finalLabel);
        stats.updated += 1;
        appendLog(`SET · ${item.name} (${item.id}) [${item.outcome}] · before=(empty) → after="${finalLabel}"${result.note ? ` (note: ${result.note})` : ''} · conf=${result.confidence} · src=${sourceStr}`);
      }
    } catch (err) {
      stats.errors += 1;
      appendLog(`ERROR · ${item.name} (${item.id}): ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  appendLog(`=== done · updated=${stats.updated} · skipped_low_conf=${stats.skipped_low_conf} · no_source=${stats.no_source} · errors=${stats.errors} · total=${stats.total} · ${elapsed}s ===`);
  process.exit(stats.errors > 0 && stats.updated === 0 ? 1 : 0);
}

main().catch(e => {
  appendLog(`FATAL: ${e.message}\n${e.stack}`);
  process.exit(1);
});
