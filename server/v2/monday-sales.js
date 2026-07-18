// Monday Booked Calls board reader — mirrors biweekly-report/run.py logic.
// Returns funnel + per-closer breakdown for any date window.

import { fetchRetry } from './http.js';

const MONDAY_API = 'https://api.monday.com/v2';

// Column IDs — locked from biweekly-report/run.py (2026-07-04).
const COL = {
  date_15: 'date4',
  date_45: 'date_mkxxtzhe',
  outcome: 'status',
  outcome_notes: 'text_mkq7r20t',
  contracted: 'numeric_mkpq8d77',
  collected: 'numeric_mkpq7kcy',
  program: 'dropdown_mkpq36f8',
  lost_reason: 'dropdown_mm2qma67',
  closer: 'person',                       // "45 Call" people col (single)
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

const NOT_SHOWN_OUTCOMES = new Set(['Needs Rebooking', 'No Show', 'Canceled', '']);

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

  // 15s: has 15-date in window AND no 45-date at all (biweekly rule)
  const window15 = items.filter(it => {
    const d15 = parseDate(pickCol(it, 'date_15'));
    return d15 && d15 >= startD && d15 <= endD && !parseDate(pickCol(it, 'date_45'));
  });

  const shown15 = window15.filter(it => !NOT_SHOWN_OUTCOMES.has(pickCol(it, 'outcome')));

  // 45s: has 45-date in window
  const booked45 = items.filter(it => {
    const d45 = parseDate(pickCol(it, 'date_45'));
    return d45 && d45 >= startD && d45 <= endD;
  });
  const shown45 = booked45.filter(it => !NOT_SHOWN_OUTCOMES.has(pickCol(it, 'outcome')));

  // Sales: contracted > 0 OR collected > 0 within window
  const sales = [];
  for (const it of items) {
    const contracted = Number(pickCol(it, 'contracted') || 0);
    const collected = Number(pickCol(it, 'collected') || 0);
    if (contracted <= 0 && collected <= 0) continue;
    const d15 = parseDate(pickCol(it, 'date_15'));
    const d45 = parseDate(pickCol(it, 'date_45'));
    const inWindow =
      (d15 && d15 >= startD && d15 <= endD) ||
      (d45 && d45 >= startD && d45 <= endD);
    if (!inWindow) continue;
    sales.push({
      name: it.name,
      outcome: pickCol(it, 'outcome'),
      group: it.group?.title || '',
      d15: pickCol(it, 'date_15') || null,
      d45: pickCol(it, 'date_45') || null,
      contracted,
      collected,
      program: pickCol(it, 'program'),
      notes: pickCol(it, 'outcome_notes'),
    });
  }
  sales.sort((a, b) => (b.d45 || b.d15 || '').localeCompare(a.d45 || a.d15 || ''));

  // Lost reasons within window
  const lostCounter = {};
  const lossOutcomes = new Set(['Unsuccessful', 'Needs Rebooking', 'No Show', 'DQ', 'Canceled', 'Nurture', 'Ghosted After Call']);
  for (const it of [...window15, ...booked45]) {
    const outcome = pickCol(it, 'outcome');
    if (!lossOutcomes.has(outcome)) continue;
    const reason = pickCol(it, 'lost_reason').trim() || '(not filled in)';
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
    booked: window15.length + booked45.length,
    booked_15: window15.length,
    booked_45: booked45.length,
    shown: shown15.length + shown45.length,
    shown_15: shown15.length,
    shown_45: shown45.length,
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
    const group = it.group?.title || '(no group)';
    const d15 = parseDate(pickCol(it, 'date_15'));
    const d45 = parseDate(pickCol(it, 'date_45'));
    const outcome = pickCol(it, 'outcome');
    const contracted = Number(pickCol(it, 'contracted') || 0);
    const collected = Number(pickCol(it, 'collected') || 0);

    const in15 = d15 && d15 >= startD && d15 <= endD && !d45;
    const in45 = d45 && d45 >= startD && d45 <= endD;

    if (in15 || in45) {
      bump(group, 'booked');
      if (!NOT_SHOWN_OUTCOMES.has(outcome)) bump(group, 'shown');
    }
    if ((in15 || in45) && (contracted > 0 || collected > 0)) {
      bump(group, 'closed');
      bump(group, 'cash_collected', collected);
      bump(group, 'cash_contracted', contracted);
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
    const d15s = pickCol(it, 'date_15');
    const d45s = pickCol(it, 'date_45');
    const outcome = pickCol(it, 'outcome');
    const contracted = Number(pickCol(it, 'contracted') || 0);
    const collected = Number(pickCol(it, 'collected') || 0);

    if (d15s && !d45s) {
      const i = idx(d15s);
      if (i >= 0) {
        booked[i] += 1;
        if (!NOT_SHOWN_OUTCOMES.has(outcome)) shown[i] += 1;
        if (contracted > 0 || collected > 0) {
          closed[i] += 1;
          cash[i] += collected;
        }
      }
    }
    if (d45s) {
      const i = idx(d45s);
      if (i >= 0) {
        booked[i] += 1;
        if (!NOT_SHOWN_OUTCOMES.has(outcome)) shown[i] += 1;
        if (contracted > 0 || collected > 0) {
          closed[i] += 1;
          cash[i] += collected;
        }
      }
    }
  }
  return { days, booked, shown, closed, cash };
}
