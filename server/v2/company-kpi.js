// Company KPI — monthly business dashboard.
// Aggregates Marketing/Funnel/Efficiency/Cash rows for JAN-DEC of a given year.
//
// Data sources:
//   - Ad Spend       : Supabase `ad_metrics` (date-partitioned rows)
//   - New Leads      : Monday boards (Form Submissions 18411549110 + Organic List 18008046494)
//                      counted by `created_at` month
//   - 15s / 45s Calls: Monday Booked Calls board (18372257888) — the same board this file
//                      already reads via monday-sales.js.
//                      15s   = has date_15 in month AND no date_45  (Zach's biweekly rule)
//                      45s   = has date_45 in month
//                      Shown = outcome NOT in {No Show, Needs Rebooking, Canceled, blank}
//                      Sold  = outcome in {Sold, Bloodwork Only, Bloodwork Sold}
//                              (bloods count per project memory)
//   - Cash Collected/Contracted: same board, contracted/collected columns
//   - Rocket Total   : placeholder null — finance system feeds later.

import { fetchBookedCallsItems } from './monday-sales.js';

const MONDAY_API = 'https://api.monday.com/v2';

const FORM_SUBMISSIONS_BOARD = '18411549110';
const ORGANIC_LIST_BOARD = '18008046494';

// Same column IDs monday-sales.js uses (locked 2026-07-17).
const CALL_COL = {
  date_15: 'date4',
  date_45: 'date_mkxxtzhe',
  outcome: 'status',
  contracted: 'numeric_mkpq8d77',
  collected: 'numeric_mkpq7kcy',
};

const NOT_SHOWN_OUTCOMES = new Set(['No Show', 'Needs Rebooking', 'Canceled', '']);
const CLOSED_OUTCOMES = new Set(['Sold', 'Bloodwork Only', 'Bloodwork Sold']);

const MONTH_LABELS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// ─── In-process cache (5min) ───
const cache = new Map();
function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const p = Promise.resolve().then(fn);
  cache.set(key, { value: p, expires: now + ttlMs });
  // If promise rejects, evict so the next call retries.
  p.catch(() => cache.delete(key));
  return p;
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function mondayQuery(query) {
  const token = requireEnv('MONDAY_API_TOKEN');
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Monday ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Monday errors: ${JSON.stringify(json.errors)}`);
  return json;
}

/**
 * Paginated fetch of every item on a lead board, returning `[{id, created_at}]`.
 * We only need created_at to bucket by month.
 */
async function fetchLeadBoardCreatedDates(boardId) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < 40; i += 1) {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const q = `
      {
        boards(ids: [${boardId}]) {
          items_page(limit: 200${cursorArg}) {
            cursor
            items { id created_at }
          }
        }
      }
    `;
    const data = await mondayQuery(q);
    const page = data.data?.boards?.[0]?.items_page;
    if (!page) break;
    out.push(...(page.items || []));
    cursor = page.cursor;
    if (!cursor) break;
  }
  return out;
}

function pickCol(item, colId) {
  for (const c of item.column_values || []) {
    if (c.id === colId) return c.text || '';
  }
  return '';
}

function monthIndex(isoDate) {
  if (!isoDate) return -1;
  // isoDate is either "2026-05-17" or "2026-05-04T23:17:38Z"
  const s = String(isoDate).slice(0, 10);
  const [y, m] = s.split('-');
  if (!y || !m) return -1;
  return { year: Number(y), monthIdx: Number(m) - 1 };
}

function emptyMonth(label) {
  return {
    month: label,
    spend: 0,
    leads: 0,
    calls_15_booked: 0,
    calls_15_shown: 0,
    calls_45_booked: 0,
    calls_45_shown: 0,
    sales: 0,
    cash_collected: 0,
    cash_contracted: 0,
    total_deal_value: 0,
    rocket_collected: null,
  };
}

async function fetchAdSpendByMonth(supabase, year) {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const { data, error } = await supabase
    .from('ad_metrics')
    .select('date, spend')
    .gte('date', start)
    .lte('date', end);
  if (error) throw error;

  const perMonth = Array(12).fill(0);
  for (const r of data || []) {
    const idx = monthIndex(r.date);
    if (idx && idx.year === year) {
      perMonth[idx.monthIdx] += Number(r.spend || 0);
    }
  }
  return perMonth;
}

async function fetchLeadsByMonth(year) {
  // Parallel: form-submissions + organic-list.
  const [formItems, organicItems] = await Promise.all([
    fetchLeadBoardCreatedDates(FORM_SUBMISSIONS_BOARD),
    fetchLeadBoardCreatedDates(ORGANIC_LIST_BOARD),
  ]);

  const perMonth = Array(12).fill(0);
  for (const it of [...formItems, ...organicItems]) {
    const idx = monthIndex(it.created_at);
    if (idx && idx.year === year) perMonth[idx.monthIdx] += 1;
  }
  return perMonth;
}

/**
 * Bucket every booked-call item into JAN-DEC of `year`, splitting into 15s/45s
 * and tracking shown + sales + cash.
 */
function bucketCalls(items, year) {
  const rows = MONTH_LABELS.map(emptyMonth);

  for (const it of items) {
    const d15 = pickCol(it, CALL_COL.date_15);
    const d45 = pickCol(it, CALL_COL.date_45);
    const outcome = pickCol(it, CALL_COL.outcome);
    const contracted = Number(pickCol(it, CALL_COL.contracted) || 0);
    const collected = Number(pickCol(it, CALL_COL.collected) || 0);

    // 15s: date_15 exists AND no date_45 (biweekly rule)
    if (d15 && !d45) {
      const idx = monthIndex(d15);
      if (idx && idx.year === year) {
        const row = rows[idx.monthIdx];
        row.calls_15_booked += 1;
        if (!NOT_SHOWN_OUTCOMES.has(outcome)) row.calls_15_shown += 1;
        if (CLOSED_OUTCOMES.has(outcome)) {
          row.sales += 1;
          row.cash_collected += collected;
          row.cash_contracted += contracted;
          row.total_deal_value += contracted;
        }
      }
    }

    // 45s: date_45 exists
    if (d45) {
      const idx = monthIndex(d45);
      if (idx && idx.year === year) {
        const row = rows[idx.monthIdx];
        row.calls_45_booked += 1;
        if (!NOT_SHOWN_OUTCOMES.has(outcome)) row.calls_45_shown += 1;
        if (CLOSED_OUTCOMES.has(outcome)) {
          row.sales += 1;
          row.cash_collected += collected;
          row.cash_contracted += contracted;
          row.total_deal_value += contracted;
        }
      }
    }
  }

  return rows;
}

/**
 * Compose the final per-month rows with derived efficiency + cash metrics.
 */
function decorateWithDerived(rows, spendByMonth, leadsByMonth) {
  return rows.map((row, i) => {
    const spend = spendByMonth[i] || 0;
    const leads = leadsByMonth[i] || 0;
    const combined = {
      ...row,
      spend,
      leads,
    };

    combined.cost_per_lead = leads > 0 ? spend / leads : null;
    combined.cost_per_45 = row.calls_45_booked > 0 ? spend / row.calls_45_booked : null;
    combined.cost_per_sale = row.sales > 0 ? spend / row.sales : null;
    combined.lead_to_sale = leads > 0 ? row.sales / leads : null;

    const bookedTotal = row.calls_15_booked + row.calls_45_booked;
    const shownTotal = row.calls_15_shown + row.calls_45_shown;
    combined.show_rate = bookedTotal > 0 ? shownTotal / bookedTotal : null;
    combined.close_rate = shownTotal > 0 ? row.sales / shownTotal : null;

    combined.profit_after_ads = row.cash_collected - spend;
    combined.pct_cash_collected = row.cash_contracted > 0 ? row.cash_collected / row.cash_contracted : null;
    combined.roas_collected = spend > 0 ? row.cash_collected / spend : null;
    combined.roas_contracted = spend > 0 ? row.cash_contracted / spend : null;

    return combined;
  });
}

/**
 * YTD totals aggregate over months where at least one metric has data.
 */
function computeTotals(months, currentMonthIdx) {
  const ytd = {
    spend: 0, leads: 0,
    calls_15_booked: 0, calls_15_shown: 0,
    calls_45_booked: 0, calls_45_shown: 0,
    sales: 0,
    cash_collected: 0, cash_contracted: 0, total_deal_value: 0,
    profit_after_ads: 0,
  };

  for (let i = 0; i <= currentMonthIdx && i < months.length; i += 1) {
    const m = months[i];
    ytd.spend += m.spend;
    ytd.leads += m.leads;
    ytd.calls_15_booked += m.calls_15_booked;
    ytd.calls_15_shown += m.calls_15_shown;
    ytd.calls_45_booked += m.calls_45_booked;
    ytd.calls_45_shown += m.calls_45_shown;
    ytd.sales += m.sales;
    ytd.cash_collected += m.cash_collected;
    ytd.cash_contracted += m.cash_contracted;
    ytd.total_deal_value += m.total_deal_value;
    ytd.profit_after_ads += m.profit_after_ads;
  }

  const bookedTotal = ytd.calls_15_booked + ytd.calls_45_booked;
  const shownTotal = ytd.calls_15_shown + ytd.calls_45_shown;

  return {
    ...ytd,
    cost_per_lead: ytd.leads > 0 ? ytd.spend / ytd.leads : null,
    cost_per_45: ytd.calls_45_booked > 0 ? ytd.spend / ytd.calls_45_booked : null,
    cost_per_sale: ytd.sales > 0 ? ytd.spend / ytd.sales : null,
    lead_to_sale: ytd.leads > 0 ? ytd.sales / ytd.leads : null,
    show_rate: bookedTotal > 0 ? shownTotal / bookedTotal : null,
    close_rate: shownTotal > 0 ? ytd.sales / shownTotal : null,
    pct_cash_collected: ytd.cash_contracted > 0 ? ytd.cash_collected / ytd.cash_contracted : null,
    roas_collected: ytd.spend > 0 ? ytd.cash_collected / ytd.spend : null,
    roas_contracted: ytd.spend > 0 ? ytd.cash_contracted / ytd.spend : null,
    rocket_collected: null,
  };
}

/**
 * Main entry point.
 * @param {object} supabase — server-side supabase client
 * @param {number} year — 4-digit year (e.g. 2026)
 */
export async function computeMonthlyKPIs(supabase, year) {
  const now = new Date();
  const currentMonthIdx = year === now.getFullYear() ? now.getMonth() : 11;

  const [spendByMonth, leadsByMonth, callItems] = await Promise.all([
    fetchAdSpendByMonth(supabase, year),
    fetchLeadsByMonth(year),
    fetchBookedCallsItems(),
  ]);

  const bucketed = bucketCalls(callItems, year);
  const months = decorateWithDerived(bucketed, spendByMonth, leadsByMonth);
  const ytd = computeTotals(months, currentMonthIdx);

  return {
    year,
    current_month_idx: currentMonthIdx, // future months hide in UI
    months,
    ytd,
  };
}

export function registerCompanyKpiRoutes({ app, supabase }) {
  app.get('/api/v2/company-kpi', async (req, res) => {
    const year = Number(req.query.year) || new Date().getFullYear();
    if (year < 2020 || year > 2100) {
      return res.status(400).json({ error: 'year must be between 2020 and 2100' });
    }
    try {
      const key = `company-kpi:${year}`;
      const data = await cached(key, 5 * 60 * 1000, () => computeMonthlyKPIs(supabase, year));
      res.json(data);
    } catch (e) {
      console.error('[company-kpi]', e);
      res.status(500).json({ error: e.message });
    }
  });
}
