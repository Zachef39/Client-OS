// Clients API — v2 endpoints backing the Clients tab.
// Roster + countdown + extension window + per-client detail + programmed_to sync.
// PLUS per-client goal-progress fields (progress_status, pct_to_goal, etc)
// so the UI can lead with weight-loss progress instead of resign tier.
//
// All queries assume the client_countdown VIEW exists w/ columns:
//   id, full_name, coach_name, programmed_to, days_until_resign, tier

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { cachedFetch } from './cache.js';
import { sbRetry } from './supabase-retry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Per-Supabase-call cap so one slow query can't hold up whole endpoint.
// Node's AbortSignal.timeout is Node 17+ — Railway/Docker ship recent Node, safe.
const SUPABASE_TIMEOUT_MS = 10_000;
function sbSignal() {
  // Wrap in try — bail to unsignalled fetch on old runtimes rather than crash.
  try { return AbortSignal.timeout(SUPABASE_TIMEOUT_MS); }
  catch { return undefined; }
}
// supabase-js supports .abortSignal() on QueryBuilder — attach if available.
function withTimeout(query) {
  const sig = sbSignal();
  if (!sig || typeof query.abortSignal !== 'function') return query;
  return query.abortSignal(sig);
}
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const TIERS = new Set(['critical', 'urgent', 'watch', 'monitor', 'ok', 'unknown']);
const PROGRESS_STATUSES = new Set(['crushing', 'on_track', 'slipping', 'struggling', 'new_no_data']);
const DEFAULT_PROGRAM_WEEKS = 26; // ~6 mo default arc
const MAX_WEEKLY_RATE = 1.0;      // cap expected loss at 1 lb/wk
const NEW_CLIENT_DAYS = 14;
const STALE_CHECKIN_DAYS = 21;

// Compute goal-progress fields for one client.
// Inputs — starting_weight, goal_weight, start_date (ISO), latest_weight, last_checkin_date (ISO), today (Date).
// Returns everything the UI needs to render Start → Current → Goal + status pill + %-to-goal bar.
function computeProgress({ starting_weight, goal_weight, start_date, latest_weight, last_checkin_date, today }) {
  const out = {
    starting_weight: starting_weight ?? null,
    goal_weight: goal_weight ?? null,
    current_weight: latest_weight ?? null,
    pounds_lost: null,
    pounds_to_go: null,
    pct_to_goal: null,          // 0-100+ (of full goal)
    weeks_in_program: null,
    expected_loss: null,
    progress_pct: null,         // 0-100+ (actual vs expected)
    progress_status: 'new_no_data',
    status_reason: '',
    last_checkin_date: last_checkin_date || null,
    days_since_checkin: null,
  };

  // Days since last check-in — used both for status + "hasn't checked in in X days" copy.
  if (last_checkin_date) {
    const lc = new Date(last_checkin_date);
    if (!Number.isNaN(lc.getTime())) {
      out.days_since_checkin = Math.max(0, Math.floor((today - lc) / 86_400_000));
    }
  }

  // Weeks in program.
  if (start_date) {
    const sd = new Date(start_date);
    if (!Number.isNaN(sd.getTime())) {
      out.weeks_in_program = Math.max(0, Math.floor((today - sd) / (86_400_000 * 7)));
    }
  }

  // Need start weight + goal weight + start date to score progress.
  const hasCoreData = starting_weight != null && goal_weight != null && start_date != null;
  if (!hasCoreData) {
    out.status_reason = 'Missing starting weight, goal weight, or start date.';
    return out;
  }
  if (out.weeks_in_program != null && out.weeks_in_program < 2) {
    out.progress_status = 'new_no_data';
    out.status_reason = `${out.weeks_in_program} weeks in program — too early to score progress.`;
    return out;
  }
  if (latest_weight == null) {
    out.progress_status = 'new_no_data';
    out.status_reason = 'No weight check-ins logged yet.';
    return out;
  }

  const totalTarget = starting_weight - goal_weight;  // positive when losing
  const actualLoss = starting_weight - latest_weight; // positive when losing
  out.pounds_lost = Number(actualLoss.toFixed(1));
  out.pounds_to_go = Number((latest_weight - goal_weight).toFixed(1));
  if (totalTarget > 0) {
    out.pct_to_goal = Math.round((actualLoss / totalTarget) * 100);
  } else {
    out.pct_to_goal = null; // maintenance / gain goal
  }

  // Expected loss at this point in program.
  const weeks = out.weeks_in_program || 0;
  const expectedRate = totalTarget > 0 ? Math.min(MAX_WEEKLY_RATE, totalTarget / DEFAULT_PROGRAM_WEEKS) : 0;
  const expected = expectedRate * weeks;
  out.expected_loss = Number(expected.toFixed(1));
  if (expected > 0) {
    out.progress_pct = Math.round((actualLoss / expected) * 100);
  }

  // Status classification.
  const stale = out.days_since_checkin != null && out.days_since_checkin > STALE_CHECKIN_DAYS;
  if (actualLoss < 0) {
    // Gained weight from start.
    out.progress_status = 'struggling';
    out.status_reason = `Up ${Math.abs(out.pounds_lost)} lb from start. Reach out.`;
  } else if (stale) {
    out.progress_status = 'struggling';
    out.status_reason = `No check-in in ${out.days_since_checkin} days. Reach out.`;
  } else if (expected <= 0) {
    // Maintenance or unusual goal — don't over-score; call it On Track by default.
    out.progress_status = 'on_track';
    out.status_reason = 'Maintenance goal or no weight target — treating as on track.';
  } else if (out.progress_pct >= 100) {
    out.progress_status = 'crushing';
    out.status_reason = `Down ${out.pounds_lost} lb in ${weeks}w. Expected ${out.expected_loss} — ahead of pace.`;
  } else if (out.progress_pct >= 75) {
    out.progress_status = 'on_track';
    out.status_reason = `Down ${out.pounds_lost} lb in ${weeks}w. Expected ${out.expected_loss} — on pace.`;
  } else if (out.progress_pct >= 40) {
    out.progress_status = 'slipping';
    out.status_reason = `Down ${out.pounds_lost} lb in ${weeks}w. Expected ${out.expected_loss} — behind pace.`;
  } else {
    out.progress_status = 'struggling';
    out.status_reason = `Down ${out.pounds_lost} lb in ${weeks}w. Expected ${out.expected_loss} — well behind pace.`;
  }

  return out;
}

/**
 * Fetch base countdown rows once + hydrate the roster with last note date + open todo count.
 * Returns { rows, warnings[] } — never throws so the endpoint can degrade to partial.
 */
async function loadRosterBase(supabase) {
  const warnings = [];
  const [countdownRes, clientsRes] = await Promise.allSettled([
    sbRetry(() => withTimeout(supabase
      .from('client_countdown')
      .select('id, full_name, coach_name, programmed_to, days_until_resign, tier'))),
    sbRetry(() => withTimeout(supabase
      .from('clients')
      .select('id, full_name, assigned_coach, client_status, is_active, is_internal, email, phone, instagram_handle, start_date, goal, goal_weight_lbs, starting_weight_lbs, daily_calorie_target, daily_protein_target_g, program_term, program_dropdown, age, location, weekly_target_workouts')
      .eq('is_active', true))),
  ]);

  const countdown = countdownRes.status === 'fulfilled' && !countdownRes.value.error
    ? countdownRes.value.data
    : (warnings.push(`countdown: ${countdownRes.reason?.message || countdownRes.value?.error?.message}`), []);
  const clientsRaw = clientsRes.status === 'fulfilled' && !clientsRes.value.error
    ? clientsRes.value.data
    : (warnings.push(`clients: ${clientsRes.reason?.message || clientsRes.value?.error?.message}`), []);

  // If BOTH failed we can't render anything meaningful — surface an error.
  if (!countdown?.length && !clientsRaw?.length && warnings.length >= 2) {
    const err = new Error(`roster unreachable: ${warnings.join('; ')}`);
    err._roster_failed = true;
    throw err;
  }

  const clientMap = new Map();
  for (const c of clientsRaw || []) clientMap.set(c.id, c);

  // Rows in countdown are keyed to active clients; filter out internal accounts
  // (Zach, JJ Crawford, Julia Borba, etc — they show is_active=true but shouldn't
  // appear in the coaching roster) then merge in status + start_date + goal weights.
  const rows = (countdown || [])
    .filter(r => {
      const base = clientMap.get(r.id);
      return base && base.is_internal !== true;
    })
    .map(r => {
    const base = clientMap.get(r.id) || {};
    return {
      id: r.id,
      name: r.full_name,
      coach: base.assigned_coach || null,
      coach_display: base.assigned_coach || '(unassigned)',
      programmed_to: r.programmed_to,
      days_until_resign: r.days_until_resign,
      tier: r.tier || 'unknown',
      status: base.client_status || null,
      start_date: base.start_date || null,
      starting_weight_lbs: base.starting_weight_lbs ?? null,
      goal_weight_lbs: base.goal_weight_lbs ?? null,
      goal: base.goal || null,
    };
  });

  return { rows, clientMap, warnings };
}

/**
 * Batch-load last note per client_id + open todo count per client_id + latest check-in + churn risk.
 * Never throws — any chunk that fails returns empty + adds a warning. Callers get partial data.
 */
async function loadRosterExtras(supabase, ids) {
  const empty = {
    lastNoteByClient: new Map(),
    openTodosByClient: new Map(),
    latestCheckinByClient: new Map(),
    churnByClient: new Map(),
    warnings: [],
  };
  if (!ids.length) return empty;

  const [notesRes, todosRes, checkinsRes, churnRes] = await Promise.allSettled([
    sbRetry(() => withTimeout(supabase
      .from('client_notes')
      .select('client_id, created_at')
      .in('client_id', ids)
      .order('created_at', { ascending: false }))),
    sbRetry(() => withTimeout(supabase
      .from('coach_todos')
      .select('client_id, status')
      .in('client_id', ids)
      .in('status', ['open', 'snoozed']))),
    // Pull recent weighed check-ins; we'll pick latest per client in JS to keep it one query.
    sbRetry(() => withTimeout(supabase
      .from('weekly_checkins')
      .select('client_id, checkin_date, weight_lbs')
      .in('client_id', ids)
      .not('weight_lbs', 'is', null)
      .order('checkin_date', { ascending: false })
      .limit(3000))),
    sbRetry(() => withTimeout(supabase
      .from('client_churn_risk')
      .select('client_id, risk_tier, risk_score, primary_reasons, recommended_action, scored_at')
      .in('client_id', ids)
      .order('scored_at', { ascending: false }))),
  ]);

  const warnings = [];
  const dataFrom = (settled, label) => {
    if (settled.status !== 'fulfilled') { warnings.push(`${label}: ${settled.reason?.message || 'failed'}`); return []; }
    if (settled.value.error) { warnings.push(`${label}: ${settled.value.error.message}`); return []; }
    return settled.value.data || [];
  };
  const notes = dataFrom(notesRes, 'notes');
  const todos = dataFrom(todosRes, 'todos');
  const checkins = dataFrom(checkinsRes, 'checkins');
  const churn = dataFrom(churnRes, 'churn');

  const lastNoteByClient = new Map();
  for (const n of notes) {
    if (!lastNoteByClient.has(n.client_id)) lastNoteByClient.set(n.client_id, n.created_at);
  }
  const openTodosByClient = new Map();
  for (const t of todos) {
    openTodosByClient.set(t.client_id, (openTodosByClient.get(t.client_id) || 0) + 1);
  }
  const latestCheckinByClient = new Map();
  for (const c of checkins) {
    if (!latestCheckinByClient.has(c.client_id)) {
      latestCheckinByClient.set(c.client_id, { date: c.checkin_date, weight: c.weight_lbs });
    }
  }
  const churnByClient = new Map();
  for (const r of churn) {
    if (!churnByClient.has(r.client_id)) churnByClient.set(r.client_id, r);
  }
  return { lastNoteByClient, openTodosByClient, latestCheckinByClient, churnByClient, warnings };
}

export function registerClientsRoutes({ app, supabase }) {
  // ── Roster ──────────────────────────────────────────────────
  // Returns per-client goal-progress fields so the UI can lead with weight loss.
  // Cached 30s — the roster changes at most once per check-in / reassign.
  app.get('/api/v2/clients', async (req, res) => {
    const tier = String(req.query.tier || 'all').toLowerCase();
    const progressStatus = String(req.query.progress_status || 'all').toLowerCase();
    const coach = String(req.query.coach || 'all');
    const search = String(req.query.search || '').trim().toLowerCase();
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 200));

    try {
      // Cache the raw (pre-filter) roster so filter/search hits are instant.
      const roster = await cachedFetch('clients:roster', 30_000, async () => {
        const { rows, warnings: baseWarnings } = await loadRosterBase(supabase);
        const ids = rows.map(r => r.id);
        const extras = await loadRosterExtras(supabase, ids);
        return { rows, ...extras, warnings: [...baseWarnings, ...(extras.warnings || [])] };
      });
      const { rows, lastNoteByClient, openTodosByClient, latestCheckinByClient, churnByClient, warnings } = roster;

      const today = new Date();
      let out = rows.map(r => {
        const latest = latestCheckinByClient.get(r.id);
        const progress = computeProgress({
          starting_weight: r.starting_weight_lbs,
          goal_weight: r.goal_weight_lbs,
          start_date: r.start_date,
          latest_weight: latest ? latest.weight : null,
          last_checkin_date: latest ? latest.date : null,
          today,
        });
        const churn = churnByClient.get(r.id) || null;
        return {
          ...r,
          last_note_at: lastNoteByClient.get(r.id) || null,
          active_todos: openTodosByClient.get(r.id) || 0,
          // Progress fields (primary UI)
          starting_weight: progress.starting_weight,
          goal_weight: progress.goal_weight,
          current_weight: progress.current_weight,
          pounds_lost: progress.pounds_lost,
          pounds_to_go: progress.pounds_to_go,
          pct_to_goal: progress.pct_to_goal,
          weeks_in_program: progress.weeks_in_program,
          expected_loss: progress.expected_loss,
          progress_pct: progress.progress_pct,
          progress_status: progress.progress_status,
          status_reason: progress.status_reason,
          last_checkin_date: progress.last_checkin_date,
          days_since_checkin: progress.days_since_checkin,
          churn_risk_tier: churn ? churn.risk_tier : null,
        };
      });

      // Filters
      if (tier !== 'all' && TIERS.has(tier)) {
        out = out.filter(r => r.tier === tier);
      }
      if (progressStatus !== 'all' && PROGRESS_STATUSES.has(progressStatus)) {
        out = out.filter(r => r.progress_status === progressStatus);
      }
      if (coach !== 'all') {
        out = out.filter(r => r.coach_display === coach);
      }
      if (search) {
        out = out.filter(r =>
          (r.name || '').toLowerCase().includes(search) ||
          (r.coach_display || '').toLowerCase().includes(search)
        );
      }

      // Distinct coaches (from unfiltered set).
      const coaches = Array.from(new Set(rows.map(r => r.coach_display))).sort((a, b) => {
        if (a === '(unassigned)') return 1;
        if (b === '(unassigned)') return -1;
        return a.localeCompare(b);
      });

      // Bucket counts (before pagination) — computed from the FULL roster so the
      // KPI header always reflects "X of your 62 active clients", regardless of filters.
      const fullRoster = rows.map(r => {
        const latest = latestCheckinByClient.get(r.id);
        return computeProgress({
          starting_weight: r.starting_weight_lbs,
          goal_weight: r.goal_weight_lbs,
          start_date: r.start_date,
          latest_weight: latest ? latest.weight : null,
          last_checkin_date: latest ? latest.date : null,
          today,
        }).progress_status;
      });
      const buckets = {
        crushing:    fullRoster.filter(s => s === 'crushing').length,
        on_track:    fullRoster.filter(s => s === 'on_track').length,
        slipping:    fullRoster.filter(s => s === 'slipping').length,
        struggling:  fullRoster.filter(s => s === 'struggling').length,
        new_no_data: fullRoster.filter(s => s === 'new_no_data').length,
      };

      // Default sort: pct_to_goal DESC (nulls last). Struggling clients naturally
      // fall low; use progress_status weight as tiebreaker so "Struggling" clients
      // still surface before "New" clients.
      const statusRank = { struggling: 0, slipping: 1, on_track: 2, crushing: 3, new_no_data: 4 };
      out.sort((a, b) => {
        const pa = a.pct_to_goal;
        const pb = b.pct_to_goal;
        if (pa == null && pb == null) {
          return statusRank[a.progress_status] - statusRank[b.progress_status];
        }
        if (pa == null) return 1;
        if (pb == null) return -1;
        return pb - pa;
      });

      res.json({
        total: out.length,
        rows: out.slice(0, limit),
        filters: { tier, progress_status: progressStatus, coach, search, limit },
        coaches,
        buckets,
        active_total: rows.length,
        ...(warnings?.length ? { _warnings: warnings, _partial: true } : {}),
      });
    } catch (e) {
      console.error('[clients/roster]', e);
      // Return 200 w/ empty partial payload — dashboard renders "some data missing"
      // chip rather than a red "Failed to load" full-page banner.
      res.status(200).json({
        _error: e.message,
        _partial: true,
        total: 0,
        rows: [],
        filters: { tier, progress_status: progressStatus, coach, search, limit },
        coaches: [],
        buckets: { crushing: 0, on_track: 0, slipping: 0, struggling: 0, new_no_data: 0 },
        active_total: 0,
      });
    }
  });

  // ── Per-client progress history (for drawer chart) ──────────
  // Returns weekly weight history over the last N weeks + goal + starting values.
  app.get('/api/v2/clients/:id/progress', async (req, res) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'invalid uuid' });
    }
    const weeks = Math.max(4, Math.min(52, Number(req.query.weeks) || 12));
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - weeks * 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    try {
      const [profileRes, checkinsRes] = await Promise.all([
        sbRetry(() => supabase.from('clients')
          .select('id, full_name, starting_weight_lbs, goal_weight_lbs, start_date')
          .eq('id', id)
          .single()),
        sbRetry(() => supabase.from('weekly_checkins')
          .select('checkin_date, weight_lbs')
          .eq('client_id', id)
          .not('weight_lbs', 'is', null)
          .gte('checkin_date', cutoffStr)
          .order('checkin_date', { ascending: true })),
      ]);
      if (profileRes.error) throw profileRes.error;
      if (checkinsRes.error) throw checkinsRes.error;
      const profile = profileRes.data;
      if (!profile) return res.status(404).json({ error: 'client not found' });

      // Reduce to one point per date (dedupe multiple same-day check-ins by taking latest).
      const byDate = new Map();
      for (const c of checkinsRes.data || []) {
        byDate.set(c.checkin_date, c.weight_lbs);
      }
      const points = Array.from(byDate.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, weight]) => ({ date, weight }));

      res.json({
        client_id: id,
        weeks,
        starting_weight: profile.starting_weight_lbs,
        goal_weight: profile.goal_weight_lbs,
        start_date: profile.start_date,
        points,
      });
    } catch (e) {
      console.error('[clients/progress]', id, e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Countdown (raw view) ────────────────────────────────────
  app.get('/api/v2/clients/countdown', async (_req, res) => {
    try {
      const { data, error } = await sbRetry(() => supabase
        .from('client_countdown')
        .select('id, full_name, coach_name, programmed_to, days_until_resign, tier'));
      if (error) throw error;
      // Sort nulls last, asc by days.
      const rows = (data || []).slice().sort((a, b) => {
        const da = a.days_until_resign;
        const db = b.days_until_resign;
        if (da == null && db == null) return (a.full_name || '').localeCompare(b.full_name || '');
        if (da == null) return 1;
        if (db == null) return -1;
        return da - db;
      });
      res.json({ rows });
    } catch (e) {
      console.error('[clients/countdown]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Extensions window (≤ N days) ────────────────────────────
  app.get('/api/v2/clients/extensions', async (req, res) => {
    try {
      const days = Math.max(1, Math.min(180, Number(req.query.days) || 30));
      const { data, error } = await sbRetry(() => supabase
        .from('client_countdown')
        .select('id, full_name, coach_name, programmed_to, days_until_resign, tier')
        .not('days_until_resign', 'is', null)
        .lte('days_until_resign', days));
      if (error) throw error;
      const rows = (data || []).slice().sort(
        (a, b) => (a.days_until_resign ?? 999) - (b.days_until_resign ?? 999)
      );
      const buckets = {
        critical: rows.filter(r => r.tier === 'critical').length,
        urgent:   rows.filter(r => r.tier === 'urgent').length,
        watch:    rows.filter(r => r.tier === 'watch').length,
        monitor:  rows.filter(r => r.tier === 'monitor').length,
      };
      res.json({ days, buckets, rows });
    } catch (e) {
      console.error('[clients/extensions]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Per-client detail ───────────────────────────────────────
  app.get('/api/v2/clients/:id/detail', async (req, res) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(400).json({ error: 'invalid uuid' });
    }
    try {
      const [profileRes, countdownRes, programStateRes, notesRes, rulesRes, todosRes] = await Promise.all([
        sbRetry(() => supabase.from('clients').select('*').eq('id', id).single()),
        sbRetry(() => supabase.from('client_countdown').select('*').eq('id', id).maybeSingle()),
        sbRetry(() => supabase.from('client_program_state').select('*').eq('client_id', id).maybeSingle()),
        sbRetry(() => supabase.from('client_notes').select('id, note_type, body, tags, pinned, created_by, created_at')
          .eq('client_id', id).order('created_at', { ascending: false }).limit(5)),
        sbRetry(() => supabase.from('client_rules').select('id, category, rule_text, severity, active, added_at')
          .eq('client_id', id).eq('active', true).order('added_at', { ascending: false })),
        sbRetry(() => supabase.from('coach_todos').select('id, category, note, status, priority, created_at, snooze_until')
          .eq('client_id', id).in('status', ['open', 'snoozed']).order('created_at', { ascending: false })),
      ]);
      if (profileRes.error) throw profileRes.error;

      const profile = profileRes.data;
      if (!profile) return res.status(404).json({ error: 'client not found' });

      res.json({
        profile,
        countdown: countdownRes.data || null,
        program_state: programStateRes.data || null,
        recent_notes: notesRes.data || [],
        rules: rulesRes.data || [],
        open_todos: todosRes.data || [],
      });
    } catch (e) {
      console.error('[clients/detail]', id, e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Trigger Monday → Supabase sync scripts ──────────────────
  registerSyncEndpoint(app, 'sync-programmed-to', 'sync-programmed-to.mjs');
  registerSyncEndpoint(app, 'sync-assigned-coach', 'sync-assigned-coach.mjs');
  registerSyncEndpoint(app, 'sync-client-status', 'sync-client-status.mjs');
  registerSyncEndpoint(app, 'sync-client-profile', 'sync-client-profile.mjs');
}

// Wire a POST /api/v2/clients/<slug> that spawns the given script and echoes result.
function registerSyncEndpoint(app, slug, scriptFilename) {
  app.post(`/api/v2/clients/${slug}`, (_req, res) => {
    const script = path.join(REPO_ROOT, 'scripts', scriptFilename);
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    const proc = spawn('node', [script], {
      cwd: path.join(REPO_ROOT, 'server'),
      env: process.env,
    });
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      const elapsed_ms = Date.now() - started;
      if (code === 0) {
        const m = stdout.match(/done — (\d+) updated · (\d+) failed/);
        res.json({
          ok: true,
          elapsed_ms,
          updated: m ? Number(m[1]) : null,
          failed: m ? Number(m[2]) : null,
          log_tail: stdout.split('\n').slice(-14).join('\n'),
        });
      } else {
        res.status(500).json({
          ok: false,
          elapsed_ms,
          exit_code: code,
          log_tail: (stdout + stderr).split('\n').slice(-20).join('\n'),
        });
      }
    });
    proc.on('error', err => {
      res.status(500).json({ ok: false, error: err.message });
    });
  });
}
