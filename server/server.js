// Faerber Client OS — local API server
// Wraps existing sync + check-in scripts behind a dashboard UI.
// Run: cd server && node server.js
// Then: http://localhost:3737

// Force IPv4 DNS on Railway → Supabase (Node 22's undici prefers IPv6, Supabase pooler is IPv4-only).
import dns from 'dns';
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import { spawn } from 'child_process';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { draftSpec, executeTodo } from './executor.js';
import { generateGoalToDos } from './goal-sync.js';
import { processIntakeSubmission } from './intake.js';
import { pushApprovedOnboarding } from './onboard-push.js';
import { registerV2Routes } from './v2/routes.js';
import { startCronJobs } from './v2/cron.js';

// Env loading:
//   - Cloud (Railway/Docker): env vars are injected by the host — dotenv is a no-op.
//   - Local Mac: load from ~/Desktop/Playground - Claude/.env and faerber-checkin/.env
//     if those files exist. Never fail if the paths don't exist (they won't in the cloud).
const LOCAL_ENV_PATHS = [
  '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/.env',
  '/Users/zachef/Desktop/Playground - Claude/.env',
];
for (const p of LOCAL_ENV_PATHS) {
  try { if (fs.existsSync(p)) dotenv.config({ path: p }); } catch (_) { /* ignore in cloud */ }
}
// Strip stray "sk-ant-" prefix if double-set from shell rc (see MEMORY notes)
if (process.env.ANTHROPIC_API_KEY?.startsWith('sk-ant-sk-ant-')) {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY.slice(7);
}
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Paths — default to local Mac layout, but every one can be overridden via env for cloud/Docker.
// LOCAL_ONLY endpoints (Python subprocess, Playwright, local file scrapes) skip themselves when
// process.env.LOCAL_ONLY !== 'true'. Cloud sets LOCAL_ONLY=false and those routes 501 out.
const IS_LOCAL_ONLY = process.env.LOCAL_ONLY === 'true';
const ROOT = process.env.FF_ROOT || '/Users/zachef/Desktop/Playground - Claude';
const FF_CLIENT_OS = process.env.FF_CLIENT_OS || `${ROOT}/scripts/faerber-client-os`;
const PYTHON_BIN = process.env.PYTHON_BIN || '/Users/zachef/.venvs/faerber-client-os/bin/python';
const FF_CHECKIN = process.env.FF_CHECKIN || `${ROOT}/faerber-checkin`;
// Dashboard assets ship next to server/ inside the repo — resolve relative to __dirname
// so the same path works locally (repo checkout) and in the container.
const DASHBOARD = process.env.DASHBOARD || path.resolve(__dirname, '..', 'dashboard');
const PORT = process.env.PORT || 3737;

// Supabase — allow env override for cloud (never hardcode a service key).
// Local Mac falls back to the public anon/publishable key so quick starts still work.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://sfuvqaoeuajsrvldoiek.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  'sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Small helper — used by local-only endpoints to short-circuit in the cloud
// with a clean 501 instead of trying to spawn Python/Playwright that isn't installed.
function guardLocalOnly(res, feature) {
  if (IS_LOCAL_ONLY) return false;
  res.status(501).json({
    error: `${feature} is a LOCAL_ONLY endpoint (requires the Mac wrapper — Python venv, Playwright, or local file paths). Not available on cloud instance.`,
    hint: 'Run the local wrapper on the Mac to use this endpoint.',
  });
  return true;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ─── Request timing (slow-request log) ───
// Logs any request >3s so Railway logs surface the specific external calls
// that are the bottleneck. Uses console.warn so it stands out from noise.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (ms > 3000) {
      console.warn(`[slow] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});

// CORS — local dev
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Basic Auth (production gate) ────────────────────────────────
// Protects the entire surface except /api/health (Railway's healthcheck
// hits that endpoint and cannot pass an Authorization header).
// Skip entirely if DASHBOARD_PASSWORD isn't set — enables frictionless
// local dev (server binds to localhost only anyway).
app.use((req, res, next) => {
  if (req.path === '/api/health') return next();
  if (!process.env.DASHBOARD_PASSWORD) return next();

  const auth = req.headers.authorization || '';
  const [scheme, encoded] = auth.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Faerber Client OS"');
    return res.status(401).send('Auth required');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch (_) {
    res.set('WWW-Authenticate', 'Basic realm="Faerber Client OS"');
    return res.status(401).send('Bad credentials encoding');
  }

  const idx = decoded.indexOf(':');
  const user = idx >= 0 ? decoded.slice(0, idx) : decoded;
  const pass = idx >= 0 ? decoded.slice(idx + 1) : '';
  const expectedUser = process.env.DASHBOARD_USER || 'zach';
  if (user === expectedUser && pass === process.env.DASHBOARD_PASSWORD) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Faerber Client OS"');
  return res.status(401).send('Wrong password');
});

// ─── v2 dashboard shell ──────────────────────────────────────────
// New CEO dashboard at /v2. Legacy operational dashboard at /legacy.
// Root `/` still serves legacy for now — Zach flips the swap manually.
// Serve v2 dashboard assets from dashboard/v2/ under the /v2 URL prefix.
// The static middleware also handles /v2/ (directory index → v2/index.html).
app.use('/v2', express.static(path.join(DASHBOARD, 'v2'), { index: 'index.html', extensions: ['html'] }));
// Bare /v2 (no slash) — send the shell directly so relative paths continue to work when
// the browser follows internal links.
app.get('/v2', (_req, res) => res.redirect(302, '/v2/'));
app.get('/legacy', (_req, res) => res.sendFile(path.join(DASHBOARD, 'index.html')));

// v2 API routes — /api/v2/*
registerV2Routes({ app, supabase });

// Serve dashboard static (legacy — includes old index.html at `/`)
app.use(express.static(DASHBOARD));

// ── Stream a spawned process as SSE ──
function streamProcess(cmd, args, cwd, res, req) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const proc = spawn(cmd, args, { cwd });
  const send = (type, payload) => res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);

  proc.stdout.on('data', d => {
    d.toString().split('\n').filter(Boolean).forEach(line => send('stdout', { line }));
  });
  proc.stderr.on('data', d => {
    d.toString().split('\n').filter(Boolean).forEach(line => send('stderr', { line }));
  });
  proc.on('close', code => {
    send('exit', { code });
    res.end();
  });
  proc.on('error', err => {
    send('error', { message: err.message });
    res.end();
  });
  // Note: NOT killing child on req.close — Express body parser closes req after parsing,
  // which would kill the sync prematurely. Let python finish even if client disconnects.
}

// ── ENDPOINTS ──

// Health
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ─── STAGE OVERRIDES ─────────────────────────────────────────────
// Per-client manual stage assignment. Lives in stage-overrides.json
// alongside server.js. Shape: { "<trainerize_user_id_or_client_id>": "yellow", ... }
const STAGE_OVERRIDES_PATH = path.join(__dirname, 'stage-overrides.json');
const VALID_STAGES = ['red', 'yellow', 'green', 'onboarding', 'ghosting', 'past'];

function readStageOverrides() {
  try {
    if (!fs.existsSync(STAGE_OVERRIDES_PATH)) return {};
    const raw = fs.readFileSync(STAGE_OVERRIDES_PATH, 'utf8').trim();
    if (!raw) return {};
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[stage-overrides] read failed:', e.message);
    return {};
  }
}

function writeStageOverrides(overrides) {
  // Atomic write: write to tmp, then rename
  const tmp = `${STAGE_OVERRIDES_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(overrides, null, 2));
  fs.renameSync(tmp, STAGE_OVERRIDES_PATH);
}

// GET all overrides — used by the dashboard to merge with auto stages
app.get('/api/stage-overrides', (_req, res) => {
  res.json({ overrides: readStageOverrides() });
});

// ─── MONDAY CLIENTS ──────────────────────────────────────────────
// Reads server/monday-clients.json on every request (small file, no caching).
// Produced by `python sync_monday_clients.py` (chained from sync_all.py).
const MONDAY_CLIENTS_PATH = path.join(__dirname, 'monday-clients.json');
app.get('/api/monday-clients', (_req, res) => {
  try {
    if (!fs.existsSync(MONDAY_CLIENTS_PATH)) {
      return res.json({ updated_at: null, clients: [] });
    }
    const raw = fs.readFileSync(MONDAY_CLIENTS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    res.json(parsed);
  } catch (e) {
    console.warn('[monday-clients] read failed:', e.message);
    res.json({ updated_at: null, clients: [], error: e.message });
  }
});

// POST override for one client
// Body: { stage: "red" | "yellow" | "green" | "onboarding" | "ghosting" | "past" | null }
app.post('/api/clients/:clientId/stage-override', (req, res) => {
  const { clientId } = req.params;
  const { stage } = req.body || {};

  if (stage !== null && !VALID_STAGES.includes(stage)) {
    return res.status(400).json({
      error: `stage must be one of: ${VALID_STAGES.join(', ')} or null (to clear)`,
    });
  }

  try {
    const overrides = readStageOverrides();
    if (stage === null) {
      delete overrides[clientId];
    } else {
      overrides[clientId] = stage;
    }
    writeStageOverrides(overrides);
    res.json({ ok: true, clientId, stage, overrides });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST bulk stage override
// Body: { clientIds: ["12244275263", ...], stage: "red"|"yellow"|"green"|"onboarding"|"ghosting"|"past"|null }
// `stage: null` clears the override (auto). Returns { ok: true, count, stage, overrides }.
app.post('/api/clients/bulk-stage-override', (req, res) => {
  const { clientIds, stage } = req.body || {};

  if (!Array.isArray(clientIds) || clientIds.length === 0) {
    return res.status(400).json({ error: 'clientIds must be a non-empty array' });
  }
  if (stage !== null && !VALID_STAGES.includes(stage)) {
    return res.status(400).json({
      error: `stage must be one of: ${VALID_STAGES.join(', ')} or null (to clear)`,
    });
  }

  try {
    const overrides = readStageOverrides();
    let count = 0;
    for (const rawId of clientIds) {
      const id = String(rawId || '').trim();
      if (!id) continue;
      if (stage === null) {
        if (id in overrides) {
          delete overrides[id];
          count += 1;
        } else {
          // still count as a clear-op success for the client even if no-op
          count += 1;
        }
      } else {
        overrides[id] = stage;
        count += 1;
      }
    }
    writeStageOverrides(overrides);
    res.json({ ok: true, count, stage, overrides });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sync — run sync_all.py (streamed)  [LOCAL_ONLY — Python venv]
// Body (optional): { skipRecs: bool (default true), workers: int (default 8), client: string }
app.post('/api/sync', (req, res) => {
  if (guardLocalOnly(res, '/api/sync')) return;
  const skipRecs = req.body?.skipRecs !== false; // default TRUE — fast data refresh
  const workers = req.body?.workers || 8;
  const client = req.body?.client;
  const args = ['-u', 'sync_all.py', '--workers', String(workers)];
  if (skipRecs) args.push('--skip-recs');
  if (client) args.push('--client', client);
  console.log(`[sync] ${args.join(' ')}`);
  streamProcess(`${PYTHON_BIN}`, args, FF_CLIENT_OS, res, req);
});

// POST /api/sync/recs — generate recs only (run after data sync)  [LOCAL_ONLY]
app.post('/api/sync/recs', (req, res) => {
  if (guardLocalOnly(res, '/api/sync/recs')) return;
  streamProcess(`${PYTHON_BIN}`, ['-u', 'regen_recs.py'], FF_CLIENT_OS, res, req);
});

// POST /api/checkin/scrape — run checkin.js --scrape (streamed)  [LOCAL_ONLY — Playwright]
app.post('/api/checkin/scrape', (req, res) => {
  if (guardLocalOnly(res, '/api/checkin/scrape')) return;
  streamProcess('node', ['checkin.js', '--scrape'], FF_CHECKIN, res, req);
});

// GET /api/checkin/this-week — return drafted responses + raw answers + supabase recs  [LOCAL_ONLY — reads Mac desktop scrape output]
app.get('/api/checkin/this-week', async (req, res) => {
  if (guardLocalOnly(res, '/api/checkin/this-week')) return;
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const responsesPath = `/Users/zachef/Desktop/Weekly_Checkins_${date}/responses.json`;
  const answersPath = `${FF_CHECKIN}/clients/checkin-answers-${date}.json`;

  if (!fs.existsSync(responsesPath)) {
    return res.json({ date, responses: [], message: `No check-ins for ${date}. Run scrape first.` });
  }

  try {
    const responses = JSON.parse(fs.readFileSync(responsesPath, 'utf8'));
    const answersRaw = fs.existsSync(answersPath) ? JSON.parse(fs.readFileSync(answersPath, 'utf8')) : [];
    const answerMap = {};
    for (const a of answersRaw) answerMap[a.name.toLowerCase()] = a.answers;

    // Pull recs + clients in one go
    const names = responses.map(r => r.name);
    const { data: clients } = await supabase
      .from('clients')
      .select('id, full_name, trainerize_user_id, daily_protein_target_g, daily_calorie_target, starting_weight_lbs, goal_weight_lbs, start_date')
      .in('full_name', names);

    const clientByName = {};
    for (const c of clients || []) clientByName[c.full_name.toLowerCase()] = c;

    const clientIds = (clients || []).map(c => c.id);
    console.log(`[this-week] matched clients: ${clientIds.length}, names sent: ${names.length}`);
    const recsRes = clientIds.length ? await supabase
      .from('recommendations')
      .select('client_id, priority, title, body, bullets, action_type')
      .in('client_id', clientIds)
      .eq('is_current', true)
      .order('priority', { ascending: true }) : { data: [] };
    if (recsRes.error) console.log('[this-week] recs error:', recsRes.error);
    const recs = recsRes.data || [];
    console.log(`[this-week] recs found: ${recs.length}`);

    const recsByClient = {};
    for (const r of recs || []) {
      if (!recsByClient[r.client_id]) recsByClient[r.client_id] = [];
      recsByClient[r.client_id].push(r);
    }

    const { data: snapshots } = clientIds.length ? await supabase
      .from('daily_snapshots')
      .select('client_id, snapshot_date, flag_color, flag_reasons, workouts_completed_this_week, workouts_scheduled_this_week, days_logged_last_7, avg_protein_g_7d, avg_calories_7d')
      .in('client_id', clientIds)
      .order('snapshot_date', { ascending: false }) : { data: [] };

    const snapByClient = {};
    for (const s of snapshots || []) {
      if (!snapByClient[s.client_id]) snapByClient[s.client_id] = s;
    }

    const enriched = responses.map(r => {
      const client = clientByName[r.name.toLowerCase()];
      return {
        name: r.name,
        response: r.response,
        sent_at: r.sent_at || null,
        answers: answerMap[r.name.toLowerCase()] || {},
        client: client || null,
        snapshot: client ? snapByClient[client.id] : null,
        recs: client ? (recsByClient[client.id] || []) : [],
      };
    });

    res.json({ date, responses: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/checkin/save — overwrite one client's drafted response  [LOCAL_ONLY — writes to Mac desktop]
app.post('/api/checkin/save', (req, res) => {
  if (guardLocalOnly(res, '/api/checkin/save')) return;
  const { date, name, response } = req.body;
  if (!date || !name || typeof response !== 'string') {
    return res.status(400).json({ error: 'Need date, name, response' });
  }
  const responsesPath = `/Users/zachef/Desktop/Weekly_Checkins_${date}/responses.json`;
  if (!fs.existsSync(responsesPath)) return res.status(404).json({ error: 'responses.json not found' });

  try {
    const responses = JSON.parse(fs.readFileSync(responsesPath, 'utf8'));
    const idx = responses.findIndex(r => r.name.toLowerCase() === name.toLowerCase());
    if (idx < 0) return res.status(404).json({ error: `${name} not in responses` });
    responses[idx].response = response;
    fs.writeFileSync(responsesPath, JSON.stringify(responses, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/checkin/rewrite — regenerate one client's response in Zach's voice
// Body: { date, name, notes (optional) }
const CHECKIN_TEMPLATE_PATH = `${FF_CHECKIN}/templates/checkin-reply.md`;

app.post('/api/checkin/rewrite', async (req, res) => {
  if (guardLocalOnly(res, '/api/checkin/rewrite')) return;
  const { date, name, notes } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'Need date, name' });

  const responsesPath = `/Users/zachef/Desktop/Weekly_Checkins_${date}/responses.json`;
  const answersPath = `${FF_CHECKIN}/clients/checkin-answers-${date}.json`;
  if (!fs.existsSync(responsesPath)) return res.status(404).json({ error: 'responses.json missing' });

  try {
    const responses = JSON.parse(fs.readFileSync(responsesPath, 'utf8'));
    const target = responses.find(r => r.name.toLowerCase() === name.toLowerCase());
    if (!target) return res.status(404).json({ error: `${name} not found` });

    const answersRaw = fs.existsSync(answersPath) ? JSON.parse(fs.readFileSync(answersPath, 'utf8')) : [];
    const answersObj = (answersRaw.find(a => a.name.toLowerCase() === name.toLowerCase()) || {}).answers || {};

    // Pull client + snapshot + recs from supabase
    const { data: clientRows } = await supabase.from('clients').select('id, full_name, daily_protein_target_g, daily_calorie_target, starting_weight_lbs, goal_weight_lbs, start_date').eq('full_name', name).limit(1);
    const client = clientRows?.[0];
    let snapshot = null, recs = [];
    if (client) {
      const { data: sn } = await supabase.from('daily_snapshots').select('*').eq('client_id', client.id).order('snapshot_date', { ascending: false }).limit(1);
      snapshot = sn?.[0] || null;
      const { data: rc } = await supabase.from('recommendations').select('priority, title, body, bullets, action_type').eq('client_id', client.id).eq('is_current', true).order('priority', { ascending: true });
      recs = rc || [];
    }

    const systemPrompt = fs.readFileSync(CHECKIN_TEMPLATE_PATH, 'utf8');

    const answerLines = Object.entries(answersObj).map(([q, a]) => `Q: ${q}\nA: ${a}`).join('\n\n');
    const snapLine = snapshot ? `Latest snapshot (${snapshot.snapshot_date}): flag=${snapshot.flag_color}, workouts ${snapshot.workouts_completed_this_week}/${snapshot.workouts_scheduled_this_week}, logged ${snapshot.days_logged_last_7}/7, protein ${Math.round(snapshot.avg_protein_g_7d || 0)}g (target ${client?.daily_protein_target_g || '?'}g), cal ${Math.round(snapshot.avg_calories_7d || 0)} (target ${client?.daily_calorie_target || '?'}). Reasons: ${(snapshot.flag_reasons || []).join(' · ')}` : 'No snapshot data.';
    const recsBlock = recs.length
      ? recs.map(r => `  #${r.priority} ${r.title}${r.body ? ' — ' + r.body : ''}${r.bullets?.length ? '\n     · ' + r.bullets.join('\n     · ') : ''}`).join('\n')
      : '  (no current recommendations)';

    const userPrompt = `Client: ${name}
${client ? `Profile: ${client.starting_weight_lbs || '?'}→${client.goal_weight_lbs || '?'}lb, protein target ${client.daily_protein_target_g || '?'}g, calorie target ${client.daily_calorie_target || '?'}` : ''}

DATA:
${snapLine}

CURRENT COACH RECOMMENDATIONS (Claude generated these earlier from the same data — weave the most important ones into the response naturally, don't list them out):
${recsBlock}

THEIR WRITTEN CHECK-IN ANSWERS:
${answerLines || '(none provided)'}

PREVIOUS DRAFTED RESPONSE (for context — improve it, don't just repeat):
${target.response}

${notes ? `ZACH'S SPECIFIC NOTES FOR THIS REWRITE (highest priority — MUST address these):\n${notes}` : ''}

Rewrite the check-in response now. Follow ALL rules in the system prompt. Include the *** coach-only footer at the bottom. Output plain text only — no preamble, no commentary, just the response itself starting with "Hey [first name], thanks for getting your check-in in."`;

    console.log(`[rewrite] ${name}${notes ? ' (with notes)' : ''}`);
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });
    const newResponse = msg.content[0].text;

    // Save back to responses.json
    target.response = newResponse;
    fs.writeFileSync(responsesPath, JSON.stringify(responses, null, 2));

    res.json({ ok: true, response: newResponse, usage: msg.usage });
  } catch (e) {
    console.error('[rewrite] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/checkin/send — send one client (spawns send-one.js), persist sent_at on success  [LOCAL_ONLY — Playwright]
app.post('/api/checkin/send', (req, res) => {
  if (guardLocalOnly(res, '/api/checkin/send')) return;
  const { date, name } = req.body;
  if (!date || !name) return res.status(400).json({ error: 'Need date, name' });

  const proc = spawn('node', ['send-one.js', '--date', date, '--name', name], { cwd: FF_CHECKIN });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', d => stdout += d.toString());
  proc.stderr.on('data', d => stderr += d.toString());
  proc.on('close', code => {
    if (code === 0) {
      // Mark sent_at in responses.json
      const responsesPath = `/Users/zachef/Desktop/Weekly_Checkins_${date}/responses.json`;
      try {
        const responses = JSON.parse(fs.readFileSync(responsesPath, 'utf8'));
        const idx = responses.findIndex(r => r.name.toLowerCase() === name.toLowerCase());
        if (idx >= 0) {
          responses[idx].sent_at = new Date().toISOString();
          fs.writeFileSync(responsesPath, JSON.stringify(responses, null, 2));
        }
        res.json({ ok: true, stdout, sent_at: responses[idx]?.sent_at });
      } catch (e) {
        res.json({ ok: true, stdout, warn: `send ok but persist failed: ${e.message}` });
      }
    } else {
      res.status(500).json({ ok: false, code, stdout, stderr });
    }
  });
});

// ─── COACH TO-DO LIST ────────────────────────────────────────────────────────

const ALLOWED_CATEGORIES = ['calorie', 'workout', 'other', 'call', 'bloodwork', 'mealplan', 'check-in'];

app.get('/api/todos', async (req, res) => {
  const status = req.query.status || 'open';
  const clientName = req.query.client;

  let q = supabase
    .from('coach_todos')
    .select('id, client_id, client_name, category, note, source, status, priority, snooze_until, created_at, completed_at, context, spec, execution_status, execution_result, executed_at')
    .order('created_at', { ascending: false });

  if (status !== 'all') q = q.eq('status', status);
  if (clientName) q = q.ilike('client_name', `%${clientName}%`);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ todos: data || [] });
});

app.get('/api/todos/by-client', async (_req, res) => {
  const { data, error } = await supabase
    .from('coach_todos')
    .select('client_id, client_name, category')
    .eq('status', 'open');
  if (error) return res.status(500).json({ error: error.message });

  const grouped = {};
  for (const t of data || []) {
    const key = t.client_name;
    if (!grouped[key]) grouped[key] = { client_id: t.client_id, client_name: t.client_name, total: 0, by_category: {} };
    grouped[key].total++;
    grouped[key].by_category[t.category] = (grouped[key].by_category[t.category] || 0) + 1;
  }
  res.json({ clients: Object.values(grouped).sort((a, b) => b.total - a.total) });
});

app.post('/api/todos', async (req, res) => {
  const { client_name, category, note, source, priority, context } = req.body || {};
  if (!client_name || !category || !note) {
    return res.status(400).json({ error: 'client_name, category, and note are required' });
  }
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `category must be one of: ${ALLOWED_CATEGORIES.join(', ')}` });
  }

  const { data: clients } = await supabase
    .from('clients')
    .select('id, full_name')
    .ilike('full_name', `%${client_name}%`)
    .limit(1);
  const client_id = clients?.[0]?.id || null;
  const resolved_name = clients?.[0]?.full_name || client_name;

  const { data, error } = await supabase
    .from('coach_todos')
    .insert({
      client_id,
      client_name: resolved_name,
      category,
      note: note.trim(),
      source: source || 'manual',
      priority: priority || 'normal',
      context: context || null,
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ todo: data });
});

app.post('/api/todos/:id/complete', async (req, res) => {
  const { data, error } = await supabase
    .from('coach_todos')
    .update({ status: 'done', completed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ todo: data });
});

app.post('/api/todos/:id/snooze', async (req, res) => {
  const days = Number(req.body?.days || 7);
  const snoozeUntil = new Date();
  snoozeUntil.setDate(snoozeUntil.getDate() + days);

  const { data, error } = await supabase
    .from('coach_todos')
    .update({ status: 'snoozed', snooze_until: snoozeUntil.toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ todo: data });
});

app.post('/api/todos/:id/reopen', async (req, res) => {
  const { data, error } = await supabase
    .from('coach_todos')
    .update({ status: 'open', completed_at: null, snooze_until: null })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ todo: data });
});

app.delete('/api/todos/:id', async (req, res) => {
  const { error } = await supabase.from('coach_todos').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

app.post('/api/todos/wake-snoozed', async (_req, res) => {
  const { data, error } = await supabase
    .from('coach_todos')
    .update({ status: 'open', snooze_until: null })
    .eq('status', 'snoozed')
    .lt('snooze_until', new Date().toISOString())
    .select('id');
  if (error) return res.status(500).json({ error: error.message });
  res.json({ awoken: data?.length || 0 });
});

// ─── EXECUTOR ROUTES ─────────────────────────────────────────────

async function loadTodoContext(todoId) {
  const { data: todo, error: todoErr } = await supabase
    .from('coach_todos')
    .select('*')
    .eq('id', todoId)
    .single();
  if (todoErr || !todo) return { error: 'Todo not found' };

  let client = null;
  if (todo.client_id) {
    const { data } = await supabase
      .from('clients')
      .select('*')
      .eq('id', todo.client_id)
      .single();
    client = data;
  }
  if (!client && todo.client_name) {
    const { data } = await supabase
      .from('clients')
      .select('*')
      .ilike('full_name', `%${todo.client_name}%`)
      .limit(1);
    client = data?.[0] || null;
  }

  // Fallback: fresh-intake clients aren't in `clients` table yet.
  // Synthesize a client from intake_submissions row if intake_id is in todo.context.
  if (!client && todo.context?.intake_id) {
    const { data: intake } = await supabase
      .from('intake_submissions')
      .select('*')
      .eq('id', todo.context.intake_id)
      .single();
    if (intake) {
      client = {
        id: null,
        full_name: intake.full_name,
        email: intake.email,
        trainerize_user_id: todo.context.trainerize_user_id ? String(todo.context.trainerize_user_id) : null,
        goal: intake.goal_type,
        starting_weight_lbs: intake.weight_lb,
        goal_weight_lbs: intake.goal_weight_lb,
        daily_calorie_target: todo.context.macros?.caloricGoal || null,
        daily_protein_target_g: todo.context.macros?.proteinGrams || null,
        notes: intake.why_now || '',
        _from_intake: true,
        _intake: intake,
      };
    }
  }
  if (!client) return { error: `Client not found for "${todo.client_name}"` };

  const { data: checkins } = client.id
    ? await supabase
        .from('weekly_checkins')
        .select('*')
        .eq('client_id', client.id)
        .order('checkin_date', { ascending: false })
        .limit(1)
    : { data: null };
  const checkin = checkins?.[0] || null;

  return { todo, client, checkin };
}

// Draft spec via Claude — POST /api/todos/:id/draft-spec
app.post('/api/todos/:id/draft-spec', async (req, res) => {
  const ctx = await loadTodoContext(req.params.id);
  if (ctx.error) return res.status(404).json({ error: ctx.error });

  const result = await draftSpec({
    category: ctx.todo.category,
    note: ctx.todo.note,
    client: ctx.client,
    checkin: ctx.checkin,
    recentMessages: '',
  });
  if (!result.ok) return res.status(500).json({ error: result.error, raw: result.raw });

  const { data: updated, error } = await supabase
    .from('coach_todos')
    .update({ spec: result.spec, execution_status: result.spec.executable ? 'pending' : 'needs_input' })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ todo: updated, spec: result.spec });
});

// Regenerate split/macros for a pending onboarding using coach notes/overrides
app.post('/api/intake/pending/:id/regenerate', async (req, res) => {
  const pendingId = req.params.id;
  const notes = (req.body?.notes || '').trim();
  if (!notes) return res.status(400).json({ error: 'notes required' });

  const { data: pending } = await supabase
    .from('pending_onboardings')
    .select('*, intake_submissions(*)')
    .eq('id', pendingId)
    .single();
  if (!pending) return res.status(404).json({ error: 'Pending not found' });
  if (pending.status === 'approved' || pending.status === 'pushing_workouts') {
    return res.status(409).json({ error: `Cannot regenerate — already ${pending.status}` });
  }

  const intake = pending.intake_submissions;

  try {
    const { selectSplit, computeMacros } = await import('./intake.js');
    // Pass notes as ABSOLUTE COACH OVERRIDES to selectSplit (elevated above locked rules)
    const newSplit = await selectSplit(intake, notes);
    if (!newSplit.ok) throw new Error(newSplit.error || 'Split regen failed');

    // Macro override: if notes contain specific numbers, parse + apply directly
    // Strip commas from numbers first ("2,000" → "2000") so regex catches them
    const notesNum = notes.replace(/(\d),(\d)/g, '$1$2');
    let newMacros = { ...pending.computed_macros };
    const calMatch = notesNum.match(/(\d{3,5})\s*(?:cal|kcal|calorie)/i);
    const proteinMatch = notesNum.match(/(\d{2,3})\s*g?\s*(?:protein|p\b)/i);
    const carbsMatch = notesNum.match(/(\d{2,3})\s*g?\s*(?:carb|c\b)/i);
    const fatMatch = notesNum.match(/(\d{2,3})\s*g?\s*(?:fat|f\b)/i);
    let macroChanged = false;
    if (calMatch) { newMacros.caloricGoal = parseInt(calMatch[1]); macroChanged = true; }
    if (proteinMatch) { newMacros.proteinGrams = parseInt(proteinMatch[1]); macroChanged = true; }
    if (carbsMatch) { newMacros.carbsGrams = parseInt(carbsMatch[1]); macroChanged = true; }
    if (fatMatch) { newMacros.fatGrams = parseInt(fatMatch[1]); macroChanged = true; }
    if (macroChanged) {
      // Recompute carbs/fat balance if cal+protein specified but not all macros
      const cal = newMacros.caloricGoal;
      const p = newMacros.proteinGrams;
      if (!fatMatch && p && cal) newMacros.fatGrams = Math.round((cal * 0.28) / 9);
      if (!carbsMatch && p && cal) newMacros.carbsGrams = Math.max(50, Math.round((cal - (p * 4) - (newMacros.fatGrams * 9)) / 4));
      newMacros.proteinPercent = Math.round((newMacros.proteinGrams * 4 / cal) * 100);
      newMacros.carbsPercent = Math.round((newMacros.carbsGrams * 4 / cal) * 100);
      newMacros.fatPercent = 100 - newMacros.proteinPercent - newMacros.carbsPercent;
      newMacros._override_notes = notes.slice(0, 200);
    }

    const newLog = [
      ...(pending.pipeline_log || []),
      { step: 'regenerated_with_notes', at: new Date().toISOString(), notes: notes.slice(0, 300), days: newSplit.days_per_week, name: newSplit.split_name },
    ];

    const { data: updated, error } = await supabase
      .from('pending_onboardings')
      .update({
        selected_split: newSplit,
        computed_macros: newMacros,
        pipeline_log: newLog,
        review_reason: `Regenerated w/ coach notes: ${notes.slice(0, 200)}`,
      })
      .eq('id', pendingId)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, split: newSplit, macros: newMacros });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update spec (manual edit) — PUT /api/todos/:id/spec
app.put('/api/todos/:id/spec', async (req, res) => {
  const { spec } = req.body || {};
  if (!spec || typeof spec !== 'object') return res.status(400).json({ error: 'spec required' });
  const { data, error } = await supabase
    .from('coach_todos')
    .update({ spec, execution_status: 'pending' })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ todo: data });
});

// Execute todo — POST /api/todos/:id/execute
app.post('/api/todos/:id/execute', async (req, res) => {
  const ctx = await loadTodoContext(req.params.id);
  if (ctx.error) return res.status(404).json({ error: ctx.error });
  let { todo, client, checkin } = ctx;

  // If no spec, auto-draft
  let spec = todo.spec;
  if (!spec) {
    const drafted = await draftSpec({
      category: todo.category,
      note: todo.note,
      client,
      checkin,
      recentMessages: '',
    });
    if (!drafted.ok) {
      await supabase.from('coach_todos').update({
        execution_status: 'failed',
        execution_result: `Spec drafting failed: ${drafted.error}`,
        executed_at: new Date().toISOString(),
      }).eq('id', todo.id);
      return res.status(500).json({ error: drafted.error });
    }
    spec = drafted.spec;
    await supabase.from('coach_todos').update({ spec }).eq('id', todo.id);
  }

  // Mark running
  await supabase.from('coach_todos').update({ execution_status: 'running' }).eq('id', todo.id);

  const out = await executeTodo({ todo, client, checkin, spec });

  const update = {
    execution_status: out.status,
    execution_result: out.result,
    executed_at: new Date().toISOString(),
  };
  if (out.status === 'completed') {
    update.status = 'done';
    update.completed_at = new Date().toISOString();
  }
  const { data: finalTodo } = await supabase
    .from('coach_todos')
    .update(update)
    .eq('id', todo.id)
    .select()
    .single();

  res.json({ todo: finalTodo, status: out.status, result: out.result, spec });
});

// ─── INTAKE FORM SUBMISSION ──────────────────────────────────────
app.post('/api/intake/submit', async (req, res) => {
  const payload = req.body || {};
  if (!payload.name || !payload.email) {
    return res.status(400).json({ error: 'name + email required' });
  }
  // Insert intake_submissions row
  const { data: intake, error } = await supabase
    .from('intake_submissions')
    .insert({
      full_name: payload.name,
      email: payload.email.toLowerCase(),
      phone: payload.phone || null,
      age: payload.age || null,
      gender: payload.gender || null,
      city: payload.city || null,
      timezone: payload.timezone || null,
      weight_unit: payload.weight_unit || 'lb',
      weight_input: payload.weight_input || null,
      weight_lb: payload.weight_lb || null,
      height: payload.height || null,
      goal_weight_input: payload.goal_weight_input || null,
      goal_weight_lb: payload.goal_weight_lb || null,
      deadline: payload.deadline || null,
      why_now: payload.why_now || null,
      goal_type: payload.goal_type || null,
      history_level: payload.history_level || null,
      experience: payload.experience || null,
      activity: payload.activity || null,
      availability: payload.availability || null,
      train_where: payload.train_where || [],
      equipment: payload.equipment || null,
      feel_strong: payload.feel_strong || null,
      injuries: payload.injuries || null,
      flags: payload.flags || [],
      other_condition: payload.other_condition || null,
      meds: payload.meds || null,
      food_relationship: payload.food_relationship || null,
      food_love: payload.food_love || null,
      food_avoid: payload.food_avoid || null,
      typical_day: payload.typical_day || null,
      sleep_hrs: payload.sleep_hrs || null,
      sleep_quality: payload.sleep_quality || null,
      stress: payload.stress || null,
      typical_weekday: payload.typical_weekday || null,
      coaching_tone: payload.coaching_tone || null,
      anything_else: payload.anything_else || null,
      referral_name: payload.referral_name || null,
      referral_phone: payload.referral_phone || null,
      raw_payload: payload,
      user_agent: payload.user_agent || req.get('User-Agent') || null,
      ip: req.ip || null,
    })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });

  // Fire pipeline async (don't block response)
  processIntakeSubmission({ supabase, intake_id: intake.id })
    .then(result => console.log(`[intake:${intake.id}] pipeline result:`, result.status))
    .catch(e => console.error(`[intake:${intake.id}] pipeline error:`, e));

  res.json({ ok: true, intake_id: intake.id, message: 'Submission received. Pipeline running.' });
});

// Send meal plan PDF to client via Trainerize — Playwright attaches PDF directly to message  [LOCAL_ONLY — Playwright + local PDF path]
app.post('/api/clients/:trainerizeUserId/send-mealplan', async (req, res) => {
  if (guardLocalOnly(res, '/api/clients/:id/send-mealplan')) return;
  const userID = Number(req.params.trainerizeUserId);
  const { pdf_path, client_name, client_email } = req.body || {};
  if (!userID || !pdf_path) return res.status(400).json({ error: 'trainerize user_id + pdf_path required' });
  if (!fs.existsSync(pdf_path)) return res.status(404).json({ error: `PDF not found at ${pdf_path}` });

  try {
    // Lookup email if not passed
    let clientEmail = client_email;
    if (!clientEmail) {
      const { data: row } = await supabase
        .from('clients')
        .select('email')
        .eq('trainerize_user_id', String(userID))
        .single();
      clientEmail = row?.email;
    }
    if (!clientEmail) return res.status(404).json({ error: 'Client email not found — needed to find Trainerize thread' });
    const firstName = (client_name || '').split(' ')[0] || 'there';

    const { sendMealPlanViaMessage } = await import('./meal-plan-message.js');
    const result = await sendMealPlanViaMessage({
      clientEmail,
      clientFullName: client_name,
      clientFirstName: firstName,
      pdfPath: pdf_path,
    });
    if (!result.ok) return res.status(500).json({ error: result.error, screenshot: result.screenshot });
    res.json({ ok: true, message: `PDF sent to ${client_name} via Trainerize web flow.` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Synthesize an intake submission from pasted text — for existing clients (Michael Sosa etc)
app.post('/api/intake/synthesize', async (req, res) => {
  const { client_id, client_name, client_email, trainerize_user_id, paste_text } = req.body || {};
  if (!client_name || !paste_text) {
    return res.status(400).json({ error: 'client_name + paste_text required' });
  }

  try {
    const anthropic = new (await import('@anthropic-ai/sdk')).default({ apiKey: process.env.ANTHROPIC_API_KEY });
    const sys = `You are Zach Faerber's coaching ops AI. Parse the pasted onboarding context (Trainerize intake answers, Fathom call notes, DMs, etc) into a structured intake JSON.

Output ONLY JSON matching this exact shape:
{
  "age": number | null,
  "gender": "Male" | "Female" | null,
  "city": string | null,
  "timezone": "Eastern (ET)" | "Central (CT)" | "Mountain (MT)" | "Pacific (PT)" | "Alaska" | "Hawaii" | null,
  "weight_unit": "lb" | "kg",
  "weight_lb": number | null,
  "height": string | null,
  "goal_weight_lb": number | null,
  "deadline": "YYYY-MM-DD" | null,
  "why_now": string | null,
  "goal_type": "fat-loss" | "recomp" | "muscle" | "maintain" | null,
  "history_level": "never" | "off-rails" | "current" | null,
  "experience": "beginner" | "intermediate" | "advanced" | null,
  "activity": "sedentary" | "light" | "moderate" | "heavy" | "athlete" | null,
  "train_days": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  "availability": string | null,
  "train_where": ["gym" | "home-weights" | "home-minimal" | "bw" | "hotel"],
  "equipment": string | null,
  "feel_strong": string | null,
  "injuries": string | null,
  "flags": ["pregnant" | "postpartum" | "breastfeeding" | "perimeno" | "diabetic" | "thyroid" | "autoimmune" | "heart" | "ed-history" | "none"],
  "other_condition": string | null,
  "meds": string | null,
  "food_relationship": string | null,
  "food_love": string | null,
  "food_avoid": string | null,
  "typical_day": string | null,
  "sleep_hrs": number | null,
  "sleep_quality": "Very poor" | "Poor" | "Fair" | "Good" | "Excellent" | null,
  "stress": "Low" | "Moderate" | "High" | "Very high" | null,
  "typical_weekday": string | null,
  "coaching_tone": "direct" | "supportive" | "instructional" | "mix" | null,
  "anything_else": string | null
}

Rules:
- If a field is genuinely not mentioned, set to null (or empty array for arrays).
- Don't fabricate. If you can't tell their goal weight, leave null.
- For train_days: pick days based on availability language. "M/W/F" → ["Mon","Wed","Fri"]. "5 days a week" → ["Mon","Tue","Wed","Thu","Fri"] default.
- For flags: include 'none' if no health flags mentioned.
- For train_where: infer from equipment description (full gym → ['gym'], DBs at home → ['home-weights']).`;

    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      system: sys,
      messages: [{ role: 'user', content: `Client: ${client_name}\nEmail: ${client_email || '(not provided)'}\n\nPaste:\n\n${paste_text}` }],
    });
    const text = resp.content?.[0]?.text || '';
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e < 0) return res.status(500).json({ error: 'Sonnet returned no JSON' });
    const parsed = JSON.parse(text.slice(s, e + 1));

    // Insert intake_submissions row
    const { data: intake, error } = await supabase
      .from('intake_submissions')
      .insert({
        full_name: client_name,
        email: client_email?.toLowerCase() || `${client_name.toLowerCase().replace(/\s+/g, '.')}@unknown.local`,
        age: parsed.age,
        gender: parsed.gender,
        city: parsed.city,
        timezone: parsed.timezone,
        weight_unit: parsed.weight_unit || 'lb',
        weight_lb: parsed.weight_lb,
        height: parsed.height,
        goal_weight_lb: parsed.goal_weight_lb,
        deadline: parsed.deadline,
        why_now: parsed.why_now,
        goal_type: parsed.goal_type,
        history_level: parsed.history_level,
        experience: parsed.experience,
        activity: parsed.activity,
        availability: parsed.availability,
        train_where: parsed.train_where || [],
        equipment: parsed.equipment,
        feel_strong: parsed.feel_strong,
        injuries: parsed.injuries,
        flags: parsed.flags || [],
        other_condition: parsed.other_condition,
        meds: parsed.meds,
        food_relationship: parsed.food_relationship,
        food_love: parsed.food_love,
        food_avoid: parsed.food_avoid,
        typical_day: parsed.typical_day,
        sleep_hrs: parsed.sleep_hrs,
        sleep_quality: parsed.sleep_quality,
        stress: parsed.stress,
        typical_weekday: parsed.typical_weekday,
        coaching_tone: parsed.coaching_tone,
        anything_else: parsed.anything_else,
        raw_payload: { ...parsed, train_days: parsed.train_days || [], _source: 'paste_synthesize', _client_id: client_id, _existing_trainerize_user_id: trainerize_user_id },
      })
      .select()
      .single();
    if (error) return res.status(500).json({ error: error.message });

    // Fire pipeline (skips Trainerize user create — picks up existing ID from raw_payload)
    processIntakeSubmission({ supabase, intake_id: intake.id, existingTrainerizeUserId: trainerize_user_id ? Number(trainerize_user_id) : null })
      .then(r => console.log(`[synthesize:${intake.id}] result:`, r.status))
      .catch(e => console.error(`[synthesize:${intake.id}] error:`, e));

    res.json({ ok: true, intake_id: intake.id, parsed_fields: Object.keys(parsed).filter(k => parsed[k] != null && (Array.isArray(parsed[k]) ? parsed[k].length : true)).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List pending onboardings — for dashboard review surface
app.get('/api/intake/pending', async (_req, res) => {
  const { data, error } = await supabase
    .from('pending_onboardings')
    .select('*, intake_submissions(full_name, email, weight_lb, goal_weight_lb, deadline, goal_type, flags)')
    .in('status', ['ready_for_review', 'needs_review', 'failed'])
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ pending: data || [] });
});

// Approve a pending onboarding — kicks the workout push pipeline async (idempotent)
app.post('/api/intake/pending/:id/approve', async (req, res) => {
  const pendingId = req.params.id;
  // Lock — refuse if already running or done
  const { data: row } = await supabase.from('pending_onboardings').select('status').eq('id', pendingId).single();
  if (!row) return res.status(404).json({ error: 'Pending row not found' });
  const blocked = ['pushing_workouts', 'approved', 'failed'];
  if (blocked.includes(row.status)) {
    return res.status(409).json({ error: `Already ${row.status}, cannot re-approve. Reset row first.` });
  }
  // Mark as pushing immediately to prevent races
  await supabase.from('pending_onboardings').update({ status: 'pushing_workouts' }).eq('id', pendingId);
  // Fire push async
  pushApprovedOnboarding({ supabase, pendingId })
    .then(r => console.log(`[approve:${pendingId}] result:`, r))
    .catch(e => console.error(`[approve:${pendingId}] error:`, e.message));
  res.json({ ok: true, pendingId, message: 'Push started — workouts + macros being pushed to Trainerize. Status will update on dashboard refresh.' });
});

// Spawn to-dos for a freshly-approved onboarding. Accepts array of { category, note, priority }.
app.post('/api/intake/pending/:id/spawn-todos', async (req, res) => {
  const pendingId = req.params.id;
  const todos = req.body?.todos || [];
  if (!Array.isArray(todos) || todos.length === 0) {
    return res.status(400).json({ error: 'todos array required' });
  }
  const { data: pending } = await supabase
    .from('pending_onboardings')
    .select('*, intake_submissions(*)')
    .eq('id', pendingId)
    .single();
  if (!pending) return res.status(404).json({ error: 'Pending row not found' });

  const intake = pending.intake_submissions;
  const macros = pending.computed_macros || {};
  const ctxBase = {
    pending_id: pendingId,
    intake_id: intake?.id,
    trainerize_user_id: pending.trainerize_user_id,
    macros,
  };

  const rows = todos.map(t => ({
    client_id: null, // no clients row yet for fresh intakes
    client_name: pending.client_name,
    category: t.category,
    note: t.note,
    source: 'sync',
    priority: t.priority || 'normal',
    context: { ...ctxBase, ...(t.context || {}) },
  }));

  const { data, error } = await supabase
    .from('coach_todos')
    .insert(rows)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, created: data?.length || 0, todos: data });
});

// Delete a pending onboarding — cascade deletes everything (Trainerize user + Monday item + Supabase rows)
app.delete('/api/intake/pending/:id', async (req, res) => {
  const pendingId = req.params.id;
  const { data: pending } = await supabase
    .from('pending_onboardings')
    .select('*')
    .eq('id', pendingId)
    .single();
  if (!pending) return res.status(404).json({ error: 'Not found' });

  const errors = [];

  // 1. Delete Trainerize user
  if (pending.trainerize_user_id) {
    try {
      const auth = Buffer.from(`${process.env.TRAINERIZE_GROUP_ID}:${process.env.TRAINERIZE_API_TOKEN}`).toString('base64');
      const r = await fetch('https://api.trainerize.com/v03/user/delete', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ userID: pending.trainerize_user_id }),
      });
      if (!r.ok && r.status !== 404) errors.push(`Trainerize: ${r.status}`);
    } catch (e) { errors.push(`Trainerize: ${e.message}`); }
  }

  // 2. Delete Monday item
  if (pending.monday_item_id) {
    try {
      const r = await fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: process.env.MONDAY_API_TOKEN || process.env.MONDAY_API_KEY },
        body: JSON.stringify({ query: `mutation { delete_item (item_id: ${pending.monday_item_id}) { id } }` }),
      });
      if (!r.ok) errors.push(`Monday: ${r.status}`);
    } catch (e) { errors.push(`Monday: ${e.message}`); }
  }

  // 3. Delete Supabase rows (pending + intake_submissions)
  await supabase.from('pending_onboardings').delete().eq('id', pendingId);
  if (pending.intake_submission_id) {
    await supabase.from('intake_submissions').delete().eq('id', pending.intake_submission_id);
  }

  res.json({ ok: true, deletedId: pendingId, errors: errors.length ? errors : null });
});

// ─── DASHBOARD MACRO VIEWS ──────────────────────────────────────
// Compliance heatmap — all active clients × last 14 days
app.get('/api/dashboard/heatmap', async (_req, res) => {
  try {
    const { data: clients } = await supabase
      .from('clients')
      .select('id, full_name, trainerize_user_id')
      .eq('is_active', true)
      .order('full_name');
    if (!clients) return res.json({ clients: [], days: [] });

    const today = new Date();
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(today); d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const cutoff = days[0];

    const { data: snaps } = await supabase
      .from('daily_snapshots')
      .select('client_id, snapshot_date, flag_color')
      .gte('snapshot_date', cutoff)
      .order('snapshot_date');
    const snapMap = {};
    for (const s of snaps || []) {
      if (!snapMap[s.client_id]) snapMap[s.client_id] = {};
      snapMap[s.client_id][s.snapshot_date] = s.flag_color;
    }

    const rows = clients.map(c => ({
      client_id: c.id,
      name: c.full_name,
      trainerize_user_id: c.trainerize_user_id,
      cells: days.map(d => snapMap[c.id]?.[d] || null),
    }));
    res.json({ clients: rows, days });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Movers — climbing + declining clients last 7d vs prior 7d
app.get('/api/dashboard/movers', async (_req, res) => {
  try {
    const today = new Date();
    const day = (offset) => { const d = new Date(today); d.setDate(d.getDate() - offset); return d.toISOString().slice(0, 10); };
    const start = day(13), mid = day(7);

    const { data: clients } = await supabase
      .from('clients').select('id, full_name').eq('is_active', true);
    const { data: snaps } = await supabase
      .from('daily_snapshots')
      .select('client_id, snapshot_date, days_logged_last_7, workout_completion_pct, weight_trajectory')
      .gte('snapshot_date', start)
      .order('snapshot_date', { ascending: false });

    const latest = {}; // most recent snapshot per client
    const prior = {};  // ~7d ago snapshot per client
    for (const s of snaps || []) {
      if (!latest[s.client_id]) latest[s.client_id] = s;
      else if (s.snapshot_date < mid && !prior[s.client_id]) prior[s.client_id] = s;
    }

    const movers = [];
    for (const c of clients || []) {
      const L = latest[c.id], P = prior[c.id];
      if (!L) continue;
      const logCur = L.days_logged_last_7 || 0;
      const logPrev = P?.days_logged_last_7 || 0;
      const wkCur = L.workout_completion_pct || 0;
      const wkPrev = P?.workout_completion_pct || 0;
      const score = (logCur - logPrev) * 5 + (wkCur - wkPrev) * 100;
      movers.push({ client_id: c.id, name: c.full_name, score, log_delta: logCur - logPrev, workout_delta: wkCur - wkPrev, weight_trajectory: L.weight_trajectory });
    }
    movers.sort((a, b) => b.score - a.score);
    res.json({ climbing: movers.slice(0, 5), declining: movers.slice(-5).reverse() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Stuck list — clients with no recent weight change AND green compliance
app.get('/api/dashboard/stuck', async (_req, res) => {
  try {
    const { data: clients } = await supabase
      .from('clients').select('id, full_name, goal_weight_lbs, starting_weight_lbs')
      .eq('is_active', true);
    const { data: snaps } = await supabase
      .from('daily_snapshots')
      .select('client_id, snapshot_date, flag_color, weight_trajectory, weight_change_last_4wk')
      .order('snapshot_date', { ascending: false })
      .limit(2000);

    const latest = {};
    for (const s of snaps || []) {
      if (!latest[s.client_id]) latest[s.client_id] = s;
    }

    const stuck = [];
    for (const c of clients || []) {
      const s = latest[c.id];
      if (!s) continue;
      const flatOrNeutral = (s.weight_trajectory === 'neutral' || (Math.abs(s.weight_change_last_4wk || 0) < 0.5));
      const compliant = s.flag_color === 'green';
      if (flatOrNeutral && compliant) {
        stuck.push({
          client_id: c.id,
          name: c.full_name,
          goal_weight_lbs: c.goal_weight_lbs,
          starting_weight_lbs: c.starting_weight_lbs,
          weight_change_4wk: s.weight_change_last_4wk,
        });
      }
    }
    res.json({ stuck });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Goal trajectory — clients with set goals, projected hit-date based on rate
app.get('/api/dashboard/goal-trajectory', async (_req, res) => {
  try {
    const { data: clients } = await supabase
      .from('clients')
      .select('id, full_name, goal_weight_lbs, starting_weight_lbs, start_date')
      .eq('is_active', true)
      .not('goal_weight_lbs', 'is', null)
      .not('starting_weight_lbs', 'is', null);

    const { data: checkins } = await supabase
      .from('weekly_checkins')
      .select('client_id, weight_lbs, checkin_date')
      .not('weight_lbs', 'is', null)
      .order('checkin_date', { ascending: false });

    // Build per-client weight history (last 4 weigh-ins)
    const history = {};
    for (const w of checkins || []) {
      if (!history[w.client_id]) history[w.client_id] = [];
      if (history[w.client_id].length < 4) history[w.client_id].push(w);
    }

    const rows = [];
    for (const c of clients || []) {
      const h = (history[c.id] || []).slice().sort((a, b) => new Date(b.checkin_date) - new Date(a.checkin_date));
      const current = h[0]?.weight_lbs;
      // Rate: lbs/week between latest and oldest of the 4
      let rate = null, projectedDate = null;
      if (h.length >= 2) {
        const latest = h[0], earliest = h[h.length - 1];
        const weeks = (new Date(latest.checkin_date) - new Date(earliest.checkin_date)) / (1000 * 60 * 60 * 24 * 7);
        if (weeks > 0) rate = (latest.weight_lbs - earliest.weight_lbs) / weeks; // negative = losing
        if (rate && current && c.goal_weight_lbs) {
          const needed = c.goal_weight_lbs - current;
          if ((needed < 0 && rate < 0) || (needed > 0 && rate > 0)) {
            const weeksToGoal = needed / rate;
            const d = new Date(); d.setDate(d.getDate() + Math.round(weeksToGoal * 7));
            projectedDate = d.toISOString().slice(0, 10);
          }
        }
      }
      const totalNeeded = c.goal_weight_lbs - c.starting_weight_lbs;
      const totalProgress = (current || c.starting_weight_lbs) - c.starting_weight_lbs;
      rows.push({
        client_id: c.id,
        name: c.full_name,
        start_weight: c.starting_weight_lbs,
        current_weight: current,
        goal_weight: c.goal_weight_lbs,
        rate_lbs_per_week: rate ? Math.round(rate * 10) / 10 : null,
        projected_hit_date: projectedDate,
        progress_pct: totalNeeded !== 0 ? Math.round((totalProgress / totalNeeded) * 100) : null,
        on_pace: projectedDate ? true : false,
      });
    }
    rows.sort((a, b) => (a.on_pace ? 0 : 1) - (b.on_pace ? 0 : 1));
    res.json({ trajectories: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch meal plan generation — spawn meal-plan-gen.js for N clients  [LOCAL_ONLY — writes PDFs to ~/Downloads]
app.post('/api/batch/meal-plans', async (req, res) => {
  if (guardLocalOnly(res, '/api/batch/meal-plans')) return;
  try {
    const { client_ids } = req.body;
    if (!Array.isArray(client_ids) || client_ids.length === 0) {
      return res.status(400).json({ error: 'client_ids array required' });
    }
    const { data: clients } = await supabase
      .from('clients').select('id, full_name, trainerize_user_id').in('id', client_ids);
    const results = [];
    for (const c of clients || []) {
      const proc = spawn('node', [`${__dirname}/meal-plan-gen.js`, c.trainerize_user_id], { cwd: __dirname });
      let output = '';
      proc.stdout.on('data', d => { output += d.toString(); });
      proc.stderr.on('data', d => { output += d.toString(); });
      const exitCode = await new Promise(resolve => proc.on('close', resolve));
      results.push({ client_id: c.id, name: c.full_name, ok: exitCode === 0, output: output.slice(-500) });
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Draft per-client nudge messages using recent data + Zach voice
app.post('/api/batch/nudge/draft', async (req, res) => {
  try {
    const { client_ids } = req.body;
    if (!Array.isArray(client_ids) || client_ids.length === 0) return res.status(400).json({ error: 'client_ids required' });
    const { data: clients } = await supabase
      .from('clients').select('id, full_name, trainerize_user_id, goal_weight_lbs, starting_weight_lbs, daily_calorie_target, daily_protein_target_g').in('id', client_ids);

    // Pull latest snapshot per client
    const { data: snaps } = await supabase
      .from('daily_snapshots')
      .select('client_id, snapshot_date, flag_color, days_logged_last_7, workout_completion_pct, avg_calories_7d, avg_protein_g_7d, weight_trajectory')
      .order('snapshot_date', { ascending: false });
    const latest = {};
    for (const s of snaps || []) { if (!latest[s.client_id]) latest[s.client_id] = s; }

    const drafts = [];
    for (const c of clients || []) {
      const s = latest[c.id] || {};
      const ctx = [];
      ctx.push(`Client: ${c.full_name}`);
      if (c.goal_weight_lbs && c.starting_weight_lbs) ctx.push(`Goal: ${c.starting_weight_lbs} → ${c.goal_weight_lbs} lbs`);
      if (s.flag_color) ctx.push(`Current tier: ${s.flag_color}`);
      if (s.days_logged_last_7 != null) ctx.push(`Logged ${s.days_logged_last_7}/7 days last week`);
      if (s.workout_completion_pct != null) ctx.push(`Workout completion: ${Math.round(s.workout_completion_pct)}%`);
      if (s.avg_calories_7d) ctx.push(`Avg cals: ${s.avg_calories_7d} (target ${c.daily_calorie_target || '?'})`);
      if (s.avg_protein_g_7d) ctx.push(`Avg protein: ${s.avg_protein_g_7d}g (target ${c.daily_protein_target_g || '?'}g)`);
      if (s.weight_trajectory) ctx.push(`Weight trend: ${s.weight_trajectory}`);

      const prompt = `You are Coach Zach writing a quick supportive nudge message to a client via Trainerize.

CLIENT DATA:
${ctx.join('\n')}

VOICE RULES (strict):
- Open with "Hey [first name]" or "Hey hey" or "Hey brotha/my man" for male clients
- NEVER use em dashes (use commas or periods instead)
- Use "we/our" not "you/your" (collaborative)
- 5th grade reading level. Short sentences. No big words.
- 2 to 3 sentences MAX. Punchy.
- Mention 1 specific thing you see in their data
- Ask 1 question or offer 1 way to support
- Sound warm and direct, like a coach who actually cares

DO NOT include any greeting beyond first sentence. DO NOT include sign-off. Just the message body.
Output ONLY the message text. No quotes, no preamble.`;

      try {
        const resp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = (resp.content[0]?.text || '').trim().replace(/[—–]/g, ',');
        drafts.push({ client_id: c.id, name: c.full_name, trainerize_user_id: c.trainerize_user_id, draft: text });
      } catch (e) {
        drafts.push({ client_id: c.id, name: c.full_name, trainerize_user_id: c.trainerize_user_id, draft: '', error: e.message });
      }
    }
    res.json({ ok: true, drafts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch nudge — send messages to N clients via Trainerize /message/reply
// Accepts either: { client_ids, message } (same msg to all) OR { messages: [{client_id, trainerize_user_id, message}] } (per-client)
app.post('/api/batch/nudge', async (req, res) => {
  try {
    let messages = req.body.messages;
    if (!messages && req.body.client_ids && req.body.message) {
      const { data: clients } = await supabase
        .from('clients').select('id, full_name, trainerize_user_id').in('id', req.body.client_ids);
      messages = (clients || []).map(c => ({ client_id: c.id, trainerize_user_id: c.trainerize_user_id, name: c.full_name, message: req.body.message }));
    }
    if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'messages required' });

    // Resolve threads via Trainerize getThreads (Zach's inbox = userID 3525989)
    const TZ_BASE = 'https://api.trainerize.com/v03';
    const basic = Buffer.from(`${process.env.TRAINERIZE_GROUP_ID}:${process.env.TRAINERIZE_API_TOKEN}`).toString('base64');
    const tzHeaders = { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/json' };
    const threadMap = {};
    for (let page = 0; page < 5; page++) {
      const r = await fetch(`${TZ_BASE}/message/getThreads`, {
        method: 'POST', headers: tzHeaders,
        body: JSON.stringify({ view: 'inbox', userID: 3525989, start: page * 200, count: 200 }),
      });
      const d = await r.json();
      const threads = d.threads || [];
      if (!threads.length) break;
      for (const t of threads) {
        for (const cc of (t.ccUsers || [])) {
          if (cc.userID && !threadMap[cc.userID]) threadMap[cc.userID] = t.id || t.threadID;
        }
      }
      if (threads.length < 200) break;
    }

    const results = [];
    for (const m of messages) {
      const uid = parseInt(m.trainerize_user_id);
      const tid = threadMap[uid];
      if (!tid) { results.push({ client_id: m.client_id, name: m.name, ok: false, error: 'no thread' }); continue; }
      const body = (m.message || '').replace(/[—–]/g, ',').trim();
      if (!body) { results.push({ client_id: m.client_id, name: m.name, ok: false, error: 'empty message' }); continue; }
      try {
        const r = await fetch(`${TZ_BASE}/message/reply`, {
          method: 'POST', headers: tzHeaders,
          body: JSON.stringify({ threadID: tid, body }),
        });
        results.push({ client_id: m.client_id, name: m.name, ok: r.ok });
      } catch (e) {
        results.push({ client_id: m.client_id, name: m.name, ok: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 400));
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Generate to-dos from goals — full-roster goal-trajectory sync
app.post('/api/todos/generate-from-goals', async (_req, res) => {
  try {
    const result = await generateGoalToDos({ supabase });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── INTAKE POLLER ───────────────────────────────────────────────
// Every 60s, check Supabase for new intake_submissions w/o a matching
// pending_onboardings row. Fire pipeline for any found.
async function pollIntakeSubmissions() {
  try {
    const { data: orphans, error } = await supabase
      .from('intake_submissions')
      .select('id, full_name, email, submitted_at')
      .order('submitted_at', { ascending: false })
      .limit(50);
    if (error || !orphans) return;
    for (const o of orphans) {
      const { data: existing } = await supabase
        .from('pending_onboardings')
        .select('id')
        .eq('intake_submission_id', o.id)
        .limit(1);
      if (existing && existing.length) continue;
      console.log(`[poller] firing pipeline for intake_id=${o.id} (${o.full_name})`);
      processIntakeSubmission({ supabase, intake_id: o.id })
        .then(r => console.log(`[poller:${o.id}] result:`, r.status))
        .catch(e => console.error(`[poller:${o.id}] error:`, e.message));
    }
  } catch (e) {
    console.error('[poller] error:', e.message);
  }
}

// Bind 0.0.0.0 so Railway's healthcheck can reach the container.
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`🟢 Faerber Client OS server running`);
  console.log(`   Dashboard: http://${HOST}:${PORT}/`);
  console.log(`   Health:    http://${HOST}:${PORT}/api/health`);
  console.log(`   Mode:      ${IS_LOCAL_ONLY ? 'LOCAL (Python/Playwright routes enabled)' : 'CLOUD (LOCAL_ONLY routes 501)'}`);
  // Start intake poller
  pollIntakeSubmissions();
  setInterval(pollIntakeSubmissions, 60000);
  console.log(`   Intake poller: every 60s`);
  // Start cloud cron jobs (no-op locally when LOCAL_ONLY=true — launchd handles it)
  startCronJobs();
});

// Graceful shutdown so Railway / Docker can restart cleanly without dropping in-flight requests.
function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing server...`);
  server.close(err => {
    if (err) {
      console.error('[shutdown] error closing server:', err);
      process.exit(1);
    }
    console.log('[shutdown] closed cleanly');
    process.exit(0);
  });
  // Force-exit after 10s if requests are hanging
  setTimeout(() => {
    console.warn('[shutdown] force-exiting after 10s');
    process.exit(1);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
