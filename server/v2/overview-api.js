// Overview API — cockpit endpoints for the daily "what to know / do" view.
// Endpoints:
//   GET /api/v2/overview/kpis         — enhanced KPI cards + WoW deltas + new-this-month
//   GET /api/v2/overview/action-queue — top 3-5 things to do today
//   GET /api/v2/overview/wow          — this-week vs last-week deltas (sales / ads / team)
//   GET /api/v2/overview/top-movers   — best lead source / campaign / at-risk client
//
// All endpoints return { synced_at: ISO } so the UI can render freshness.

import {
  fetchBookedCallsItems,
  computeSalesSummary,
} from './monday-sales.js';
import { getBookedCallsKPIs } from './booked-calls.js';
import { getMetaSpend } from './meta-ads.js';

// ─── Utility ────────────────────────────────────────────────
function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function weekWindow(offsetWeeks = 0) {
  // Rolling 7-day windows: offset=0 → last 7d (today-6 .. today), offset=1 → prior 7d.
  const end = daysAgo(offsetWeeks * 7);
  const start = new Date(end);
  start.setDate(start.getDate() - 6);
  return { start: isoDay(start), end: isoDay(end) };
}

function delta(current, prior) {
  if (prior == null || prior === 0) {
    if (current === 0) return { pct: null, dir: 'flat' };
    return { pct: null, dir: current > 0 ? 'up' : 'down' };
  }
  const pct = (current - prior) / Math.abs(prior);
  return {
    pct,
    dir: pct > 0.01 ? 'up' : pct < -0.01 ? 'down' : 'flat',
  };
}

function safeDiv(a, b) {
  return b > 0 ? a / b : null;
}

// ─── Shared Monday cache — same key as routes.js uses ───
const _cache = new Map();
async function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = await fn();
  _cache.set(key, { value, expires: now + ttlMs });
  return value;
}

// ─── Endpoint: KPIs w/ deltas ───────────────────────────────
async function computeKpis(supabase) {
  // Month-to-date
  const monthStart = new Date();
  monthStart.setDate(1);
  const monthStartStr = isoDay(monthStart);
  const todayStr = isoDay(new Date());

  // Prior-month same-day window (for WoW: WTD vs prior 7d)
  const week = weekWindow(0);
  const priorWeek = weekWindow(1);

  // Active client + new this month
  const [{ count: activeCount }, { count: newThisMonth }] = await Promise.all([
    supabase.from('clients').select('id', { count: 'exact', head: true }).eq('is_active', true),
    supabase.from('clients').select('id', { count: 'exact', head: true }).gte('start_date', monthStartStr),
  ]);

  // Countdown for resign counts
  const { data: countdown } = await supabase
    .from('client_countdown')
    .select('id, tier, days_until_resign');
  const critical7 = (countdown || []).filter(c => c.tier === 'critical' && (c.days_until_resign ?? 999) <= 7 && (c.days_until_resign ?? -999) >= -999).length;
  const critical = (countdown || []).filter(c => c.tier === 'critical').length;
  const urgent = (countdown || []).filter(c => c.tier === 'urgent').length;
  const watch = (countdown || []).filter(c => c.tier === 'watch').length;
  const withinMonth = (countdown || []).filter(c => c.days_until_resign != null && c.days_until_resign <= 30).length;

  // MTD cash + funnel — pulled through single-source getBookedCallsKPIs.
  // Spec: booked-calls.js + reference_booked_calls_dashboard_spec.md
  let mtdCashCollected = 0;
  let mtdCashContracted = 0;
  let wtdCashCollected = 0;
  let priorWkCashCollected = 0;
  let mtdRoas = null;
  try {
    const [mtd, wtd, prior] = await Promise.all([
      getBookedCallsKPIs({ from: monthStartStr, to: todayStr }),
      getBookedCallsKPIs({ from: week.start, to: week.end }),
      getBookedCallsKPIs({ from: priorWeek.start, to: priorWeek.end }),
    ]);
    mtdCashCollected = mtd.cashCollected;
    mtdCashContracted = mtd.cashContracted;
    wtdCashCollected = wtd.cashCollected;
    priorWkCashCollected = prior.cashCollected;
  } catch (_) {
    // Monday unreachable — MTD stays 0.
  }

  // Ads MTD spend — LIVE pull from Meta (source of truth), fall back to
  // ad_metrics table if Meta call fails so the card doesn't blank out.
  let mtdSpend = 0;
  let mtdAdCash = 0;
  try {
    const live = await getMetaSpend(monthStartStr, todayStr);
    mtdSpend = live.spend;
  } catch (e) {
    console.warn('[overview/kpis] Meta live spend failed, falling back to ad_metrics:', e.message);
    const { data: mtdAds } = await supabase
      .from('ad_metrics')
      .select('date, spend, cash_collected')
      .gte('date', monthStartStr)
      .lte('date', todayStr);
    mtdSpend = (mtdAds || []).reduce((s, r) => s + Number(r.spend || 0), 0);
    mtdAdCash = (mtdAds || []).reduce((s, r) => s + Number(r.cash_collected || 0), 0);
  }
  mtdRoas = mtdSpend > 0 ? (mtdCashCollected > 0 ? mtdCashCollected / mtdSpend : mtdAdCash / mtdSpend) : null;

  // Prior-week ad spend for spend delta
  const { data: priorWkAds } = await supabase
    .from('ad_metrics')
    .select('spend')
    .gte('date', priorWeek.start)
    .lte('date', priorWeek.end);
  const { data: wtdAds } = await supabase
    .from('ad_metrics')
    .select('spend, date')
    .gte('date', week.start)
    .lte('date', week.end)
    .order('date', { ascending: true });
  const wtdSpend = (wtdAds || []).reduce((s, r) => s + Number(r.spend || 0), 0);
  const priorWkSpend = (priorWkAds || []).reduce((s, r) => s + Number(r.spend || 0), 0);

  // 30d sparklines for cash + spend
  const { data: adRows30 } = await supabase
    .from('ad_metrics')
    .select('date, spend, cash_collected')
    .gte('date', isoDay(daysAgo(29)))
    .lte('date', todayStr)
    .order('date', { ascending: true });
  const byDay = {};
  for (const r of adRows30 || []) {
    if (!byDay[r.date]) byDay[r.date] = { spend: 0, cash: 0 };
    byDay[r.date].spend += Number(r.spend || 0);
    byDay[r.date].cash += Number(r.cash_collected || 0);
  }
  const daysArr = Object.keys(byDay).sort();
  const sparkSpend = daysArr.map(d => byDay[d].spend);
  const sparkCash = daysArr.map(d => byDay[d].cash);

  return {
    synced_at: new Date().toISOString(),
    mtd: {
      cash_collected: mtdCashCollected,
      cash_contracted: mtdCashContracted,
      cash_delta_wow: delta(wtdCashCollected, priorWkCashCollected),
    },
    ads: {
      spend: mtdSpend,
      roas: mtdRoas,
      cash_from_ads: mtdAdCash,
      spend_delta_wow: delta(wtdSpend, priorWkSpend),
      spark_spend: sparkSpend,
      spark_cash: sparkCash,
    },
    clients: {
      active: activeCount || 0,
      new_this_month: newThisMonth || 0,
    },
    resigns: {
      critical,
      critical_7d: critical7,
      urgent,
      watch,
      total_30d: withinMonth,
    },
  };
}

// ─── Endpoint: Action Queue ────────────────────────────────
async function computeActionQueue(supabase) {
  const actions = [];
  const todayStr = isoDay(new Date());

  // 1. Critical resigns ≤ 7 days
  const { data: countdown } = await supabase
    .from('client_countdown')
    .select('id, full_name, coach_name, days_until_resign, tier')
    .in('tier', ['critical', 'urgent'])
    .not('days_until_resign', 'is', null)
    .lte('days_until_resign', 7)
    .order('days_until_resign', { ascending: true })
    .limit(3);
  for (const c of countdown || []) {
    const d = c.days_until_resign;
    const timing = d < 0
      ? `overdue by ${Math.abs(d)}d`
      : d === 0 ? 'resigns today'
      : `resigns in ${d}d`;
    actions.push({
      id: `resign-${c.id}`,
      icon: '⚠',
      severity: d <= 0 ? 'critical' : 'urgent',
      title: `Call ${c.full_name} — ${timing}`,
      subtitle: c.coach_name ? `Coach: ${c.coach_name}` : null,
      cta: 'Call now',
    });
  }

  // 2. Missed VA EOD (yesterday not logged, roster people only)
  try {
    const { data: eodRows } = await supabase
      .from('team_eod')
      .select('va_name, date')
      .gte('date', isoDay(daysAgo(3)))
      .order('date', { ascending: false });
    const lastByName = new Map();
    for (const r of eodRows || []) {
      if (!lastByName.has(r.va_name)) lastByName.set(r.va_name, r.date);
    }
    // Only flag people who exist in roster
    const { data: roster } = await supabase
      .from('team_roster')
      .select('name, role')
      .eq('is_active', true);
    for (const rp of roster || []) {
      const last = lastByName.get(rp.name);
      if (last === todayStr) continue; // already logged
      if (rp.role === 'ops' || rp.role === 'head_coach') continue; // exempt
      actions.push({
        id: `eod-${rp.name}`,
        icon: '◇',
        severity: 'warn',
        title: `Nudge ${rp.name} — no EOD logged today`,
        subtitle: last ? `Last log: ${last}` : 'No logs on record',
        cta: 'Send nudge',
      });
      if (actions.length >= 8) break;
    }
  } catch (_) { /* roster table may not exist yet */ }

  // 3. Overdue open coach todos (created > 3 days ago, priority high, still open)
  const { data: overdue } = await supabase
    .from('coach_todos')
    .select('id, client_name, category, note, created_at, priority')
    .eq('status', 'open')
    .lte('created_at', isoDay(daysAgo(3)) + 'T23:59:59')
    .in('priority', ['high', 'urgent'])
    .order('created_at', { ascending: true })
    .limit(5);
  const overdueCount = (overdue || []).length;
  if (overdueCount > 0) {
    actions.push({
      id: 'todos-overdue',
      icon: '☰',
      severity: overdueCount >= 3 ? 'urgent' : 'warn',
      title: `You have ${overdueCount} overdue high-priority to-do${overdueCount === 1 ? '' : 's'}`,
      subtitle: (overdue || []).slice(0, 2).map(t => `${t.client_name} · ${t.category}`).join(' · '),
      cta: 'Open list',
    });
  }

  // 4. Coach at 100%+ capacity
  const { data: coaches } = await supabase
    .from('coach_capacity')
    .select('coach_name, active_clients, max_capacity, pct_full')
    .order('pct_full', { ascending: false });
  for (const c of coaches || []) {
    const pct = Number(c.pct_full);
    if (pct >= 100 && c.coach_name && c.coach_name !== '(unassigned)') {
      actions.push({
        id: `capacity-${c.coach_name}`,
        icon: '▤',
        severity: pct >= 150 ? 'critical' : 'urgent',
        title: `${c.coach_name} at ${Math.round(pct)}% capacity — hire signal`,
        subtitle: `${c.active_clients} / ${c.max_capacity} clients`,
        cta: 'Review',
      });
      break; // one is enough
    }
  }

  // Sort: critical → urgent → warn, then take top 6
  const rank = { critical: 0, urgent: 1, warn: 2, info: 3 };
  actions.sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4));
  return {
    synced_at: new Date().toISOString(),
    actions: actions.slice(0, 6),
    total_available: actions.length,
  };
}

// ─── Endpoint: Week over Week ───────────────────────────────
async function computeWoW(supabase) {
  const week = weekWindow(0);
  const priorWeek = weekWindow(1);

  // Sales via Monday
  let salesThis = null;
  let salesPrior = null;
  try {
    const items = await cached('monday:items', 60_000, fetchBookedCallsItems);
    salesThis = computeSalesSummary(items, week.start, week.end);
    salesPrior = computeSalesSummary(items, priorWeek.start, priorWeek.end);
  } catch (_) { /* leave null */ }

  const salesRow = (label, key, format = 'int') => {
    const cur = salesThis?.[key] ?? 0;
    const prior = salesPrior?.[key] ?? 0;
    return { label, key, current: cur, prior, delta: delta(cur, prior), format };
  };

  const sales = {
    booked: salesRow('Booked', 'booked', 'int'),
    shown: salesRow('Shown', 'shown', 'int'),
    closed: salesRow('Closed', 'closed', 'int'),
    cash: salesRow('Cash Collected', 'cash_collected', 'money'),
  };

  // Ads via Supabase
  const [{ data: adsThis }, { data: adsPrior }] = await Promise.all([
    supabase.from('ad_metrics').select('spend, cash_collected, booked_calls')
      .gte('date', week.start).lte('date', week.end),
    supabase.from('ad_metrics').select('spend, cash_collected, booked_calls')
      .gte('date', priorWeek.start).lte('date', priorWeek.end),
  ]);
  const adSum = (rows) => (rows || []).reduce((acc, r) => ({
    spend: acc.spend + Number(r.spend || 0),
    cash: acc.cash + Number(r.cash_collected || 0),
    booked: acc.booked + Number(r.booked_calls || 0),
  }), { spend: 0, cash: 0, booked: 0 });
  const at = adSum(adsThis);
  const ap = adSum(adsPrior);
  // Prefer Monday-derived cash for ROAS when available (ads booked_calls may be 0)
  const roasThis = at.spend > 0 ? (salesThis?.cash_collected ?? at.cash) / at.spend : null;
  const roasPrior = ap.spend > 0 ? (salesPrior?.cash_collected ?? ap.cash) / ap.spend : null;
  const bookedThis = at.booked || salesThis?.booked || 0;
  const bookedPrior = ap.booked || salesPrior?.booked || 0;
  const cpbcThis = bookedThis > 0 ? at.spend / bookedThis : null;
  const cpbcPrior = bookedPrior > 0 ? ap.spend / bookedPrior : null;

  const ads = {
    spend: { label: 'Ad Spend', current: at.spend, prior: ap.spend, delta: delta(at.spend, ap.spend), format: 'money', invert: true },
    roas: { label: 'ROAS', current: roasThis, prior: roasPrior, delta: delta(roasThis, roasPrior), format: 'ratio' },
    cpbc: { label: 'Cost / Booked Call', current: cpbcThis, prior: cpbcPrior, delta: delta(cpbcThis, cpbcPrior), format: 'money', invert: true },
  };

  // Team via team_eod
  const [{ data: teamThis }, { data: teamPrior }] = await Promise.all([
    supabase.from('team_eod').select('dms_sent, booked_calls')
      .gte('date', week.start).lte('date', week.end),
    supabase.from('team_eod').select('dms_sent, booked_calls')
      .gte('date', priorWeek.start).lte('date', priorWeek.end),
  ]);
  const teamSum = (rows) => (rows || []).reduce((acc, r) => ({
    dms: acc.dms + Number(r.dms_sent || 0),
    booked: acc.booked + Number(r.booked_calls || 0),
  }), { dms: 0, booked: 0 });
  const tt = teamSum(teamThis);
  const tp = teamSum(teamPrior);
  const dmToCallThis = safeDiv(tt.booked, tt.dms);
  const dmToCallPrior = safeDiv(tp.booked, tp.dms);

  const team = {
    dms: { label: 'DMs Sent', current: tt.dms, prior: tp.dms, delta: delta(tt.dms, tp.dms), format: 'int' },
    booked: { label: 'Booked Calls', current: tt.booked, prior: tp.booked, delta: delta(tt.booked, tp.booked), format: 'int' },
    ratio: { label: 'DM → Call', current: dmToCallThis, prior: dmToCallPrior, delta: delta(dmToCallThis, dmToCallPrior), format: 'pct' },
  };

  return {
    synced_at: new Date().toISOString(),
    windows: { this_week: week, last_week: priorWeek },
    sales,
    ads,
    team,
  };
}

// ─── Endpoint: Top Movers ───────────────────────────────────
async function computeTopMovers(supabase) {
  const since = isoDay(daysAgo(29));
  const todayStr = isoDay(new Date());

  // Best campaign by ROAS (min $50 spend)
  const { data: adRows } = await supabase
    .from('ad_metrics')
    .select('campaign_name, spend, cash_collected, booked_calls')
    .gte('date', since)
    .lte('date', todayStr);
  const perCampaign = new Map();
  for (const r of adRows || []) {
    const key = r.campaign_name || '(account)';
    if (!perCampaign.has(key)) perCampaign.set(key, { name: key, spend: 0, cash: 0, booked: 0 });
    const c = perCampaign.get(key);
    c.spend += Number(r.spend || 0);
    c.cash += Number(r.cash_collected || 0);
    c.booked += Number(r.booked_calls || 0);
  }
  const campaigns = Array.from(perCampaign.values())
    .filter(c => c.spend >= 50)
    .map(c => ({ ...c, roas: c.spend > 0 ? c.cash / c.spend : 0, cpbc: c.booked > 0 ? c.spend / c.booked : null }));

  // Best campaign = highest booked_calls per dollar (lowest CPBC), fallback to highest spend
  const bestCampaign = campaigns
    .filter(c => c.cpbc != null)
    .sort((a, b) => a.cpbc - b.cpbc)[0]
    || campaigns.sort((a, b) => b.spend - a.spend)[0]
    || null;

  // Top lead source — use Monday `program` col as best proxy for "what they signed for"
  let topProgram = null;
  try {
    const items = await cached('monday:items', 60_000, fetchBookedCallsItems);
    const s = computeSalesSummary(items, since, todayStr);
    const perProgram = new Map();
    for (const sale of s.recent_sales || []) {
      const key = sale.program || '(no program)';
      if (!perProgram.has(key)) perProgram.set(key, { name: key, cash: 0, count: 0 });
      const p = perProgram.get(key);
      p.cash += Number(sale.collected || 0);
      p.count += 1;
    }
    topProgram = Array.from(perProgram.values()).sort((a, b) => b.cash - a.cash)[0] || null;
  } catch (_) { /* leave null */ }

  // At-risk client: longest silence (no note) among active clients w/ resign ≤ 30 days
  let atRiskClient = null;
  try {
    const { data: countdown } = await supabase
      .from('client_countdown')
      .select('id, full_name, coach_name, days_until_resign, tier')
      .not('days_until_resign', 'is', null)
      .lte('days_until_resign', 30);
    const ids = (countdown || []).map(c => c.id);
    if (ids.length) {
      const { data: notes } = await supabase
        .from('client_notes')
        .select('client_id, created_at')
        .in('client_id', ids)
        .order('created_at', { ascending: false });
      const lastByClient = new Map();
      for (const n of notes || []) {
        if (!lastByClient.has(n.client_id)) lastByClient.set(n.client_id, n.created_at);
      }
      const enriched = (countdown || []).map(c => {
        const last = lastByClient.get(c.id);
        const daysSince = last
          ? Math.floor((Date.now() - new Date(last).getTime()) / (24 * 3600 * 1000))
          : 999;
        return { ...c, last_note_at: last || null, days_since_note: daysSince };
      });
      // Score: prefer longest silence, then closest to resign
      enriched.sort((a, b) => {
        if (b.days_since_note !== a.days_since_note) return b.days_since_note - a.days_since_note;
        return (a.days_until_resign ?? 999) - (b.days_until_resign ?? 999);
      });
      atRiskClient = enriched[0] || null;
    }
  } catch (_) { /* leave null */ }

  return {
    synced_at: new Date().toISOString(),
    window: { start: since, end: todayStr, days: 30 },
    top_campaign: bestCampaign,
    top_program: topProgram,
    at_risk_client: atRiskClient,
  };
}

// ─── Register ────────────────────────────────────────────────
// All endpoints degrade to a 200 partial payload on failure — the dashboard
// renders a "partial data" chip instead of showing a red full-page banner.
export function registerOverviewRoutes({ app, supabase }) {
  app.get('/api/v2/overview/kpis', async (_req, res) => {
    try {
      const out = await computeKpis(supabase);
      res.json(out);
    } catch (e) {
      console.error('[overview/kpis]', e);
      res.status(200).json({
        _error: e.message, _partial: true,
        synced_at: new Date().toISOString(),
        mtd: { cash_collected: 0, cash_contracted: 0, cash_delta_wow: { pct: null, dir: 'flat' } },
        ads: { spend: 0, roas: null, cash_from_ads: 0, spend_delta_wow: { pct: null, dir: 'flat' }, spark_spend: [], spark_cash: [] },
        clients: { active: 0, new_this_month: 0 },
        resigns: { critical: 0, critical_7d: 0, urgent: 0, watch: 0, total_30d: 0 },
      });
    }
  });

  app.get('/api/v2/overview/action-queue', async (_req, res) => {
    try {
      const out = await computeActionQueue(supabase);
      res.json(out);
    } catch (e) {
      console.error('[overview/action-queue]', e);
      res.status(200).json({ _error: e.message, _partial: true, synced_at: new Date().toISOString(), actions: [] });
    }
  });

  app.get('/api/v2/overview/wow', async (_req, res) => {
    try {
      const out = await computeWoW(supabase);
      res.json(out);
    } catch (e) {
      console.error('[overview/wow]', e);
      res.status(200).json({ _error: e.message, _partial: true, synced_at: new Date().toISOString() });
    }
  });

  app.get('/api/v2/overview/top-movers', async (_req, res) => {
    try {
      const out = await computeTopMovers(supabase);
      res.json(out);
    } catch (e) {
      console.error('[overview/top-movers]', e);
      res.status(200).json({ _error: e.message, _partial: true, synced_at: new Date().toISOString() });
    }
  });
}
