// v2 API routes — mounted at /api/v2/*
// Exports a function that takes ({ app, supabase }) and attaches the routes.

import { syncMetaAds } from './meta-ads.js';
import {
  fetchBookedCallsItems,
  computeSalesSummary,
  computeByCloser,
  computeDailySparks,
} from './monday-sales.js';
import {
  fetchBookedCallsUnified,
  summarize as summarizeBookedCalls,
  groupByCloser as bcGroupByCloser,
  groupBySetter as bcGroupBySetter,
  groupBySource as bcGroupBySource,
  groupByLostReason as bcGroupByLostReason,
  dailySeries as bcDailySeries,
  filterAdAttributed as bcFilterAdAttributed,
  dailyFromAds as bcDailyFromAds,
} from './booked-calls.js';
import {
  seedIfEmpty as seedTeamIfEmpty,
  getRoster as getTeamRoster,
  getSummary as getTeamSummary,
  getDaily as getTeamDaily,
  getTrends as getTeamTrends,
  upsertEod as upsertTeamEod,
  getLatestEod as getTeamLatestEod,
} from './team-kpi.js';
import {
  fetchEodDmsLogs,
  getSetterEodRollup,
  getSetterDailyRows,
  normalizeSetterName,
  normalizeCloserName,
} from './monday-eod-dms.js';
import { registerCapacityRoutes } from './capacity-api.js';
import { registerPnlRoutes } from './pnl-api.js';
import { registerClientsRoutes } from './clients-api.js';
import { registerOverviewRoutes } from './overview-api.js';
import { registerCompanyKpiRoutes } from './company-kpi.js';
import { cachedFetch, invalidate } from './cache.js';

// ─── Utility ───
function windowFromDays(days) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (days - 1));
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

// Shared in-process cache (see cache.js). `sales.summary` and `sales.by_closer`
// hit Monday which is slow — the routes below cache 60s per window.
// After ads sync we invalidate everything cached (Monday snapshot + summaries).
const cached = cachedFetch;

export function registerV2Routes({ app, supabase }) {
  // ── Ads ────────────────────────────────────────────
  app.get('/api/v2/ads/summary', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const { start, end } = windowFromDays(days);

    try {
      const { data: rows, error } = await supabase
        .from('ad_metrics')
        .select('*')
        .gte('date', start)
        .lte('date', end);
      if (error) throw error;

      const perCampaign = {};
      let totalSpend = 0, totalImpressions = 0, totalClicks = 0;
      let totalMessages = 0, totalBooked = 0, totalShown = 0, totalClosed = 0;
      let totalCashCollected = 0, totalCashContracted = 0;

      for (const r of rows || []) {
        const key = r.campaign_id || '__account__';
        if (!perCampaign[key]) {
          perCampaign[key] = {
            campaign_id: r.campaign_id,
            campaign_name: r.campaign_name || '(account)',
            spend: 0, impressions: 0, clicks: 0,
            messages: 0, booked_calls: 0, shown_calls: 0, closed: 0,
            cash_collected: 0, cash_contracted: 0,
          };
        }
        const c = perCampaign[key];
        c.spend += Number(r.spend || 0);
        c.impressions += Number(r.impressions || 0);
        c.clicks += Number(r.clicks || 0);
        c.messages += Number(r.messages || 0);
        c.booked_calls += Number(r.booked_calls || 0);
        c.shown_calls += Number(r.shown_calls || 0);
        c.closed += Number(r.closed || 0);
        c.cash_collected += Number(r.cash_collected || 0);
        c.cash_contracted += Number(r.cash_contracted || 0);

        totalSpend += Number(r.spend || 0);
        totalImpressions += Number(r.impressions || 0);
        totalClicks += Number(r.clicks || 0);
        totalMessages += Number(r.messages || 0);
        totalBooked += Number(r.booked_calls || 0);
        totalShown += Number(r.shown_calls || 0);
        totalClosed += Number(r.closed || 0);
        totalCashCollected += Number(r.cash_collected || 0);
        totalCashContracted += Number(r.cash_contracted || 0);
      }

      const campaigns = Object.values(perCampaign).map(c => ({
        ...c,
        roas: c.spend > 0 ? c.cash_collected / c.spend : null,
      })).sort((a, b) => b.spend - a.spend);

      const totals = {
        spend: totalSpend,
        impressions: totalImpressions,
        clicks: totalClicks,
        messages: totalMessages,
        booked_calls: totalBooked,
        shown_calls: totalShown,
        closed: totalClosed,
        cash_collected: totalCashCollected,
        cash_contracted: totalCashContracted,
        roas: totalSpend > 0 ? totalCashCollected / totalSpend : null,
        cpm: totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : null,
        cpl: totalMessages > 0 ? totalSpend / totalMessages : null,
        cpbc: totalBooked > 0 ? totalSpend / totalBooked : null,
      };

      res.json({ window: { start, end, days }, totals, campaigns });
    } catch (e) {
      console.error('[ads/summary]', e);
      res.status(200).json({
        _error: e.message, _partial: true,
        window: { start, end, days },
        totals: { spend: 0, impressions: 0, clicks: 0, messages: 0, booked_calls: 0, shown_calls: 0, closed: 0, cash_collected: 0, cash_contracted: 0, roas: null, cpm: null, cpl: null, cpbc: null },
        campaigns: [],
      });
    }
  });

  app.get('/api/v2/ads/daily', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const { start, end } = windowFromDays(days);
    try {
      const { data: rows, error } = await supabase
        .from('ad_metrics')
        .select('date, spend, impressions, clicks, messages, cash_collected, cash_contracted')
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: true });
      if (error) throw error;

      // Roll up to per-day
      const byDay = {};
      for (const r of rows || []) {
        if (!byDay[r.date]) byDay[r.date] = { date: r.date, spend: 0, impressions: 0, clicks: 0, messages: 0, cash_collected: 0, cash_contracted: 0 };
        const b = byDay[r.date];
        b.spend += Number(r.spend || 0);
        b.impressions += Number(r.impressions || 0);
        b.clicks += Number(r.clicks || 0);
        b.messages += Number(r.messages || 0);
        b.cash_collected += Number(r.cash_collected || 0);
        b.cash_contracted += Number(r.cash_contracted || 0);
      }
      const list = Object.values(byDay).sort((a, b) => a.date.localeCompare(b.date));
      const spend_series = list.map(d => d.spend);
      const cash_series = list.map(d => d.cash_collected);
      const roas_series = list.map(d => (d.spend > 0 ? d.cash_collected / d.spend : 0));

      res.json({ window: { start, end, days }, rows: list, spend_series, cash_series, roas_series });
    } catch (e) {
      console.error('[ads/daily]', e);
      res.status(200).json({
        _error: e.message, _partial: true,
        window: { start, end, days }, rows: [], spend_series: [], cash_series: [], roas_series: [],
      });
    }
  });

  app.post('/api/v2/ads/sync', async (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.body?.days) || 3));
    try {
      const result = await syncMetaAds(supabase, days);
      // Invalidate cached summaries — new ad rows may shift ROAS + capacity views.
      invalidate('monday:');
      invalidate('bc:');
      res.json({ ok: true, ...result, days });
    } catch (e) {
      console.error('[ads/sync] error:', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Sales ──────────────────────────────────────────
  app.get('/api/v2/sales/summary', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const { start, end } = windowFromDays(days);
    try {
      const items = await cached(`monday:items`, 60_000, fetchBookedCallsItems);
      const summary = computeSalesSummary(items, start, end);
      const sparks = computeDailySparks(items, start, end);
      res.json({
        ...summary,
        spark_booked: sparks.booked,
        spark_shown: sparks.shown,
        spark_closed: sparks.closed,
        spark_cash: sparks.cash,
      });
    } catch (e) {
      console.error('[sales/summary]', e);
      res.status(200).json({
        _error: e.message,
        _partial: true,
        window: { start, end },
        booked: 0, booked_15: 0, booked_45: 0,
        shown: 0, shown_15: 0, shown_45: 0,
        closed: 0, cash_collected: 0, cash_contracted: 0, acv: 0,
        lost_reasons: [], recent_sales: [],
        spark_booked: [], spark_shown: [], spark_closed: [], spark_cash: [],
      });
    }
  });

  app.get('/api/v2/sales/by-closer', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const { start, end } = windowFromDays(days);
    try {
      const items = await cached(`monday:items`, 60_000, fetchBookedCallsItems);
      const closers = computeByCloser(items, start, end);
      res.json({ window: { start, end, days }, closers });
    } catch (e) {
      console.error('[sales/by-closer]', e);
      res.status(200).json({ _error: e.message, _partial: true, window: { start, end, days }, closers: [] });
    }
  });

  // ── Booked Calls (unified: Monday + GHL) ───────────
  app.get('/api/v2/booked-calls/summary', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const unified = await cached(`bc:unified:${days}`, 60_000, () => fetchBookedCallsUnified(days));
      const summary = summarizeBookedCalls(unified.items);
      const bySource = bcGroupBySource(unified.items);
      const spark = bcDailySeries(unified.items, unified.window.start, unified.window.end);
      res.json({
        window: unified.window,
        totals: summary,
        by_source_group: bySource,
        spark_booked: spark.booked,
        spark_shown: spark.shown,
        spark_closed: spark.closed,
        dedup_stats: unified.dedup_stats,
        item_count: unified.items.length,
      });
    } catch (e) {
      console.error('[booked-calls/summary]', e);
      // Graceful partial — dashboard renders "partial data" chip instead of failing whole tab.
      res.status(200).json({
        _error: e.message,
        _partial: true,
        window: windowFromDays(days),
        totals: { booked: 0, shown: 0, closed: 0, cash_collected: 0, cash_contracted: 0, close_rate: null, show_rate: null, by_source: {} },
        by_source_group: [],
        spark_booked: [], spark_shown: [], spark_closed: [],
        dedup_stats: {},
        item_count: 0,
      });
    }
  });

  app.get('/api/v2/booked-calls/lost-reasons', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const unified = await cached(`bc:unified:${days}`, 60_000, () => fetchBookedCallsUnified(days));
      const reasons = bcGroupByLostReason(unified.items);
      res.json({ window: unified.window, reasons });
    } catch (e) {
      console.error('[booked-calls/lost-reasons]', e);
      res.status(200).json({ _error: e.message, _partial: true, window: windowFromDays(days), reasons: [] });
    }
  });

  app.get('/api/v2/booked-calls/by-closer', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const unified = await cached(`bc:unified:${days}`, 60_000, () => fetchBookedCallsUnified(days));
      const closers = bcGroupByCloser(unified.items);
      res.json({ window: unified.window, closers });
    } catch (e) {
      console.error('[booked-calls/by-closer]', e);
      res.status(200).json({ _error: e.message, _partial: true, window: windowFromDays(days), closers: [] });
    }
  });

  app.get('/api/v2/booked-calls/by-setter', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const unified = await cached(`bc:unified:${days}`, 60_000, () => fetchBookedCallsUnified(days));
      const setters = bcGroupBySetter(unified.items);
      res.json({ window: unified.window, setters });
    } catch (e) {
      console.error('[booked-calls/by-setter]', e);
      res.status(200).json({ _error: e.message, _partial: true, window: windowFromDays(days), setters: [] });
    }
  });

  app.get('/api/v2/booked-calls/by-source', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const unified = await cached(`bc:unified:${days}`, 60_000, () => fetchBookedCallsUnified(days));
      const sources = bcGroupBySource(unified.items);
      res.json({ window: unified.window, sources });
    } catch (e) {
      console.error('[booked-calls/by-source]', e);
      res.status(200).json({ _error: e.message, _partial: true, window: windowFromDays(days), sources: [] });
    }
  });

  // Ad-attributed booked calls. Filters unified items down to rows we consider
  // ad-driven (see booked-calls.js#filterAdAttributed). Attribution is currently
  // rough — Monday's lead_source column is empty, so we default to "all Monday
  // items are ad-attributed". Zach's known issue; tab surfaces this via footer.
  app.get('/api/v2/booked-calls/from-ads', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const unified = await cached(`bc:unified:${days}`, 60_000, () => fetchBookedCallsUnified(days));
      const adItems = bcFilterAdAttributed(unified.items);
      const totals = summarizeBookedCalls(adItems);
      const daily = bcDailyFromAds(unified.items, unified.window.start, unified.window.end);
      res.json({
        window: unified.window,
        totals,
        daily,
        attribution_note: 'Monday lead_source column is not populated. Defaulting to "all booked = ad-attributed" per biweekly-report rule. Needs UTM tagging for precision.',
        item_count: adItems.length,
      });
    } catch (e) {
      console.error('[booked-calls/from-ads]', e);
      res.status(200).json({
        _error: e.message,
        _partial: true,
        window: windowFromDays(days),
        totals: { booked: 0, shown: 0, closed: 0, cash_collected: 0, cash_contracted: 0, close_rate: null, show_rate: null, by_source: {} },
        daily: { dates: [], booked: [], collected: [], contracted: [] },
        attribution_note: 'partial data',
        item_count: 0,
      });
    }
  });

  // ── Overview ───────────────────────────────────────
  app.get('/api/v2/overview', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    const { start, end } = windowFromDays(days);

    try {
      // Active clients + new this month
      const monthStart = new Date();
      monthStart.setDate(1);
      const monthStartStr = monthStart.toISOString().slice(0, 10);

      const [{ count: activeCount }, { count: newThisMonth }] = await Promise.all([
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('is_active', true),
        supabase.from('clients').select('id', { count: 'exact', head: true }).gte('start_date', monthStartStr),
      ]);

      // Countdown tiers
      const { data: countdown } = await supabase
        .from('client_countdown')
        .select('id, full_name, coach_name, days_until_resign, tier, programmed_to')
        .order('days_until_resign', { ascending: true });

      const upcoming = (countdown || []).filter(c => c.days_until_resign != null && c.days_until_resign <= 30);
      const resigns = {
        critical: upcoming.filter(c => c.tier === 'critical').length,
        urgent: upcoming.filter(c => c.tier === 'urgent').length,
        watch: upcoming.filter(c => c.tier === 'watch').length,
        upcoming: upcoming.slice(0, 12),
      };

      // Coach load
      const { data: coaches } = await supabase
        .from('coach_capacity')
        .select('coach_name, active_clients, max_capacity, pct_full')
        .order('active_clients', { ascending: false });

      // Ads window rollup for spark + ROAS
      const { data: adRows } = await supabase
        .from('ad_metrics')
        .select('date, spend, cash_collected')
        .gte('date', start)
        .lte('date', end)
        .order('date', { ascending: true });

      const byDay = {};
      for (const r of adRows || []) {
        if (!byDay[r.date]) byDay[r.date] = { spend: 0, cash: 0 };
        byDay[r.date].spend += Number(r.spend || 0);
        byDay[r.date].cash += Number(r.cash_collected || 0);
      }
      const daysArr = Object.keys(byDay).sort();
      const spark_spend = daysArr.map(d => byDay[d].spend);
      const spark_cash = daysArr.map(d => byDay[d].cash);
      const totalSpend = spark_spend.reduce((s, v) => s + v, 0);
      const totalCashAds = spark_cash.reduce((s, v) => s + v, 0);

      // MTD cash from Monday (real source of truth) — cached
      let mtdCashCollected = 0;
      let mtdCashContracted = 0;
      try {
        const items = await cached('monday:items', 60_000, fetchBookedCallsItems);
        const mtd = computeSalesSummary(items, monthStartStr, end);
        mtdCashCollected = mtd.cash_collected;
        mtdCashContracted = mtd.cash_contracted;
      } catch (_) {
        // Ok — Monday unreachable, MTD stays 0.
      }

      res.json({
        window: { start, end, days },
        mtd: { cash_collected: mtdCashCollected, cash_contracted: mtdCashContracted },
        ads: {
          spend: totalSpend,
          cash_from_ads: totalCashAds,
          roas: totalSpend > 0 ? totalCashAds / totalSpend : null,
          spark_spend,
          spark_cash,
        },
        clients: {
          active: activeCount || 0,
          new_this_month: newThisMonth || 0,
        },
        resigns,
        coaches: (coaches || []).map(c => ({
          ...c,
          pct_full: Number(c.pct_full),
        })),
      });
    } catch (e) {
      console.error('[overview]', e);
      res.status(200).json({
        _error: e.message,
        _partial: true,
        window: { start, end, days },
        mtd: { cash_collected: 0, cash_contracted: 0 },
        ads: { spend: 0, cash_from_ads: 0, roas: null, spark_spend: [], spark_cash: [] },
        clients: { active: 0, new_this_month: 0 },
        resigns: { critical: 0, urgent: 0, watch: 0, upcoming: [] },
        coaches: [],
      });
    }
  });

  // ── Team KPI ───────────────────────────────────────
  // Seed a sample row so the UI has something to render on first boot.
  seedTeamIfEmpty(supabase).catch(e => console.warn('[team/seed]', e.message));

  app.get('/api/v2/team/roster', async (_req, res) => {
    try {
      const roster = await getTeamRoster(supabase);
      res.json({ roster });
    } catch (e) {
      console.error('[team/roster]', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/v2/team/summary', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 7));
    const role = req.query.role || null;
    try {
      const summary = await getTeamSummary(supabase, days, role);
      res.json(summary);
    } catch (e) {
      console.error('[team/summary]', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/v2/team/daily', async (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    const vaName = req.query.va_name;
    if (!vaName) return res.status(400).json({ error: 'va_name required' });
    try {
      const out = await getTeamDaily(supabase, vaName, days);
      res.json(out);
    } catch (e) {
      console.error('[team/daily]', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/v2/team/trends', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const out = await getTeamTrends(supabase, days);
      res.json(out);
    } catch (e) {
      console.error('[team/trends]', e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/v2/team/eod', async (req, res) => {
    try {
      const result = await upsertTeamEod(supabase, req.body || {});
      res.json({ ok: true, ...result });
    } catch (e) {
      console.error('[team/eod]', e);
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/v2/team/latest-eod', async (_req, res) => {
    try {
      const out = await getTeamLatestEod(supabase);
      res.json({ people: out });
    } catch (e) {
      console.error('[team/latest-eod]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Team KPI v2 — Setters + Closers merged from Monday EOD + Booked Calls ──
  //
  // Setter row = EOD DMs (Monday board 9743873934) unioned w/ per-setter booked-calls
  //              attribution (Booked Calls board 18372257888, "DMer" col).
  // Closer row = per-closer booked-calls attribution.
  //
  // Both endpoints always include every ACTIVE roster row (0-filled if no activity).
  app.get('/api/v2/team/setters', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const [eodRollup, unified, ads, roster] = await Promise.all([
        getSetterEodRollup(days),
        cached(`bc:unified:${days}`, 60_000, () => fetchBookedCallsUnified(days)),
        (async () => {
          const { start, end } = windowFromDays(days);
          const { data } = await supabase
            .from('ad_metrics')
            .select('spend')
            .gte('date', start)
            .lte('date', end);
          return (data || []).reduce((s, r) => s + Number(r.spend || 0), 0);
        })(),
        getTeamRoster(supabase),
      ]);

      const bcSetters = bcGroupBySetter(unified.items);

      // Build per-setter map keyed by short name.
      const map = new Map();
      const ensure = (short) => {
        if (!map.has(short)) {
          map.set(short, {
            setter: short,
            dms_sent: 0,           // reserved — EOD board doesn't track this yet
            calls_booked_eod: 0,   // from EOD board
            calls_booked_bc: 0,    // from Booked Calls board (attribution truth)
            closes: 0,
            days_logged: 0,
            last_eod: null,
          });
        }
        return map.get(short);
      };

      // Roster seed — active setters + head_coach (Zach also sets sometimes but not required)
      for (const r of roster) {
        if (r.role === 'setter') ensure(r.va_name);
      }
      // EOD board rollup
      for (const row of eodRollup.rows) {
        const p = ensure(row.setter);
        p.calls_booked_eod += Number(row.calls_booked || 0);
        p.dms_sent += Number(row.dms_sent || 0);
        p.days_logged += Number(row.days_logged || 0);
        if (!p.last_eod || (row.last_date && row.last_date > p.last_eod)) p.last_eod = row.last_date;
      }
      // Booked-calls attribution — skip (unassigned) per Zach's rule.
      for (const s of bcSetters) {
        if (!s.setter || s.setter === '(unassigned)') continue;
        const short = normalizeSetterName(s.setter);
        if (!short || short === '(unassigned)') continue;
        const p = ensure(short);
        p.calls_booked_bc += Number(s.booked || 0);
        p.closes += Number(s.closed || 0);
      }

      const totalSpend = ads || 0;
      const totalCallsBooked = Array.from(map.values()).reduce((s, p) => s + p.calls_booked_bc, 0);

      const setters = Array.from(map.values()).map(p => {
        // Use booked-calls attribution as the calls_booked source of truth (EOD self-report can drift).
        const calls_booked = p.calls_booked_bc;
        const dm_to_call_pct = p.dms_sent > 0 && calls_booked > 0 ? p.dms_sent / calls_booked : null;
        const close_rate = calls_booked > 0 ? p.closes / calls_booked : null;
        // Cost per booked call = fair share of total spend by booking share.
        const cost_per_booked_call = totalCallsBooked > 0 && calls_booked > 0
          ? totalSpend / totalCallsBooked
          : null;
        return {
          setter: p.setter,
          dms_sent: p.dms_sent || null,
          calls_booked,
          calls_booked_eod: p.calls_booked_eod,
          closes: p.closes,
          days_logged: p.days_logged,
          last_eod: p.last_eod,
          dm_to_call_pct,
          close_rate,
          cost_per_booked_call,
        };
      }).sort((a, b) => b.calls_booked - a.calls_booked);

      res.json({
        window: unified.window,
        totals: {
          dms_sent: setters.reduce((s, p) => s + (p.dms_sent || 0), 0),
          calls_booked: totalCallsBooked,
          closes: setters.reduce((s, p) => s + p.closes, 0),
          ad_spend: totalSpend,
        },
        setters,
      });
    } catch (e) {
      console.error('[team/setters]', e);
      res.status(200).json({
        _error: e.message,
        _partial: true,
        window: windowFromDays(days),
        totals: { dms_sent: 0, calls_booked: 0, closes: 0, ad_spend: 0 },
        setters: [],
      });
    }
  });

  app.get('/api/v2/team/closers', async (req, res) => {
    const days = Math.max(1, Math.min(365, Number(req.query.days) || 30));
    try {
      const [unified, roster] = await Promise.all([
        cached(`bc:unified:${days}`, 60_000, () => fetchBookedCallsUnified(days)),
        getTeamRoster(supabase),
      ]);
      const bcClosers = bcGroupByCloser(unified.items);

      const map = new Map();
      const ensure = (short) => {
        if (!map.has(short)) {
          map.set(short, {
            closer: short,
            calls_taken: 0,
            shown: 0,
            closed: 0,
            cash_collected: 0,
            cash_contracted: 0,
          });
        }
        return map.get(short);
      };

      // Roster seed — all active closers + head_coach (Zach closes)
      for (const r of roster) {
        if (r.role === 'closer' || r.role === 'head_coach') ensure(r.va_name);
      }
      // Booked-calls attribution — skip (unassigned) per Zach's rule.
      for (const c of bcClosers) {
        if (!c.closer || c.closer === '(unassigned)') continue;
        const short = normalizeCloserName(c.closer);
        if (!short || short === '(unassigned)') continue;
        const p = ensure(short);
        p.calls_taken += Number(c.booked || 0);
        p.shown += Number(c.shown || 0);
        p.closed += Number(c.closed || 0);
        p.cash_collected += Number(c.cash_collected || 0);
        p.cash_contracted += Number(c.cash_contracted || 0);
      }

      const closers = Array.from(map.values()).map(p => ({
        ...p,
        close_rate: p.shown > 0 ? p.closed / p.shown : null,
        show_rate: p.calls_taken > 0 ? p.shown / p.calls_taken : null,
      })).sort((a, b) => b.cash_collected - a.cash_collected);

      const totals = closers.reduce((acc, p) => ({
        calls_taken: acc.calls_taken + p.calls_taken,
        shown: acc.shown + p.shown,
        closed: acc.closed + p.closed,
        cash_collected: acc.cash_collected + p.cash_collected,
        cash_contracted: acc.cash_contracted + p.cash_contracted,
      }), { calls_taken: 0, shown: 0, closed: 0, cash_collected: 0, cash_contracted: 0 });

      res.json({
        window: unified.window,
        totals: {
          ...totals,
          close_rate: totals.shown > 0 ? totals.closed / totals.shown : null,
        },
        closers,
      });
    } catch (e) {
      console.error('[team/closers]', e);
      res.status(200).json({
        _error: e.message,
        _partial: true,
        window: windowFromDays(days),
        totals: { calls_taken: 0, shown: 0, closed: 0, cash_collected: 0, cash_contracted: 0, close_rate: null },
        closers: [],
      });
    }
  });

  app.get('/api/v2/team/eod-dms/latest', async (req, res) => {
    const days = Math.max(1, Math.min(90, Number(req.query.days) || 14));
    try {
      const daily = await getSetterDailyRows(days);
      res.json(daily);
    } catch (e) {
      console.error('[team/eod-dms/latest]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Capacity ───────────────────────────────────────
  registerCapacityRoutes({ app, supabase });
  registerPnlRoutes({ app, supabase });
  registerClientsRoutes({ app, supabase });
  registerOverviewRoutes({ app, supabase });
  registerCompanyKpiRoutes({ app, supabase });
}
