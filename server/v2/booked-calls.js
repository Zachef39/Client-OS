// Booked Calls — SINGLE source of truth for the Client OS sales dashboard.
// Locked to Monday board 18372257888 ("Booked Calls") post-2026-07-20 cleanup.
// Spec: ~/.claude/projects/-Users-zachef/memory/reference_booked_calls_dashboard_spec.md
//
// Every KPI on the Overview / Sales / Ads tabs comes through getBookedCallsKPIs().
// Do not add math anywhere else — call this function.

import { fetchRetry } from './http.js';
import { __getCachedUserName } from './monday-sales.js';

// ── Monday constants ────────────────────────────────────
const MONDAY_API = 'https://api.monday.com/v2';
const BOARD_ID = process.env.MONDAY_BOARD_ID || '18372257888';

// Column IDs — exact literals from the post-cleanup board.
const COL = {
  date: 'date4',                          // Call Date (only date col that matters now)
  outcome: 'status',                      // Outcome (Sold / Unsuccessful / DQ / …)
  closer: 'person',                       // Closer (Zach, Dina)
  setter: 'multiple_person_mkvsxzf9',     // Setter/DMer (Spencer, Sheila — often both)
  contracted: 'numeric_mkpq8d77',         // $ Contracted
  collected: 'numeric_mkpq7kcy',          // $ Initial Collected
  keyword: 'dropdown_mkpq2nxj',           // Lead-source keyword (paid vs organic)
  lostReason: 'dropdown_mm2qma67',        // Lost Reason (only Unsuccessful/NoShow rows)
  program: 'dropdown_mkpq36f8',           // Program signed for
};
const COL_IDS = Object.values(COL);

const PERSON_COL_IDS = new Set([COL.closer, COL.setter]);

// ── Outcome vocabulary (label strings, not indexes — safer if labels reorder) ─
const OUTCOME = {
  SOLD: 'Sold',
  UNSUCCESSFUL: 'Unsuccessful',
  BLOODWORK_ONLY: 'Bloodwork Only',
  NO_SHOW: 'No Show',
  NEEDS_REBOOKING: 'Needs Rebooking',
  DQ: 'DQ',
  CANCELED: 'Canceled',
  NURTURE: 'Nurture',
  REBOOKED: 'Rebooked',
  SALES_CALL_BOOKED: 'Sales Call Booked',
  QUALIFIED_45: '45 Qualified',
};

// Per spec KPI definitions:
const SHOWN_OUTCOMES = new Set([OUTCOME.SOLD, OUTCOME.UNSUCCESSFUL, OUTCOME.BLOODWORK_ONLY]);
const CLOSED_OUTCOMES = new Set([OUTCOME.SOLD, OUTCOME.BLOODWORK_ONLY]);
// No-show = ghost only. "Needs Rebooking" excluded — polite reschedules don't hurt show rate (industry standard).
const NO_SHOW_OUTCOMES = new Set([OUTCOME.NO_SHOW]);
const RESCHEDULED_OUTCOMES = new Set([OUTCOME.NEEDS_REBOOKING]);
const DQ_CANCELED_OUTCOMES = new Set([OUTCOME.DQ, OUTCOME.CANCELED]);
// Upcoming = on the calendar but not yet taken. Per Zach 2026-07-20.
const UPCOMING_OUTCOMES = new Set([OUTCOME.SALES_CALL_BOOKED, OUTCOME.REBOOKED, OUTCOME.QUALIFIED_45]);

// Organic keyword list (case-insensitive exact match). Everything else = paid.
const ORGANIC_KEYWORDS = new Set(
  ['New Follower', 'Referral', 'Outreach', 'Friend', 'Reactivation SMS', 'Resign']
    .map(k => k.toLowerCase())
);

// Setter name whitelist — only credit named setters, ignore anyone else that
// sneaks into the multi-person column. Match on first name (case-insensitive).
const NAMED_SETTERS = new Set(['spencer', 'sheila']);

// Group ID → nice title fallback (in case Monday response omits titles).
const GROUP_TITLES = {
  'topics': 'Call Scheduled',
  'group_mkpqnxbg': 'Upcoming Calls',
  'group_mkxxgbeb': 'Qualified Calls',
  'group_mkpqdcta': "Today's Calls",
  'group_mkpqj4rk': 'Completed Calls',
  'group_mkpy5wh7': 'GET REBOOKED',
  'group_mkpqvsex': 'Calls Not Taken',
  'group_mkvf7eqk': 'DQ',
  'group_mkr8kbg5': 'CLOSE TO CLOSING!',
  'group_mkxx36ay': 'Future Follow Ups',
};

// ── Helpers ─────────────────────────────────────────────
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function mondayQuery(query) {
  const token = requireEnv('MONDAY_API_TOKEN');
  const res = await fetchRetry(MONDAY_API, {
    method: 'POST',
    headers: { Authorization: token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Monday ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Monday errors: ${JSON.stringify(json.errors)}`);
  return json;
}

function pickCol(item, colId) {
  for (const c of (item.column_values || [])) {
    if (c.id === colId) return c;
  }
  return null;
}

function colText(item, colId) {
  return pickCol(item, colId)?.text || '';
}

function colNumber(item, colId) {
  const n = Number(colText(item, colId));
  return Number.isFinite(n) ? n : 0;
}

function parsePersonIds(colValue) {
  if (!colValue) return [];
  try {
    const parsed = typeof colValue === 'string' ? JSON.parse(colValue) : colValue;
    const arr = parsed?.personsAndTeams || [];
    return arr.filter(p => p && (p.kind === 'person' || !p.kind)).map(p => String(p.id));
  } catch {
    return [];
  }
}

function personNames(item, colId) {
  const c = pickCol(item, colId);
  if (!c) return [];
  const ids = parsePersonIds(c.value);
  const resolved = ids.map(id => __getCachedUserName(id)).filter(Boolean);
  if (resolved.length > 0) return resolved;
  // Fallback: Monday's `text` field is a comma-joined list of names.
  return c.text ? c.text.split(',').map(s => s.trim()).filter(Boolean) : [];
}

function firstName(fullName) {
  return (fullName || '').trim().split(/\s+/)[0] || '';
}

// ── Person-name cache seeding ───────────────────────────
// booked-calls owns its own cache seed so it can run standalone (verification
// script, cron, etc) without depending on monday-sales.js internals.
const _userCache = new Map();
function cacheGet(id) {
  return _userCache.get(String(id)) || __getCachedUserName(id);
}
async function resolveUserIds(ids) {
  const unknown = [...new Set(ids)].filter(id => id && !cacheGet(id));
  if (unknown.length === 0) return;
  const idList = unknown.map(id => Number(id)).filter(n => Number.isFinite(n)).join(',');
  if (!idList) return;
  try {
    const data = await mondayQuery(`{ users(ids: [${idList}]) { id name } }`);
    for (const u of data.data?.users || []) {
      _userCache.set(String(u.id), u.name || `user:${u.id}`);
    }
  } catch (e) {
    // Non-fatal — fall back to raw text field downstream.
    console.warn('[booked-calls] user resolve failed:', e.message);
  }
  for (const id of unknown) if (!cacheGet(id)) _userCache.set(String(id), `user:${id}`);
}

// Patch personNames() lookup to also check our own cache.
function resolvedName(id) {
  return _userCache.get(String(id)) || __getCachedUserName(id) || null;
}

function personNamesWithFallback(item, colId) {
  const c = pickCol(item, colId);
  if (!c) return [];
  const ids = parsePersonIds(c.value);
  const resolved = ids.map(id => resolvedName(id)).filter(Boolean);
  if (resolved.length > 0) return resolved;
  return c.text ? c.text.split(',').map(s => s.trim()).filter(Boolean) : [];
}

// ── Fetcher ─────────────────────────────────────────────
/**
 * Fetch every item on the Booked Calls board (paginated).
 * Hydrates person-column user names before returning.
 */
async function fetchAllItems() {
  const colList = COL_IDS.map(c => `"${c}"`).join(',');
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
              group { id title }
              column_values(ids: [${colList}]) { id text value type }
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

  // Resolve every person-column user ID → name.
  const ids = new Set();
  for (const it of items) {
    for (const c of it.column_values || []) {
      if (!PERSON_COL_IDS.has(c.id)) continue;
      for (const uid of parsePersonIds(c.value)) ids.add(uid);
    }
  }
  if (ids.size > 0) await resolveUserIds([...ids]);
  return items;
}

// ── Item projection ─────────────────────────────────────
function projectItem(item) {
  const outcome = colText(item, COL.outcome).trim();
  const callDate = colText(item, COL.date) || null;
  const contracted = colNumber(item, COL.contracted);
  const collected = colNumber(item, COL.collected);
  const closerList = personNamesWithFallback(item, COL.closer);
  const setterList = personNamesWithFallback(item, COL.setter);
  const keyword = colText(item, COL.keyword).trim();
  const lostReason = colText(item, COL.lostReason).trim();
  const program = colText(item, COL.program).trim();
  const groupId = item.group?.id || '';
  const groupTitle = item.group?.title || GROUP_TITLES[groupId] || '';

  const isShown = SHOWN_OUTCOMES.has(outcome);
  const isClosedByOutcome = CLOSED_OUTCOMES.has(outcome);
  const isClosedByCash = contracted > 0 || collected > 0;
  const isClosed = isClosedByOutcome || isClosedByCash;
  const isNoShow = NO_SHOW_OUTCOMES.has(outcome);
  const isRescheduled = RESCHEDULED_OUTCOMES.has(outcome);
  const isDqCanceled = DQ_CANCELED_OUTCOMES.has(outcome);
  const isUpcoming = UPCOMING_OUTCOMES.has(outcome);

  // Ads-source classification — organic keyword list (case-insensitive exact match).
  // Missing keyword = paid (per spec).
  const isOrganic = keyword && ORGANIC_KEYWORDS.has(keyword.toLowerCase());
  const isPaid = !isOrganic;

  return {
    id: item.id,
    name: item.name || '',
    callDate,
    outcome,
    closer: closerList[0] || '',
    closers: closerList,
    setters: setterList,
    contracted,
    collected,
    keyword,
    lostReason,
    program,
    groupId,
    groupTitle,
    // Cached flags — spec-driven booleans, used by all rollups
    isShown,
    isClosed,
    isNoShow,
    isRescheduled,
    isDqCanceled,
    isUpcoming,
    isOrganic,
    isPaid,
  };
}

// ── Snapshot cache (per-process, TTL 60s) ───────────────
// Everything downstream calls getBookedCallsKPIs(); one Monday fetch per minute
// even under heavy dashboard use.
const SNAPSHOT_TTL_MS = 60_000;
let _snapshot = { fetchedAt: 0, items: null, promise: null };

async function getSnapshot() {
  const now = Date.now();
  if (_snapshot.items && now - _snapshot.fetchedAt < SNAPSHOT_TTL_MS) {
    return _snapshot.items;
  }
  if (_snapshot.promise) return _snapshot.promise;
  _snapshot.promise = (async () => {
    const raw = await fetchAllItems();
    const projected = raw.map(projectItem);
    _snapshot = { fetchedAt: Date.now(), items: projected, promise: null };
    return projected;
  })();
  try {
    return await _snapshot.promise;
  } catch (e) {
    _snapshot.promise = null;
    throw e;
  }
}

/** Force-refresh — used by cron / manual invalidation. */
export function invalidateBookedCallsCache() {
  _snapshot = { fetchedAt: 0, items: null, promise: null };
}

// ── Public API — SINGLE source function ──────────────────
/**
 * Returns the full KPI object for the given date window (inclusive).
 * @param {{ from: string, to: string }} opts  ISO YYYY-MM-DD strings.
 */
export async function getBookedCallsKPIs({ from, to } = {}) {
  if (!from || !to) throw new Error('getBookedCallsKPIs: from + to (YYYY-MM-DD) required');
  const all = await getSnapshot();
  const items = all.filter(it => it.callDate && it.callDate >= from && it.callDate <= to);
  const kpis = computeKPIs(items, { from, to });

  // Pipeline upcoming = every call on the board with a scheduled/rebooked/qualified
  // outcome — regardless of window. Zach's spec: "if the outcome is 'sales call
  // booked,' 'rebooked,' or 'sales,' those are all upcoming calls." (2026-07-20)
  const today = isoToday();
  const pipelineUpcoming = all.filter(it => it.isUpcoming).length;
  const pipelineUpcomingFuture = all.filter(it => it.isUpcoming && it.callDate && it.callDate >= today).length;
  kpis.pipelineUpcoming = pipelineUpcoming;
  kpis.pipelineUpcomingFuture = pipelineUpcomingFuture;
  return kpis;
}

function isoToday() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

/**
 * Pure aggregator over a pre-filtered slice of projected items.
 * Split out so tests + custom slices (per-closer view, per-source view) can reuse.
 */
export function computeKPIs(items, { from, to }) {
  let booked = 0, shown = 0, closed = 0, noShows = 0, rescheduled = 0, dqCanceled = 0, upcoming = 0;
  let cashContracted = 0, cashCollected = 0;
  let paidBooked = 0, organicBooked = 0, paidClosed = 0, organicClosed = 0;

  const closerAgg = new Map();
  const setterAgg = new Map();
  const stageAgg = new Map();
  const lostReasonCounts = new Map();

  for (const it of items) {
    booked += 1;
    if (it.isShown) shown += 1;
    if (it.isClosed) closed += 1;
    if (it.isNoShow) noShows += 1;
    if (it.isRescheduled) rescheduled += 1;
    if (it.isDqCanceled) dqCanceled += 1;
    if (it.isUpcoming) upcoming += 1;
    if (it.isClosed) {
      cashContracted += it.contracted;
      cashCollected += it.collected;
    }

    // Paid vs organic
    if (it.isPaid) {
      paidBooked += 1;
      if (it.isClosed) paidClosed += 1;
    } else {
      organicBooked += 1;
      if (it.isClosed) organicClosed += 1;
    }

    // Per-closer (single closer; if multiple, first wins — Monday cap is 1)
    const closerName = firstName(it.closer);
    if (closerName) {
      const row = ensureCloserRow(closerAgg, closerName);
      row.booked += 1;
      if (it.isShown) row.shown += 1;
      if (it.isClosed) {
        row.closed += 1;
        row.cashContracted += it.contracted;
        row.cashCollected += it.collected;
      }
    }

    // Per-setter — 0.5/0.5 split on multi. Only credit named setters (spec).
    const setterFirsts = it.setters
      .map(firstName)
      .filter(n => NAMED_SETTERS.has(n.toLowerCase()));
    if (setterFirsts.length > 0) {
      const weight = 1 / setterFirsts.length;
      for (const raw of setterFirsts) {
        const name = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
        const row = ensureSetterRow(setterAgg, name);
        row.booked += weight;
        if (it.isShown) row.shown += weight;
        if (it.isClosed) row.closed += weight;
      }
    }

    // Per-stage (group)
    if (it.groupId) {
      const row = ensureStageRow(stageAgg, it.groupId, it.groupTitle);
      row.booked += 1;
      if (it.isShown) row.shown += 1;
      if (it.isClosed) {
        row.closed += 1;
        row.cashContracted += it.contracted;
        row.cashCollected += it.collected;
      }
    }

    // Lost reasons — only Unsuccessful rows, drop nulls
    if (it.outcome === OUTCOME.UNSUCCESSFUL && it.lostReason) {
      lostReasonCounts.set(it.lostReason, (lostReasonCounts.get(it.lostReason) || 0) + 1);
    }
  }

  // Show Rate excludes polite reschedules (Needs Rebooking) per industry standard.
  const showRate = (shown + noShows) > 0 ? shown / (shown + noShows) : null;
  const closeRate = shown > 0 ? closed / shown : null;
  const rescheduleRate = booked > 0 ? rescheduled / booked : null;

  const byCloser = [...closerAgg.values()].sort((a, b) => b.cashCollected - a.cashCollected);
  const bySetter = [...setterAgg.values()].map(r => ({
    ...r,
    booked: round2(r.booked),
    shown: round2(r.shown),
    closed: round2(r.closed),
  })).sort((a, b) => b.booked - a.booked);
  const byStage = [...stageAgg.values()].sort((a, b) => b.booked - a.booked);
  const lostReasons = [...lostReasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  return {
    window: { from, to },
    booked,
    shown,
    closed,
    noShows,
    rescheduled,
    dqCanceled,
    upcoming,
    showRate,
    closeRate,
    rescheduleRate,
    cashContracted,
    cashCollected,
    byCloser,
    bySetter,
    byStage,
    bySource: { paidBooked, organicBooked, paidClosed, organicClosed },
    lostReasons,
    // ads.spend/cpbc/cpa require Meta pull; overview-api joins them in.
    ads: { spend: null, cpbc: null, cpa: null },
    items,
  };
}

function ensureCloserRow(map, name) {
  if (!map.has(name)) {
    map.set(name, { name, booked: 0, shown: 0, closed: 0, cashContracted: 0, cashCollected: 0 });
  }
  return map.get(name);
}
function ensureSetterRow(map, name) {
  if (!map.has(name)) map.set(name, { name, booked: 0, shown: 0, closed: 0 });
  return map.get(name);
}
function ensureStageRow(map, id, title) {
  if (!map.has(id)) {
    map.set(id, {
      groupId: id, groupTitle: title || id,
      booked: 0, shown: 0, closed: 0, cashContracted: 0, cashCollected: 0,
    });
  }
  return map.get(id);
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY EXPORTS — thin wrappers so routes.js + overview-api.js keep working.
// Each maps the new getBookedCallsKPIs() output to the old dashboard-facing
// shape. New code should call getBookedCallsKPIs() directly.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * @deprecated Legacy wrapper — call getBookedCallsKPIs({ from, to }) instead.
 * Returns the old "unified" shape used by routes.js /booked-calls/* handlers.
 */
export async function fetchBookedCallsUnified(days) {
  const endD = new Date();
  const startD = new Date();
  startD.setDate(startD.getDate() - (days - 1));
  const from = startD.toISOString().slice(0, 10);
  const to = endD.toISOString().slice(0, 10);
  const kpis = await getBookedCallsKPIs({ from, to });

  // Map projected items → legacy unified item shape (source/name/outcome/etc)
  const legacyItems = kpis.items.map(legacyItemShape);
  return {
    window: { start: from, end: to, days },
    items: legacyItems,
    dedup_stats: { monday_total: legacyItems.length, ghl_total: 0, matched: 0, monday_only: legacyItems.length, ghl_only: 0 },
    // Also expose the fresh KPI object so callers can adopt incrementally.
    kpis,
  };
}

function legacyItemShape(it) {
  return {
    source: 'monday',
    name: it.name,
    phone: '',
    email: '',
    booked_date: it.callDate,
    outcome: it.outcome,
    closer_assigned: it.closer,
    setter_assigned: it.setters.join(', '),
    cash_collected: it.collected,
    cash_contracted: it.contracted,
    lead_source: it.keyword,
    program: it.program,
    lost_reason: it.lostReason,
    monday_item_id: it.id,
    ghl_appointment_id: null,
    _group: it.groupTitle,
    // Retain flags so classify() can be a pure re-projection
    _isShown: it.isShown,
    _isClosed: it.isClosed,
    _isNoShow: it.isNoShow,
    _isDqCanceled: it.isDqCanceled,
    _isPaid: it.isPaid,
  };
}

// classify() — legacy pass-through. Returns the flag object the old code used.
// The rich (is_completed, is_pitched, is_upcoming, …) fields the old overview
// leaned on are derived from spec-compliant flags here.
export function classify(item) {
  const shown = !!item._isShown;
  const closed = !!item._isClosed;
  const noShow = !!item._isNoShow;
  const dqCanceled = !!item._isDqCanceled;
  const upcoming = UPCOMING_OUTCOMES.has(item.outcome);
  return {
    is_booked: true,
    is_upcoming: upcoming,
    is_completed: shown || noShow || dqCanceled || closed || (item.outcome === OUTCOME.NURTURE),
    is_pitched: shown,
    is_shown: shown,
    is_closed: closed,
    is_dq: item.outcome === OUTCOME.DQ,
    is_no_show: item.outcome === OUTCOME.NO_SHOW,
    is_canceled: item.outcome === OUTCOME.CANCELED,
    is_nurture: item.outcome === OUTCOME.NURTURE,
    is_rebooked: item.outcome === OUTCOME.REBOOKED || item.outcome === OUTCOME.NEEDS_REBOOKING,
  };
}

/**
 * @deprecated Use getBookedCallsKPIs().
 * Returns the totals-object shape the /booked-calls/summary endpoint used to emit,
 * mapped from the new KPI numbers.
 */
export function summarize(items) {
  let booked = 0, shown = 0, closed = 0, noShow = 0, canceled = 0, dq = 0, nurture = 0, rebooked = 0, upcoming = 0;
  let cashCollected = 0, cashContracted = 0;
  for (const it of items) {
    booked += 1;
    if (it._isShown) shown += 1;
    if (it._isClosed) { closed += 1; cashCollected += Number(it.cash_collected || 0); cashContracted += Number(it.cash_contracted || 0); }
    if (it.outcome === OUTCOME.NO_SHOW) noShow += 1;
    if (it.outcome === OUTCOME.CANCELED) canceled += 1;
    if (it.outcome === OUTCOME.DQ) dq += 1;
    if (it.outcome === OUTCOME.NURTURE) nurture += 1;
    if (it.outcome === OUTCOME.REBOOKED || it.outcome === OUTCOME.NEEDS_REBOOKING) rebooked += 1;
    if (UPCOMING_OUTCOMES.has(it.outcome)) upcoming += 1;
  }
  const completed = booked - upcoming;
  return {
    booked, completed, upcoming,
    pitched: shown, shown, closed,
    dq, no_show: noShow, canceled, nurture, rebooked,
    cash_collected: cashCollected, cash_contracted: cashContracted,
    show_rate: (shown + noShow) > 0 ? shown / (shown + noShow) : null,
    close_rate: shown > 0 ? closed / shown : null,
    dq_rate: completed > 0 ? dq / completed : null,
    by_source: { monday: booked, ghl: 0, both: 0 },
  };
}

/** @deprecated Prefer getBookedCallsKPIs().byCloser. */
export function groupByCloser(items) {
  const map = new Map();
  for (const it of items) {
    const key = firstName(it.closer_assigned) || '(unassigned)';
    if (!map.has(key)) {
      map.set(key, {
        closer: key, booked: 0, shown: 0, pitched: 0, closed: 0,
        cash_collected: 0, cash_contracted: 0, completed: 0, dq: 0, no_show: 0,
      });
    }
    const r = map.get(key);
    r.booked += 1;
    r.completed += 1; // legacy field — treat every row in window as completed
    if (it._isShown) { r.shown += 1; r.pitched += 1; }
    if (it.outcome === OUTCOME.DQ) r.dq += 1;
    if (it.outcome === OUTCOME.NO_SHOW) r.no_show += 1;
    if (it._isClosed) {
      r.closed += 1;
      r.cash_collected += Number(it.cash_collected || 0);
      r.cash_contracted += Number(it.cash_contracted || 0);
    }
  }
  return [...map.values()].map(r => ({
    ...r,
    show_rate: r.completed > 0 ? r.shown / r.completed : null,
    close_rate: r.shown > 0 ? r.closed / r.shown : null,
    dq_rate: r.completed > 0 ? r.dq / r.completed : null,
  })).sort((a, b) => b.cash_collected - a.cash_collected);
}

/** @deprecated Prefer getBookedCallsKPIs().bySetter. */
export function groupBySetter(items) {
  const map = new Map();
  for (const it of items) {
    const rawList = (it.setter_assigned || '').split(',').map(s => s.trim()).filter(Boolean);
    const named = rawList
      .map(firstName)
      .filter(n => NAMED_SETTERS.has(n.toLowerCase()))
      .map(n => n.charAt(0).toUpperCase() + n.slice(1).toLowerCase());
    if (named.length === 0) continue;
    const weight = 1 / named.length;
    for (const name of named) {
      if (!map.has(name)) map.set(name, { setter: name, booked: 0, shown: 0, closed: 0, dms_sent: null });
      const r = map.get(name);
      r.booked += weight;
      if (it._isShown) r.shown += weight;
      if (it._isClosed) r.closed += weight;
    }
  }
  return [...map.values()].map(r => ({
    ...r, booked: round2(r.booked), shown: round2(r.shown), closed: round2(r.closed),
  })).sort((a, b) => b.booked - a.booked);
}

/** @deprecated Prefer getBookedCallsKPIs().bySource. */
export function groupBySource(items) {
  const map = new Map();
  for (const it of items) {
    const key = it.lead_source || '(unknown)';
    if (!map.has(key)) map.set(key, { source: key, booked: 0, shown: 0, closed: 0, cash_collected: 0 });
    const r = map.get(key);
    r.booked += 1;
    if (it._isShown) r.shown += 1;
    if (it._isClosed) { r.closed += 1; r.cash_collected += Number(it.cash_collected || 0); }
  }
  return [...map.values()].sort((a, b) => b.booked - a.booked);
}

/** @deprecated Prefer getBookedCallsKPIs().lostReasons. */
export function groupByLostReason(items) {
  const map = new Map();
  for (const it of items) {
    if (it.outcome !== OUTCOME.UNSUCCESSFUL) continue;
    const reason = (it.lost_reason || '').trim();
    if (!reason) continue;
    map.set(reason, (map.get(reason) || 0) + 1);
  }
  return [...map.entries()].map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/** @deprecated. Kept so the /booked-calls/summary sparkline still renders. */
export function dailySeries(items, start, end) {
  const days = {};
  for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    days[d.toISOString().slice(0, 10)] = { booked: 0, shown: 0, closed: 0 };
  }
  for (const it of items) {
    const iso = it.booked_date;
    if (!iso || !days[iso]) continue;
    days[iso].booked += 1;
    if (it._isShown) days[iso].shown += 1;
    if (it._isClosed) days[iso].closed += 1;
  }
  const dates = Object.keys(days).sort();
  return {
    dates,
    booked: dates.map(d => days[d].booked),
    shown: dates.map(d => days[d].shown),
    closed: dates.map(d => days[d].closed),
  };
}

/** @deprecated. Ads tab: return paid-attributed subset (spec-compliant). */
export function filterAdAttributed(items) {
  return items.filter(it => it._isPaid);
}

/** @deprecated. Per-day paid-attributed spend/cash for the Ads sparkline. */
export function dailyFromAds(items, start, end) {
  const days = {};
  for (let d = new Date(start + 'T00:00:00Z'); d <= new Date(end + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    days[d.toISOString().slice(0, 10)] = { booked: 0, collected: 0, contracted: 0 };
  }
  for (const it of items.filter(x => x._isPaid)) {
    const iso = it.booked_date;
    if (!iso || !days[iso]) continue;
    days[iso].booked += 1;
    days[iso].collected += Number(it.cash_collected || 0);
    days[iso].contracted += Number(it.cash_contracted || 0);
  }
  const dates = Object.keys(days).sort();
  return {
    dates,
    booked: dates.map(d => days[d].booked),
    collected: dates.map(d => days[d].collected),
    contracted: dates.map(d => days[d].contracted),
  };
}
