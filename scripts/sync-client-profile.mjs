#!/usr/bin/env node
// Backfill clients.age, clients.location, clients.goal from local intake
// markdown files (faerber-checkin/clients/{,backfill}/*.md).
//
// Why not Trainerize? The public /user/* endpoints do not expose DOB, city,
// state, or free-text goals. Best available source is the hand-crafted intake
// notes coach keeps per client.
//
// Behavior:
//   - Iterates every ACTIVE, non-internal client.
//   - Tries to match one intake .md file by normalized name (also handles
//     "Kelly Ann" → "KellyAnn Hage" style aliases already used elsewhere).
//   - Sends the file to Claude Haiku 4.5 with a strict JSON schema.
//   - Only writes fields that are currently NULL / empty in Supabase — manual
//     coach edits are always preserved.
//
// Rules honored:
//   - Idempotent — re-running produces the same result once fields are filled.
//   - --dry-run to preview extraction without writing.
//   - --client "Name" to backfill a single client for testing.
//   - Rate-limited: 4 concurrent Claude calls.
//
// Usage:
//   node scripts/sync-client-profile.mjs
//   node scripts/sync-client-profile.mjs --dry-run
//   node scripts/sync-client-profile.mjs --client "Adora"
//
// Suggested cron (weekly Sunday 4:00 AM — intake files rarely change):
//   0 4 * * 0 cd /Users/zachef/Desktop/Playground\ -\ Claude/scripts/faerber-client-os && /usr/local/bin/node scripts/sync-client-profile.mjs >> ~/Library/Logs/faerber-client-profile.log 2>&1

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/.env' });
dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/.env' });

const SUPABASE_URL = 'https://sfuvqaoeuajsrvldoiek.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U';

const INTAKE_DIRS = [
  '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/clients/backfill',
  '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/clients',
];

// Fix the double-prefix that sometimes shows up in the env file.
if (process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-sk-ant-')) {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY.slice(7);
}

const CLAUDE_MODEL = 'claude-haiku-4-5';
const MAX_CONCURRENCY = 4;
const DRY_RUN = process.argv.includes('--dry-run');
const clientArgIdx = process.argv.indexOf('--client');
const CLIENT_FILTER = clientArgIdx >= 0 ? String(process.argv[clientArgIdx + 1] || '').toLowerCase() : null;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Manual aliases where filename → client full_name does not fuzzy-match.
// Mirrors the existing extract_goals_from_intake_md.py aliases.
const NAME_ALIASES = new Map([
  ['kelly ann', 'kellyann hage'],
  ['liz simon', 'elizabeth simon'],
  ['matt bruhn', 'matthew bruhn'],
  ['bob merker', 'robert merker'],
]);

function normalizeName(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fileKeyToName(filename) {
  return normalizeName(filename.replace(/\.md$/i, '').replace(/-/g, ' '));
}

async function buildIntakeIndex() {
  // filename-key (normalized) → { path, size }
  const index = new Map();
  for (const dir of INTAKE_DIRS) {
    let entries;
    try {
      entries = await readdir(dir);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      if (entry.startsWith('_')) continue; // skip _review-*, _batch-* helpers
      // Skip aggregate/report files by shape.
      if (/-\d{4}-\d{2}-\d{2}\.md$/.test(entry)) continue;
      if (/^(food-|green-|next-|all-messages)/i.test(entry)) continue;
      const fullPath = path.join(dir, entry);
      const st = await stat(fullPath);
      if (!st.isFile()) continue;
      // Prefer backfill/ over top-level clients/ (first hit wins).
      const key = fileKeyToName(entry);
      if (!index.has(key)) index.set(key, { path: fullPath, size: st.size });
    }
  }
  return index;
}

function candidateKeys(fullName) {
  const norm = normalizeName(fullName);
  const parts = norm.split(' ').filter(Boolean);
  const keys = new Set([norm]);
  if (parts.length >= 2) {
    keys.add(`${parts[0]} ${parts[parts.length - 1]}`);
    // Handle "New Phase 2" appended variants like pamela-gorin-new-phase-2.md
    keys.add(`${parts[0]} ${parts[parts.length - 1]} new phase 2`);
  }
  const alias = NAME_ALIASES.get(norm);
  if (alias) keys.add(alias);
  return Array.from(keys);
}

function matchIntakeFile(fullName, intakeIndex) {
  for (const k of candidateKeys(fullName)) {
    if (intakeIndex.has(k)) return intakeIndex.get(k);
  }
  return null;
}

const EXTRACT_PROMPT_HEADER = `You extract structured client profile fields from a coach's private intake notes. Return ONLY valid JSON, no prose.

Schema:
{
  "age": <int 18-90 or null>,
  "location": "<City, ST or City, Country or null — plain string, no extra words>",
  "goal": "<short 1-line goal statement or null — 3-14 words max, action-oriented>"
}

Rules:
- age: only if EXPLICITLY stated as a number. "Not provided" → null. Age ranges → midpoint (int).
- location: only if a real place is written. "Not provided" → null. Trim to "City, ST" or "City, Country". No zip codes. No neighborhood detail.
- goal: distill the client's primary goal into one short phrase. Use their words when possible.
  - Good: "Lose 30 lbs by January birthday"
  - Good: "Build strength + drop 15 lbs pre-wedding"
  - Bad: "Weight loss" (too vague)
  - Bad: full paragraph (too long)
- If a field cannot be confidently extracted from the note, use null. Never guess.

Return ONLY the JSON object.`;

function buildPrompt(name, content) {
  return `${EXTRACT_PROMPT_HEADER}

Client name: ${name}

--- INTAKE NOTES ---
${content.slice(0, 20000)}
--- END NOTES ---`;
}

function parseJson(raw) {
  const trimmed = String(raw || '').trim();
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function sanitize(extract) {
  const out = { age: null, location: null, goal: null };
  if (extract && typeof extract === 'object') {
    if (Number.isInteger(extract.age) && extract.age >= 18 && extract.age <= 90) {
      out.age = extract.age;
    }
    if (typeof extract.location === 'string') {
      const loc = extract.location.trim();
      if (loc && loc.toLowerCase() !== 'null' && loc.length < 100) out.location = loc;
    }
    if (typeof extract.goal === 'string') {
      const g = extract.goal.trim();
      if (g && g.toLowerCase() !== 'null' && g.length < 200) out.goal = g;
    }
  }
  return out;
}

async function extractFromFile(name, filePath) {
  const content = await readFile(filePath, 'utf8');
  if (!content.trim()) return { age: null, location: null, goal: null };
  const res = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: buildPrompt(name, content) }],
  });
  const text = res.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
  return sanitize(parseJson(text));
}

// Basic p-limit style pool without pulling in another dep.
async function mapWithConcurrency(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  async function next() {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return out;
}

async function main() {
  const started = Date.now();
  console.log(`[${new Date().toISOString()}] indexing intake files...`);
  const intakeIndex = await buildIntakeIndex();
  console.log(`  → ${intakeIndex.size} unique intake files`);

  const { data: clients, error } = await supabase
    .from('clients')
    .select('id, full_name, age, location, goal, is_internal, is_active')
    .eq('is_active', true);
  if (error) throw error;

  const before = {
    with_age: clients.filter(c => c.age != null).length,
    with_location: clients.filter(c => c.location && c.location.trim()).length,
    with_goal: clients.filter(c => c.goal && c.goal.trim()).length,
    total: clients.length,
  };
  console.log(`  → ${clients.length} active clients — before: age=${before.with_age}, location=${before.with_location}, goal=${before.with_goal}`);

  // Filter to clients that:
  //   (a) are not internal
  //   (b) are missing at least one target field
  //   (c) have an intake file to read
  //   (d) match --client filter if provided
  const targets = [];
  const skippedNoFile = [];
  for (const c of clients) {
    if (c.is_internal) continue;
    const missingAny = c.age == null || !c.location || !c.goal;
    if (!missingAny) continue;
    if (CLIENT_FILTER && !c.full_name.toLowerCase().includes(CLIENT_FILTER)) continue;
    const file = matchIntakeFile(c.full_name, intakeIndex);
    if (!file) {
      skippedNoFile.push(c.full_name);
      continue;
    }
    targets.push({ client: c, file });
  }

  console.log(`  → ${targets.length} client(s) to attempt · ${skippedNoFile.length} missing intake file`);
  if (skippedNoFile.length) {
    console.log(`  → no intake file for:`, skippedNoFile);
  }

  const results = await mapWithConcurrency(targets, MAX_CONCURRENCY, async ({ client, file }) => {
    try {
      const ex = await extractFromFile(client.full_name, file.path);
      return { client, file, ex, ok: true };
    } catch (e) {
      return { client, file, err: e.message, ok: false };
    }
  });

  // Build patches — only fill NULL/empty fields.
  const patches = [];
  const stats = { extracted: { age: 0, location: 0, goal: 0 }, patched: { age: 0, location: 0, goal: 0 }, failed: 0 };
  for (const r of results) {
    if (!r.ok) {
      stats.failed += 1;
      console.error(`  ! ${r.client.full_name}: ${r.err}`);
      continue;
    }
    if (r.ex.age != null) stats.extracted.age += 1;
    if (r.ex.location) stats.extracted.location += 1;
    if (r.ex.goal) stats.extracted.goal += 1;

    const patch = {};
    if (r.client.age == null && r.ex.age != null) { patch.age = r.ex.age; stats.patched.age += 1; }
    if ((!r.client.location || !r.client.location.trim()) && r.ex.location) { patch.location = r.ex.location; stats.patched.location += 1; }
    if ((!r.client.goal || !r.client.goal.trim()) && r.ex.goal) { patch.goal = r.ex.goal; stats.patched.goal += 1; }
    if (Object.keys(patch).length > 0) patches.push({ id: r.client.id, name: r.client.full_name, patch });
  }

  console.log(`  → extracted values: age=${stats.extracted.age}, location=${stats.extracted.location}, goal=${stats.extracted.goal} (of ${targets.length} attempts)`);
  console.log(`  → patches to apply: age=${stats.patched.age}, location=${stats.patched.location}, goal=${stats.patched.goal} (${patches.length} rows)`);

  if (DRY_RUN) {
    console.log(`[${new Date().toISOString()}] DRY RUN — no writes. Sample patches:`);
    for (const p of patches.slice(0, 10)) {
      console.log(`  ${p.name}:`, p.patch);
    }
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const p of patches) {
    const { error: upErr } = await supabase.from('clients').update(p.patch).eq('id', p.id);
    if (upErr) { failed += 1; console.error(`  ! ${p.name} failed:`, upErr.message); }
    else ok += 1;
  }

  const { data: after } = await supabase
    .from('clients')
    .select('age, location, goal, is_active')
    .eq('is_active', true);
  const afterCounts = {
    with_age: after.filter(c => c.age != null).length,
    with_location: after.filter(c => c.location && c.location.trim()).length,
    with_goal: after.filter(c => c.goal && c.goal.trim()).length,
  };
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[${new Date().toISOString()}] done — updated ${ok}, failed ${failed}, ${elapsed}s`);
  console.log(`  before → after: age ${before.with_age}→${afterCounts.with_age} · location ${before.with_location}→${afterCounts.with_location} · goal ${before.with_goal}→${afterCounts.with_goal} (of ${before.total})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`[${new Date().toISOString()}] fatal:`, e.stack || e.message);
  process.exit(1);
});
