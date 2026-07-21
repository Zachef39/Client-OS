// Team KPI backend — pure helpers over `team_eod` (daily logs) + `team_roster` (identity).
// team_roster is authoritative for who's on the team; team_eod holds their daily activity.
// SEEDED_ROSTER is a last-resort fallback if both tables are empty (first boot).
import { sbRetry } from './supabase-retry.js';

const SEEDED_ROSTER = [
  { va_name: 'Zach', role: 'head_coach' },
  { va_name: 'Dina', role: 'setter' },
  { va_name: 'Sherise', role: 'setter' },
  { va_name: 'Steph', role: 'closer' },
  { va_name: 'Candice', role: 'coach' },
];

function windowDays(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Build a list of ISO date strings from start..end (inclusive).
function dateRange(start, end) {
  const out = [];
  const s = new Date(start);
  const e = new Date(end);
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function safeDiv(a, b) {
  return b > 0 ? a / b : null;
}

// ─── Seed one sample row if the table is empty (so the UI renders) ───
export async function seedIfEmpty(supabase) {
  const { count, error } = await sbRetry(() => supabase
    .from('team_eod')
    .select('id', { count: 'exact', head: true }));
  if (error) throw error;
  if ((count || 0) > 0) return { seeded: false };

  const sample = {
    va_name: 'Zach',
    role: 'coach',
    date: todayStr(),
    dms_sent: 42,
    replies: 11,
    booked_calls: 3,
    shown_calls: 2,
    closes: 1,
    cash_collected: 2500,
    notes: 'sample — delete via SQL when real data starts flowing',
  };
  // no-retry (write path): first-boot seed row
  const { error: insertErr } = await supabase.from('team_eod').insert(sample);
  if (insertErr) throw insertErr;
  return { seeded: true };
}

// ─── Roster: prefer team_roster table, fall back to distinct team_eod names ───
// team_roster is the source of truth for identity; team_eod is daily activity.
export async function getRoster(supabase) {
  const seen = new Map();

  // 1. Primary source: team_roster where is_active=true.
  const { data: rosterRows, error: rosterErr } = await sbRetry(() => supabase
    .from('team_roster')
    .select('name, role, is_active, slack_handle, start_date')
    .eq('is_active', true));
  if (rosterErr && rosterErr.code !== '42P01') throw rosterErr; // 42P01 = table missing
  for (const r of rosterRows || []) {
    if (!r.name) continue;
    seen.set(r.name, {
      va_name: r.name,
      role: r.role || 'setter',
      slack_handle: r.slack_handle || null,
      start_date: r.start_date || null,
    });
  }

  // 2. Union with anyone who has EOD history but isn't in the roster yet.
  const { data: eodRows, error: eodErr } = await sbRetry(() => supabase
    .from('team_eod')
    .select('va_name, role, date')
    .order('date', { ascending: false }));
  if (eodErr) throw eodErr;
  for (const row of eodRows || []) {
    if (!row.va_name) continue;
    if (!seen.has(row.va_name)) {
      seen.set(row.va_name, { va_name: row.va_name, role: row.role || 'setter' });
    }
  }

  // 3. Last-resort seed if both are empty.
  if (seen.size === 0) {
    for (const s of SEEDED_ROSTER) seen.set(s.va_name, s);
  }

  return Array.from(seen.values()).sort((a, b) => a.va_name.localeCompare(b.va_name));
}

// ─── Summary per person over N days ───
export async function getSummary(supabase, days, roleFilter) {
  const { start, end } = windowDays(days);

  let query = supabase
    .from('team_eod')
    .select('*')
    .gte('date', start)
    .lte('date', end);
  if (roleFilter) query = query.eq('role', roleFilter);

  const { data, error } = await sbRetry(() => query);
  if (error) throw error;

  const roster = await getRoster(supabase);
  const rosterMap = new Map(roster.map(r => [r.va_name, r.role]));

  const per = new Map();
  const teamDaily = new Map(); // date -> aggregate

  for (const r of data || []) {
    const name = r.va_name;
    if (!name) continue;
    if (!per.has(name)) {
      per.set(name, {
        va_name: name,
        role: r.role || rosterMap.get(name) || 'setter',
        dms_sent: 0, replies: 0, booked_calls: 0,
        shown_calls: 0, closes: 0, cash_collected: 0,
        days_logged: 0, last_eod: null,
      });
    }
    const p = per.get(name);
    p.dms_sent += Number(r.dms_sent || 0);
    p.replies += Number(r.replies || 0);
    p.booked_calls += Number(r.booked_calls || 0);
    p.shown_calls += Number(r.shown_calls || 0);
    p.closes += Number(r.closes || 0);
    p.cash_collected += Number(r.cash_collected || 0);
    p.days_logged += 1;
    if (!p.last_eod || r.date > p.last_eod) p.last_eod = r.date;

    // Team-level roll-up
    if (!teamDaily.has(r.date)) {
      teamDaily.set(r.date, { date: r.date, dms_sent: 0, replies: 0, booked_calls: 0 });
    }
    const t = teamDaily.get(r.date);
    t.dms_sent += Number(r.dms_sent || 0);
    t.replies += Number(r.replies || 0);
    t.booked_calls += Number(r.booked_calls || 0);
  }

  // Ensure every roster person shows even w/ zero activity in window
  for (const rp of roster) {
    if (roleFilter && rp.role !== roleFilter) continue;
    if (!per.has(rp.va_name)) {
      per.set(rp.va_name, {
        va_name: rp.va_name, role: rp.role,
        dms_sent: 0, replies: 0, booked_calls: 0,
        shown_calls: 0, closes: 0, cash_collected: 0,
        days_logged: 0, last_eod: null,
      });
    }
  }

  const people = Array.from(per.values()).map(p => ({
    ...p,
    reply_rate: safeDiv(p.replies, p.dms_sent),
    dm_to_call_pct: safeDiv(p.dms_sent, p.booked_calls), // DMs per booked call
    booked_to_shown: safeDiv(p.shown_calls, p.booked_calls),
  })).sort((a, b) => (b.booked_calls - a.booked_calls) || (b.dms_sent - a.dms_sent));

  // Team totals + sparks (fill missing days w/ 0)
  const days_full = dateRange(start, end);
  const spark_dms = days_full.map(d => teamDaily.get(d)?.dms_sent || 0);
  const spark_replies = days_full.map(d => teamDaily.get(d)?.replies || 0);
  const spark_booked = days_full.map(d => teamDaily.get(d)?.booked_calls || 0);

  const totals = people.reduce((acc, p) => ({
    dms_sent: acc.dms_sent + p.dms_sent,
    replies: acc.replies + p.replies,
    booked_calls: acc.booked_calls + p.booked_calls,
    shown_calls: acc.shown_calls + p.shown_calls,
    closes: acc.closes + p.closes,
    cash_collected: acc.cash_collected + p.cash_collected,
  }), { dms_sent: 0, replies: 0, booked_calls: 0, shown_calls: 0, closes: 0, cash_collected: 0 });

  const spark_dm_per_call = days_full.map(d => {
    const day = teamDaily.get(d);
    if (!day || day.booked_calls === 0) return 0;
    return day.dms_sent / day.booked_calls;
  });

  return {
    window: { start, end, days },
    totals: {
      ...totals,
      reply_rate: safeDiv(totals.replies, totals.dms_sent),
      dm_to_call_pct: safeDiv(totals.dms_sent, totals.booked_calls),
    },
    sparks: {
      dms: spark_dms,
      replies: spark_replies,
      booked: spark_booked,
      dm_per_call: spark_dm_per_call,
    },
    people,
  };
}

// ─── Daily rows for one person (drill-down) ───
export async function getDaily(supabase, vaName, days) {
  if (!vaName) throw new Error('va_name required');
  const { start, end } = windowDays(days);

  const { data, error } = await sbRetry(() => supabase
    .from('team_eod')
    .select('*')
    .eq('va_name', vaName)
    .gte('date', start)
    .lte('date', end)
    .order('date', { ascending: true }));
  if (error) throw error;

  const byDate = new Map((data || []).map(r => [r.date, r]));
  const rows = dateRange(start, end).map(d => byDate.get(d) || {
    date: d, va_name: vaName,
    dms_sent: 0, replies: 0, booked_calls: 0,
    shown_calls: 0, closes: 0, cash_collected: 0, notes: null,
  });

  return {
    va_name: vaName,
    window: { start, end, days },
    rows,
    notes: (data || []).filter(r => r.notes).map(r => ({ date: r.date, notes: r.notes })),
  };
}

// ─── Team-wide daily trend rollup ───
export async function getTrends(supabase, days) {
  const { start, end } = windowDays(days);
  const { data, error } = await sbRetry(() => supabase
    .from('team_eod')
    .select('date, dms_sent, replies, booked_calls, closes, cash_collected')
    .gte('date', start)
    .lte('date', end));
  if (error) throw error;

  const byDate = new Map();
  for (const r of data || []) {
    if (!byDate.has(r.date)) {
      byDate.set(r.date, { date: r.date, dms_sent: 0, replies: 0, booked_calls: 0, closes: 0, cash_collected: 0 });
    }
    const d = byDate.get(r.date);
    d.dms_sent += Number(r.dms_sent || 0);
    d.replies += Number(r.replies || 0);
    d.booked_calls += Number(r.booked_calls || 0);
    d.closes += Number(r.closes || 0);
    d.cash_collected += Number(r.cash_collected || 0);
  }
  const rows = dateRange(start, end).map(d => byDate.get(d) || {
    date: d, dms_sent: 0, replies: 0, booked_calls: 0, closes: 0, cash_collected: 0,
  });
  return { window: { start, end, days }, rows };
}

// ─── Upsert EOD row (unique on va_name+date) ───
export async function upsertEod(supabase, payload) {
  const { va_name, date } = payload;
  if (!va_name || !date) throw new Error('va_name + date required');
  const allowedRoles = ['setter', 'closer', 'coach', 'ops'];
  const role = allowedRoles.includes(payload.role) ? payload.role : 'setter';

  const clean = {
    va_name: String(va_name).trim(),
    role,
    date,
    dms_sent: Math.max(0, Number(payload.dms_sent || 0)),
    replies: Math.max(0, Number(payload.replies || 0)),
    booked_calls: Math.max(0, Number(payload.booked_calls || 0)),
    shown_calls: Math.max(0, Number(payload.shown_calls || 0)),
    closes: Math.max(0, Number(payload.closes || 0)),
    cash_collected: Math.max(0, Number(payload.cash_collected || 0)),
    notes: payload.notes ? String(payload.notes).slice(0, 500) : null,
  };

  // no-retry (write path): upsert EOD row
  const { data, error } = await supabase
    .from('team_eod')
    .upsert(clean, { onConflict: 'va_name,date' })
    .select();
  if (error) throw error;
  return { row: data?.[0] || clean };
}

// ─── Latest EOD row per person — for "hasn't logged today" flag ───
export async function getLatestEod(supabase) {
  const { data, error } = await sbRetry(() => supabase
    .from('team_eod')
    .select('va_name, role, date')
    .order('date', { ascending: false }));
  if (error) throw error;

  const roster = await getRoster(supabase);
  const latest = new Map();
  for (const r of data || []) {
    if (!latest.has(r.va_name)) latest.set(r.va_name, { va_name: r.va_name, role: r.role, last_date: r.date });
  }
  // Include roster members w/ no history
  for (const rp of roster) {
    if (!latest.has(rp.va_name)) latest.set(rp.va_name, { va_name: rp.va_name, role: rp.role, last_date: null });
  }
  const today = todayStr();
  return Array.from(latest.values()).map(x => {
    const hours_since = x.last_date
      ? Math.max(0, Math.floor((Date.now() - new Date(x.last_date + 'T00:00:00').getTime()) / 3_600_000))
      : null;
    return {
      ...x,
      logged_today: x.last_date === today,
      hours_since,
    };
  }).sort((a, b) => {
    if (a.logged_today !== b.logged_today) return a.logged_today ? 1 : -1;
    return (a.last_date || '').localeCompare(b.last_date || '');
  });
}
