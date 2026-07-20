// Monday Booked Calls board reader — mirrors biweekly-report/run.py logic.
// Returns funnel + per-closer breakdown for any date window.

import { fetchRetry } from './http.js';

const MONDAY_API = 'https://api.monday.com/v2';

// Column IDs — post-2026-07-20 cleanup. Single date column, `person`=closer, `multiple_person_mkvsxzf9`=setter.
// All items on this board are Sales calls (formerly "45 calls"); the qualifying/15-call funnel lives on a separate board.
const COL = {
  date: 'date4',                          // sole Call Date column
  outcome: 'status',
  outcome_notes: 'text_mkq7r20t',
  contracted: 'numeric_mkpq8d77',
  collected: 'numeric_mkpq7kcy',
  program: 'dropdown_mkpq36f8',
  lost_reason: 'dropdown_mm2qma67',
  closer: 'person',                       // "Sales" people col (single)
  setter: 'multiple_person_mkvsxzf9',     // "DMer" people col (multi)
};

// Person col IDs — pickCol resolves `value` JSON → names via user cache.
const PERSON_COL_IDS = new Set(['person', 'multiple_person_mkvsxzf9']);

// In-process cache of Monday userID → name. Populated by resolveUsers().
const userNameCache = new Map();

// Accessor for other modules that share this cache (e.g. booked-calls.js).
export function __getCachedUserName(id) {
  return userNameCache.get(String(id)) || null;
}

/**
 * Resolve Monday user IDs to display names. Batches unknown IDs into a single
 * `users(ids: [...])` GraphQL query, caches results forever (process lifetime).
 */
export async function resolveUsers(userIds) {
  const unknown = [...new Set(userIds)].filter(id => id != null && !userNameCache.has(String(id)));
  if (unknown.length > 0) {
    const idList = unknown.map(id => Number(id)).filter(n => Number.isFinite(n)).join(',');
    if (idList) {
      const q = `{ users(ids: [${idList}]) { id name } }`;
      try {
        const data = await mondayQuery(q);
        for (const u of data.data?.users || []) {
          userNameCache.set(String(u.id), u.name || `user:${u.id}`);
        }
      } catch (e) {
        // Don't tank the whole request — fall back to placeholder for unresolved IDs.
        console.warn('[monday users] resolve failed:', e.message);
      }
      // Any IDs we didn't get back → cache as placeholder so we don't retry each request.
      for (const id of unknown) {
        if (!userNameCache.has(String(id))) userNameCache.set(String(id), `user:${id}`);
      }
    }
  }
  return userIds.map(id => userNameCache.get(String(id)) || `user:${id}`);
}

/**
 * Given raw items from Monday, pre-resolve every person-column user ID so
 * pickCol() can synchronously return names.
 */
export async function hydratePersonCols(items) {
  const ids = new Set();
  for (const it of items) {
    for (const c of it.column_values || []) {
      if (!PERSON_COL_IDS.has(c.id)) continue;
      const parsed = parsePersonValue(c.value);
      for (const uid of parsed) ids.add(uid);
    }
  }
  if (ids.size > 0) await resolveUsers([...ids]);
}

function parsePersonValue(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const arr = parsed?.personsAndTeams || [];
    return arr.filter(p => p && (p.kind === 'person' || !p.kind)).map(p => String(p.id));
  } catch {
    return [];
  }
}

// Spec: Shown = Sold + Unsuccessful + Bloodwork Only. Anything else = not shown.
const SHOWN_OUTCOMES = new Set(['Sold', 'Unsuccessful', 'Bloodwork Only']);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function mondayQuery(query) {
  const token = requireEnv('MONDAY_API_TOKEN');
  const res = await fetchRetry(MONDAY_API, {
    method: 'POST',
    headers: { 'Authorization': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Monday ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Monday errors: ${JSON.stringify(json.errors)}`);
  return json;
}

/**
 * Fetch every item on the Booked Calls board (paginated).
 * Returns raw items — call `pickCol()` to extract values.
 */
export async function fetchBookedCallsItems() {
  const boardId = process.env.MONDAY_BOARD_ID || '18372257888';
  const colIds = Object.values(COL).map(c => `"${c}"`).join(',');

  const items = [];
  let cursor = null;
  for (let i = 0; i < 30; i += 1) {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const q = `
      {
        boards(ids: [${boardId}]) {
          items_page(limit: 200${cursorArg}) {
            cursor
            items {
              id name
              group { title }
              column_values(ids: [${colIds}]) { id text value type }
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
  // Pre-resolve every person-column user ID → name so downstream pickCol is sync.
  await hydratePersonCols(items);
  return items;
}

function pickCol(item, key) {
  const cid = COL[key];
  for (const c of item.column_values || []) {
    if (c.id !== cid) continue;
    if (isPersonCol(c)) return resolvePersonNames(c).join(', ');
    return c.text || '';
  }
  return '';
}

function isPersonCol(col) {
  if (!col) return false;
  if (PERSON_COL_IDS.has(col.id)) return true;
  const t = (col.type || '').toLowerCase();
  return t === 'person' || t === 'people' || t.includes('person');
}

function resolvePersonNames(col) {
  const ids = parsePersonValue(col.value);
  const names = ids.map(id => userNameCache.get(String(id))).filter(Boolean);
  return names.length > 0 ? names : (col.text ? [col.text] : []);
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Compute funnel + sales summary within a start/end window (inclusive).
 */
export function computeSalesSummary(items, start, end) {
  const startD = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T23:59:59');

  // All items on this board = Sales calls. Filter by single Call Date column.
  const inWindow = items.filter(it => {
    const d = parseDate(pickCol(it, 'date'));
    return d && d >= startD && d <= endD;
  });

  const shown = inWindow.filter(it => SHOWN_OUTCOMES.has(pickCol(it, 'outcome')));

  // Closed = Sold/Bloodwork Only OR any cash on record (spec: "anything w/ money = close").
  const sales = [];
  for (const it of inWindow) {
    const outcome = pickCol(it, 'outcome');
    const contracted = Number(pickCol(it, 'contracted') || 0);
    const collected = Number(pickCol(it, 'collected') || 0);
    const closedByOutcome = outcome === 'Sold' || outcome === 'Bloodwork Only';
    const closedByCash = contracted > 0 || collected > 0;
    if (!closedByOutcome && !closedByCash) continue;
    sales.push({
      name: it.name,
      outcome,
      group: it.group?.title || '',
      date: pickCol(it, 'date') || null,
      contracted,
      collected,
      program: pickCol(it, 'program'),
      notes: pickCol(it, 'outcome_notes'),
    });
  }
  sales.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // Lost reasons — Unsuccessful only, drop blanks (per spec — no "(not filled in)").
  const lostCounter = {};
  for (const it of inWindow) {
    if (pickCol(it, 'outcome') !== 'Unsuccessful') continue;
    const reason = pickCol(it, 'lost_reason').trim();
    if (!reason) continue;
    lostCounter[reason] = (lostCounter[reason] || 0) + 1;
  }
  const lostReasons = Object.entries(lostCounter)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  const cashCollected = sales.reduce((sum, s) => sum + s.collected, 0);
  const cashContracted = sales.reduce((sum, s) => sum + s.contracted, 0);
  const acv = sales.length ? cashContracted / sales.length : 0;

  return {
    window: { start, end },
    booked: inWindow.length,
    booked_15: 0,                 // legacy field — 15-call funnel lives on a separate board now
    booked_45: inWindow.length,
    shown: shown.length,
    shown_15: 0,
    shown_45: shown.length,
    closed: sales.length,
    cash_collected: cashCollected,
    cash_contracted: cashContracted,
    acv,
    lost_reasons: lostReasons,
    recent_sales: sales,
  };
}

/**
 * Per-closer/group breakdown for the window.
 * We use `group.title` as proxy for "closer" until Monday exposes a Set By / Closed By column.
 */
export function computeByCloser(items, start, end) {
  const startD = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T23:59:59');

  const grouped = {};
  const bump = (key, field, val = 1) => {
    if (!grouped[key]) grouped[key] = { closer: key, booked: 0, shown: 0, closed: 0, cash_collected: 0, cash_contracted: 0 };
    grouped[key][field] += val;
  };

  for (const it of items) {
    const d = parseDate(pickCol(it, 'date'));
    if (!d || d < startD || d > endD) continue;

    // Prefer real closer from `person` column; fall back to Monday group only if no closer set.
    const closer = pickCol(it, 'closer').trim();
    const key = closer || (it.group?.title || '(no closer)');

    const outcome = pickCol(it, 'outcome');
    const contracted = Number(pickCol(it, 'contracted') || 0);
    const collected = Number(pickCol(it, 'collected') || 0);
    const closedByOutcome = outcome === 'Sold' || outcome === 'Bloodwork Only';
    const closedByCash = contracted > 0 || collected > 0;

    bump(key, 'booked');
    if (SHOWN_OUTCOMES.has(outcome)) bump(key, 'shown');
    if (closedByOutcome || closedByCash) {
      bump(key, 'closed');
      bump(key, 'cash_collected', collected);
      bump(key, 'cash_contracted', contracted);
    }
  }

  return Object.values(grouped)
    .filter(g => g.booked > 0 || g.closed > 0)
    .sort((a, b) => b.cash_collected - a.cash_collected);
}

/**
 * Daily sparklines: per-day counts of booked, shown, closed, cash for the window.
 */
export function computeDailySparks(items, start, end) {
  const startD = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  const dayCount = Math.floor((endD - startD) / (24 * 3600 * 1000)) + 1;

  const days = [];
  for (let i = 0; i < dayCount; i += 1) {
    const d = new Date(startD);
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  const idx = (dateStr) => days.indexOf(dateStr);

  const booked = Array(dayCount).fill(0);
  const shown = Array(dayCount).fill(0);
  const closed = Array(dayCount).fill(0);
  const cash = Array(dayCount).fill(0);

  for (const it of items) {
    const ds = pickCol(it, 'date');
    if (!ds) continue;
    const i = idx(ds);
    if (i < 0) continue;

    const outcome = pickCol(it, 'outcome');
    const contracted = Number(pickCol(it, 'contracted') || 0);
    const collected = Number(pickCol(it, 'collected') || 0);
    const closedByOutcome = outcome === 'Sold' || outcome === 'Bloodwork Only';
    const closedByCash = contracted > 0 || collected > 0;

    booked[i] += 1;
    if (SHOWN_OUTCOMES.has(outcome)) shown[i] += 1;
    if (closedByOutcome || closedByCash) {
      closed[i] += 1;
      cash[i] += collected;
    }
  }
  return { days, booked, shown, closed, cash };
}
