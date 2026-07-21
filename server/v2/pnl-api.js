// P&L API — revenue from Stripe + expenses from Supabase + LLM categorization
// Wired into routes.js by registerPnlRoutes({ app, supabase, anthropic }).

import Anthropic from '@anthropic-ai/sdk';
import { fetchRetry } from './http.js';
import { cachedFetch } from './cache.js';

// ─── Windows ───────────────────────────────────────────────
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Returns { start, end } ISO YYYY-MM-DD for a named period.
 * Supported: mtd | last30 | ytd
 */
export function windowFromPeriod(period = 'mtd') {
  const end = todayISO();
  const now = new Date();
  let start;
  if (period === 'last30') {
    const d = new Date();
    d.setDate(d.getDate() - 29);
    start = d.toISOString().slice(0, 10);
  } else if (period === 'ytd') {
    start = `${now.getFullYear()}-01-01`;
  } else {
    // mtd default
    start = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }
  return { start, end, period };
}

// ─── CSV parsing (shape-agnostic) ──────────────────────────
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; continue; }
      inQ = !inQ; continue;
    }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

const HEADER_ALIAS = {
  date: ['date', 'transaction date', 'posted date', 'trans date'],
  amount: ['amount', 'debit', 'charge', 'transaction amount'],
  merchant: ['merchant', 'name', 'description', 'payee', 'vendor'],
  category: ['category', 'type'],
};

function pickHeader(headers, key) {
  const aliases = HEADER_ALIAS[key];
  const lower = headers.map(h => h.toLowerCase());
  for (const alias of aliases) {
    const i = lower.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

/**
 * Parse CSV text into normalized expense rows.
 * Returns rows w/ { date, amount, merchant, category } — filters income/payments.
 */
export function parseExpensesCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { rows: [], skipped: 0 };

  const headers = parseCsvLine(lines[0]);
  const iDate = pickHeader(headers, 'date');
  const iAmount = pickHeader(headers, 'amount');
  const iMerchant = pickHeader(headers, 'merchant');
  const iCategory = pickHeader(headers, 'category');

  if (iDate === -1 || iAmount === -1 || iMerchant === -1) {
    throw new Error(`CSV missing required headers. Got: ${headers.join(', ')}. Need date/amount/merchant (or name/description).`);
  }

  const rows = [];
  let skipped = 0;
  for (let li = 1; li < lines.length; li++) {
    const cells = parseCsvLine(lines[li]);
    const raw = cells[iAmount] || '0';
    // Strip $, commas, parens (accounting negatives), spaces
    let amt = parseFloat(raw.replace(/[$,\s]/g, '').replace(/^\((.+)\)$/, '-$1'));
    if (Number.isNaN(amt)) { skipped++; continue; }

    // Expenses only — Copilot/RM export income as negative, we want positive expense rows.
    // Skip income (< 0) and skip zero rows.
    if (amt <= 0) { skipped++; continue; }

    const rawDate = cells[iDate];
    let date = rawDate;
    // Try to normalize m/d/yyyy → yyyy-mm-dd
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(rawDate)) {
      const [m, d, y] = rawDate.split('/');
      const yy = y.length === 2 ? `20${y}` : y;
      date = `${yy}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    } else if (/^\d{4}-\d{2}-\d{2}/.test(rawDate)) {
      date = rawDate.slice(0, 10);
    } else {
      const dObj = new Date(rawDate);
      if (Number.isNaN(dObj.getTime())) { skipped++; continue; }
      date = dObj.toISOString().slice(0, 10);
    }

    const merchant = (cells[iMerchant] || '').slice(0, 200);
    const csvCategory = iCategory !== -1 ? (cells[iCategory] || '') : '';

    // Skip credit card payments — those are transfers, not expenses.
    if (/credit card payment|payment thank you|autopay|^payment$/i.test(csvCategory) ||
        /amex payment|autopay|payment received/i.test(merchant)) {
      skipped++; continue;
    }

    rows.push({ date, amount: Number(amt.toFixed(2)), merchant, csv_category: csvCategory });
  }
  return { rows, skipped };
}

// ─── LLM categorization ────────────────────────────────────
const CATEGORY_LIST = [
  'Ads', 'Software', 'Contractors', 'Coaching Fees',
  'Meals', 'Travel', 'Bank Fees', 'Personal', 'Other',
];

const RULES = [
  { match: /(meta|facebook|instagram|google ads|adwords|tiktok ads|linkedin ads)/i, category: 'Ads' },
  { match: /(anthropic|openai|zapier|notion|airtable|slack|linear|figma|adobe|apple\.com\/bill|github|vercel|netlify|whop|abc fitness|trainerize|manychat|gohighlevel|ghl|stripe billing)/i, category: 'Software' },
  { match: /(upwork|fiverr|contra|deel|gusto|payroll)/i, category: 'Contractors' },
  { match: /(marek|bloodwork|labcorp|quest diagnostics)/i, category: 'Coaching Fees' },
  { match: /(doordash|uber ?eats|grubhub|starbucks|chipotle|sweetgreen|mcdonalds|restaurant|cafe|coffee|deli|kitchen|bistro|dining)/i, category: 'Meals' },
  { match: /(uber|lyft|airbnb|hotel|airline|delta|united|american air|southwest|marriott|hilton|hyatt|expedia)/i, category: 'Travel' },
  { match: /(interest charge|foreign transaction|late fee|overdraft|atm fee|wire fee|purchase interest)/i, category: 'Bank Fees' },
];

function ruleBasedCategory(merchant) {
  for (const r of RULES) {
    if (r.match.test(merchant)) return r.category;
  }
  return null;
}

/**
 * Categorize rows via rules first, then LLM for the remainder.
 * Mutates rows in-place to add { category, subcategory }.
 * Returns count of LLM-categorized.
 */
export async function categorizeRows(anthropic, rows) {
  // Pass 1: rules
  const needsLLM = [];
  for (let i = 0; i < rows.length; i++) {
    const cat = ruleBasedCategory(rows[i].merchant);
    if (cat) {
      rows[i].category = cat;
      rows[i].subcategory = null;
    } else {
      needsLLM.push({ idx: i, merchant: rows[i].merchant, amount: rows[i].amount, hint: rows[i].csv_category });
    }
  }
  if (!needsLLM.length) return 0;

  // Pass 2: batch LLM (50 per call)
  const BATCH = 50;
  let llmCount = 0;
  for (let start = 0; start < needsLLM.length; start += BATCH) {
    const batch = needsLLM.slice(start, start + BATCH);
    const catalog = batch.map((r, i) => ({
      row_index: i,
      merchant: r.merchant,
      amount: r.amount,
      csv_hint: r.hint || null,
    }));

    const prompt = `You are categorizing business expenses for Zach Faerber, an online fitness coach + creator (Faerber Fitness / Balanced Blueprint).

Categories (use EXACTLY one from this list):
${CATEGORY_LIST.map(c => `- ${c}`).join('\n')}

Guidance:
- Ads = paid media spend (Meta, Google, TikTok, LinkedIn ads).
- Software = SaaS tools, subscriptions, hosting.
- Contractors = 1099 pay, payroll, freelancers, VAs.
- Coaching Fees = pass-through client charges (labs, tests, program tools he buys for clients).
- Meals = restaurants, coffee, food delivery.
- Travel = flights, hotels, rideshare, Airbnb.
- Bank Fees = interest, FX fees, late fees, overdrafts.
- Personal = clearly not business (groceries at Whole Foods, personal shopping, home stuff).
- Other = anything you can't confidently place.

Return ONLY valid JSON — an array with one object per row, same order:
[{"row_index": 0, "category": "Software", "subcategory": "CRM", "confidence": 0.9}, ...]

Rows:
${JSON.stringify(catalog, null, 2)}`;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }],
      });
      const text = response.content?.[0]?.text || '[]';
      // Extract JSON array (LLM might wrap in prose)
      const match = text.match(/\[[\s\S]*\]/);
      const parsed = JSON.parse(match ? match[0] : text);
      for (const item of parsed) {
        const target = batch[item.row_index];
        if (!target) continue;
        const cat = CATEGORY_LIST.includes(item.category) ? item.category : 'Other';
        rows[target.idx].category = cat;
        rows[target.idx].subcategory = item.subcategory || null;
        llmCount++;
      }
    } catch (err) {
      console.error('[pnl] LLM categorization batch failed:', err.message);
      // Fallback: mark uncategorized batch as 'Other'
      for (const b of batch) {
        rows[b.idx].category = 'Other';
        rows[b.idx].subcategory = null;
      }
    }
  }

  return llmCount;
}

// ─── Stripe revenue ────────────────────────────────────────
// Zach runs multiple Stripe accounts — aggregate revenue across all of them.
// Add/remove entries here if more accounts get wired.
const STRIPE_ACCOUNTS = [
  { label: 'Medical', env: 'STRIPE_SK_MEDICAL' },
  { label: 'Pandadoc', env: 'STRIPE_SK_PANDADOC' },
  { label: 'Affirm', env: 'STRIPE_SK_AFFIRM' },
  // Fallback: also honor a generic key if someone sets it
  { label: 'Default', env: 'STRIPE_SECRET_KEY' },
];

async function fetchOneAccount(label, key, startTs, endTs) {
  let total = 0;
  let count = 0;
  const byDay = {};
  let hasMore = true;
  let startingAfter = null;
  const PAGE = 100;
  const MAX_PAGES = 25;

  for (let page = 0; page < MAX_PAGES && hasMore; page++) {
    const params = new URLSearchParams({
      limit: String(PAGE),
      'created[gte]': String(startTs),
      'created[lte]': String(endTs),
    });
    if (startingAfter) params.set('starting_after', startingAfter);

    const res = await fetchRetry(`https://api.stripe.com/v1/charges?${params}`, {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`[${label}] Stripe API ${res.status}: ${err.slice(0, 200)}`);
    }
    const body = await res.json();
    for (const ch of body.data || []) {
      if (ch.status !== 'succeeded' || ch.refunded) continue;
      const amt = (ch.amount - (ch.amount_refunded || 0)) / 100;
      if (amt <= 0) continue;
      total += amt;
      count++;
      const day = new Date(ch.created * 1000).toISOString().slice(0, 10);
      byDay[day] = (byDay[day] || 0) + amt;
    }
    hasMore = body.has_more;
    if (hasMore && body.data?.length) startingAfter = body.data[body.data.length - 1].id;
  }

  return { label, total: Number(total.toFixed(2)), by_day: byDay, count };
}

/**
 * Fetch succeeded Stripe charges across all configured accounts between start/end.
 * Returns { total, by_day: { [YYYY-MM-DD]: sum }, count, by_account: [{label,total,count}], warnings[] }.
 *
 * Cached 5 min per window — Stripe charge history only changes when new charges land.
 */
export async function fetchStripeRevenue(start, end) {
  return cachedFetch(`stripe:${start}:${end}`, 5 * 60 * 1000, () => _fetchStripeRevenueRaw(start, end));
}

async function _fetchStripeRevenueRaw(start, end) {
  const configured = STRIPE_ACCOUNTS.filter(a => process.env[a.env]);
  if (!configured.length) {
    return {
      total: 0,
      by_day: {},
      count: 0,
      by_account: [],
      warning: 'No Stripe keys set (STRIPE_SK_MEDICAL / STRIPE_SK_PANDADOC / STRIPE_SK_AFFIRM / STRIPE_SECRET_KEY) — revenue is zero.',
    };
  }

  const startTs = Math.floor(new Date(`${start}T00:00:00Z`).getTime() / 1000);
  const endTs = Math.floor(new Date(`${end}T23:59:59Z`).getTime() / 1000);

  const results = await Promise.all(
    configured.map(a =>
      fetchOneAccount(a.label, process.env[a.env], startTs, endTs).catch(err => ({
        label: a.label,
        total: 0,
        by_day: {},
        count: 0,
        error: err.message,
      }))
    )
  );

  const total = results.reduce((s, r) => s + (r.total || 0), 0);
  const count = results.reduce((s, r) => s + (r.count || 0), 0);
  const byDay = {};
  for (const r of results) {
    for (const [day, amt] of Object.entries(r.by_day || {})) {
      byDay[day] = (byDay[day] || 0) + amt;
    }
  }
  const warnings = results.filter(r => r.error).map(r => `[${r.label}] ${r.error}`);
  const byAccount = results.map(r => ({ label: r.label, total: Number((r.total || 0).toFixed(2)), count: r.count || 0, error: r.error || null }));

  return {
    total: Number(total.toFixed(2)),
    by_day: byDay,
    count,
    by_account: byAccount,
    ...(warnings.length ? { warnings } : {}),
  };
}

// ─── Route registration ────────────────────────────────────
export function registerPnlRoutes({ app, supabase }) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // GET /api/v2/pnl/summary?period=mtd
  app.get('/api/v2/pnl/summary', async (req, res) => {
    const { start, end, period } = windowFromPeriod(req.query.period);
    const warnings = [];
    const [revenue, expensesResp] = await Promise.all([
      fetchStripeRevenue(start, end).catch(err => ({ total: 0, by_day: {}, count: 0, error: err.message })),
      supabase.from('expenses').select('date, amount').gte('date', start).lte('date', end)
        .then(r => r, err => ({ data: null, error: { message: err.message || String(err) } })),
    ]);
    if (revenue.error) warnings.push(`stripe: ${revenue.error}`);
    if (expensesResp.error) warnings.push(`supabase(expenses): ${expensesResp.error.message}`);

    const expenseRows = expensesResp.data || [];
    const expenseTotal = expenseRows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const spark = buildSparkSeries(revenue.by_day, expenseRows);

    res.json({
      period, window: { start, end },
      revenue: Number((revenue.total || 0).toFixed(2)),
      revenue_count: revenue.count || 0,
      revenue_warning: revenue.warning || revenue.error || null,
      expenses: Number(expenseTotal.toFixed(2)),
      net: Number(((revenue.total || 0) - expenseTotal).toFixed(2)),
      spark_revenue: spark.revenue,
      spark_expenses: spark.expenses,
      _partial: warnings.length > 0,
      _warnings: warnings,
    });
  });

  // GET /api/v2/pnl/revenue?period=mtd
  app.get('/api/v2/pnl/revenue', async (req, res) => {
    const { start, end, period } = windowFromPeriod(req.query.period);
    try {
      const revenue = await fetchStripeRevenue(start, end);
      res.json({ period, window: { start, end }, ...revenue });
    } catch (e) {
      console.error('[pnl/revenue]', e);
      res.status(200).json({
        _partial: true, _error: e.message,
        period, window: { start, end },
        total: 0, by_day: {}, count: 0, warning: e.message,
      });
    }
  });

  // GET /api/v2/pnl/expenses?period=mtd&limit=100
  app.get('/api/v2/pnl/expenses', async (req, res) => {
    const { start, end, period } = windowFromPeriod(req.query.period);
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    let rows = [];
    let warning = null;
    try {
      const resp = await supabase
        .from('expenses')
        .select('id, date, amount, merchant, category, subcategory, source_file')
        .gte('date', start).lte('date', end)
        .order('date', { ascending: false })
        .limit(limit);
      if (resp.error) throw resp.error;
      rows = resp.data || [];
    } catch (e) {
      console.error('[pnl/expenses]', e);
      warning = e.message || String(e);
    }

    const byCategory = {};
    let total = 0;
    for (const r of rows) {
      const cat = r.category || 'Uncategorized';
      byCategory[cat] = (byCategory[cat] || 0) + Number(r.amount || 0);
      total += Number(r.amount || 0);
    }
    const categories = Object.entries(byCategory)
      .map(([label, value]) => ({ label, value: Number(value.toFixed(2)) }))
      .sort((a, b) => b.value - a.value);

    res.json({
      period, window: { start, end },
      total: Number(total.toFixed(2)),
      rows,
      categories,
      _partial: warning != null,
      _warnings: warning ? [warning] : [],
    });
  });

  // GET /api/v2/pnl/monthly?months=12
  app.get('/api/v2/pnl/monthly', async (req, res) => {
    const months = Math.max(1, Math.min(24, Number(req.query.months) || 12));
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - (months - 1), 1);
    const startISO = start.toISOString().slice(0, 10);
    const endISO = todayISO();

    const warnings = [];
    const [revenue, expensesResp] = await Promise.all([
      fetchStripeRevenue(startISO, endISO).catch(err => { warnings.push(`stripe: ${err.message}`); return { by_day: {} }; }),
      supabase.from('expenses').select('date, amount').gte('date', startISO).lte('date', endISO)
        .then(r => r, err => { warnings.push(`supabase(expenses): ${err.message || err}`); return { data: [] }; }),
    ]);
    if (expensesResp.error) warnings.push(`supabase(expenses): ${expensesResp.error.message}`);

    const byMonth = {};
    const ensure = (k) => (byMonth[k] ||= { month: k, revenue: 0, expenses: 0 });

    for (const [day, v] of Object.entries(revenue.by_day || {})) {
      ensure(day.slice(0, 7)).revenue += v;
    }
    for (const r of expensesResp.data || []) {
      ensure(String(r.date).slice(0, 7)).expenses += Number(r.amount || 0);
    }
    for (let i = 0; i < months; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      ensure(k);
    }
    const rows = Object.values(byMonth)
      .map(r => ({ ...r, revenue: Number(r.revenue.toFixed(2)), expenses: Number(r.expenses.toFixed(2)), net: Number((r.revenue - r.expenses).toFixed(2)) }))
      .sort((a, b) => a.month.localeCompare(b.month));

    res.json({ months, rows, _partial: warnings.length > 0, _warnings: warnings });
  });

  // POST /api/v2/pnl/import-csv  { filename, csv_text }
  app.post('/api/v2/pnl/import-csv', async (req, res) => {
    const { filename, csv_text } = req.body || {};
    if (!filename || !csv_text) {
      return res.status(400).json({ error: 'filename + csv_text required in JSON body' });
    }
    if (csv_text.length > 4_000_000) {
      return res.status(413).json({ error: 'CSV too large (>4MB)' });
    }

    try {
      const { rows, skipped } = parseExpensesCsv(csv_text);
      if (!rows.length) {
        return res.json({ imported: 0, categorized: 0, skipped, message: 'No expense rows found in CSV.' });
      }

      const llmCount = await categorizeRows(anthropic, rows);

      // Upsert to expenses (unique on date+amount+merchant+source_file)
      const payload = rows.map(r => ({
        date: r.date,
        amount: r.amount,
        merchant: r.merchant,
        category: r.category || 'Other',
        subcategory: r.subcategory || null,
        source_file: filename,
      }));

      const { error } = await supabase
        .from('expenses')
        .upsert(payload, { onConflict: 'date,amount,merchant,source_file', ignoreDuplicates: true });
      if (error) throw error;

      res.json({
        imported: rows.length,
        categorized: llmCount,
        rule_matched: rows.length - llmCount,
        skipped,
        filename,
      });
    } catch (e) {
      console.error('[pnl/import-csv]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v2/pnl/expenses/:id/category  { category, subcategory? }
  app.post('/api/v2/pnl/expenses/:id/category', async (req, res) => {
    const { id } = req.params;
    const { category, subcategory } = req.body || {};
    if (!category || !CATEGORY_LIST.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORY_LIST.join(', ')}` });
    }
    try {
      const { data, error } = await supabase
        .from('expenses')
        .update({ category, subcategory: subcategory || null })
        .eq('id', id)
        .select().single();
      if (error) throw error;
      res.json({ ok: true, row: data });
    } catch (e) {
      console.error('[pnl/expenses/category]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v2/pnl/categories — expose list to UI dropdowns
  app.get('/api/v2/pnl/categories', (_req, res) => {
    res.json({ categories: CATEGORY_LIST });
  });
}

// Build 30-day sparkline series from Stripe by_day map + expense rows.
function buildSparkSeries(revenueByDay, expenseRows) {
  const revenue = [];
  const expenses = [];
  const expenseByDay = {};
  for (const r of expenseRows || []) {
    expenseByDay[r.date] = (expenseByDay[r.date] || 0) + Number(r.amount || 0);
  }
  const today = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const k = d.toISOString().slice(0, 10);
    revenue.push(Number((revenueByDay[k] || 0).toFixed(2)));
    expenses.push(Number((expenseByDay[k] || 0).toFixed(2)));
  }
  return { revenue, expenses };
}
