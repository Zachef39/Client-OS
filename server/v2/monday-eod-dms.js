// Monday EOD - DMs board reader (id 9743873934).
// Each item = 1 setter's daily EOD entry. Columns confirmed 2026-07-17:
//   person (people)         — DMer
//   date4 (date)             — the day being reported on
//   numeric_mkthvzkc (num)   — Calls Booked
//
// The board does NOT track DMs Sent per setter — only calls booked. If Zach
// ever adds a DMs Sent column, extend `MONDAY_COL` + `parseItem` below.

const MONDAY_API = 'https://api.monday.com/v2';
const BOARD_ID = '9743873934';

const MONDAY_COL = {
  dmer: 'person',
  date: 'date4',
  calls_booked: 'numeric_mkthvzkc',
};

// In-process cache: EOD data is slow to pull (Monday paginates) but rarely changes.
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache = { fetchedAt: 0, items: null };

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

function pickCol(item, colId) {
  for (const c of item.column_values || []) {
    if (c.id === colId) return c.text || '';
  }
  return '';
}

// ── Roster name mapping ─────────────────────────────────
// Monday people col returns full names ("Sheila Mae Ycong"). Our roster + UI
// use short names ("Sheila"). Normalize both directions.
const FULL_TO_SHORT = {
  'Sheila Mae Ycong': 'Sheila',
  'Spencer Stevens': 'Spencer',
  'Zach Faerber': 'Zach',
  'Dina Kay': 'Dina',
  'Valeria Morris': 'Valeria',
  'Sherise': 'Sherise',
  'Trina': 'Trina',
};

export function normalizeSetterName(rawFull) {
  if (!rawFull) return null;
  const trimmed = String(rawFull).trim();
  if (!trimmed) return null;
  if (FULL_TO_SHORT[trimmed]) return FULL_TO_SHORT[trimmed];
  // Fallback: use first word (first name).
  return trimmed.split(/\s+/)[0];
}

export function normalizeCloserName(rawFull) {
  return normalizeSetterName(rawFull);
}

// ── Fetcher ─────────────────────────────────────────────
async function fetchAllEodItems() {
  const now = Date.now();
  if (cache.items && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.items;
  }

  const colIds = Object.values(MONDAY_COL).map(c => `"${c}"`).join(',');
  const items = [];
  let cursor = null;
  for (let i = 0; i < 40; i += 1) {
    const cursorArg = cursor ? `, cursor: "${cursor}"` : '';
    const q = `
      {
        boards(ids: [${BOARD_ID}]) {
          items_page(limit: 500${cursorArg}) {
            cursor
            items {
              id
              column_values(ids: [${colIds}]) { id text }
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

  cache = { fetchedAt: now, items };
  return items;
}

function parseItem(item) {
  const rawDmer = pickCol(item, MONDAY_COL.dmer);
  const date = pickCol(item, MONDAY_COL.date) || null;
  const calls = Number(pickCol(item, MONDAY_COL.calls_booked) || 0);
  return {
    setter_name: normalizeSetterName(rawDmer),
    raw_setter_name: rawDmer,
    date,
    calls_booked: Number.isFinite(calls) ? calls : 0,
    // Board doesn't track DMs sent — leave null for future column additions.
    dms_sent: null,
  };
}

// ── Public API ─────────────────────────────────────────
/**
 * Fetch parsed EOD logs within the last `days` days.
 * Returns array of `{ setter_name, date, calls_booked, dms_sent }`.
 */
export async function fetchEodDmsLogs(days) {
  const items = await fetchAllEodItems();
  const endD = new Date();
  const startD = new Date();
  startD.setDate(startD.getDate() - (days - 1));
  const start = startD.toISOString().slice(0, 10);
  const end = endD.toISOString().slice(0, 10);

  const parsed = items
    .map(parseItem)
    .filter(row => row.date && row.date >= start && row.date <= end);

  return { window: { start, end, days }, rows: parsed };
}

/**
 * Per-setter rollup for the window.
 * Filters out (unassigned) — rows w/ no setter attributed.
 */
export async function getSetterEodRollup(days) {
  const { window, rows } = await fetchEodDmsLogs(days);
  const byName = new Map();
  for (const r of rows) {
    if (!r.setter_name) continue; // drop unassigned
    if (!byName.has(r.setter_name)) {
      byName.set(r.setter_name, {
        setter: r.setter_name,
        dms_sent: 0,
        calls_booked: 0,
        days_logged: 0,
        last_date: null,
      });
    }
    const b = byName.get(r.setter_name);
    b.calls_booked += r.calls_booked;
    if (r.dms_sent != null) b.dms_sent += r.dms_sent;
    b.days_logged += 1;
    if (!b.last_date || r.date > b.last_date) b.last_date = r.date;
  }
  return { window, rows: Array.from(byName.values()) };
}

/**
 * Per-setter daily rows (for sparklines).
 * Returns `{ window, setters: { [name]: [{date, calls_booked, dms_sent}] } }`.
 */
export async function getSetterDailyRows(days) {
  const { window, rows } = await fetchEodDmsLogs(days);
  const setters = {};
  for (const r of rows) {
    if (!r.setter_name) continue;
    if (!setters[r.setter_name]) setters[r.setter_name] = [];
    setters[r.setter_name].push({
      date: r.date,
      calls_booked: r.calls_booked,
      dms_sent: r.dms_sent,
    });
  }
  // Sort each setter's rows by date ASC
  for (const name of Object.keys(setters)) {
    setters[name].sort((a, b) => a.date.localeCompare(b.date));
  }
  return { window, setters };
}
