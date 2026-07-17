// Unified Booked Calls fetcher — Monday + GoHighLevel.
// Merges the two sources, dedupes on (name + phone/email + date window),
// and classifies each row as booked/shown/closed per Zach's rules.
//
// Zach's rules:
//   Booked = every row from Monday Booked Calls board + GHL sales calendar events
//            (deduped when the same lead appears in both within 24h).
//   Shown  = outcome NOT IN ('No Show', 'Needs Rebooking', empty/blank).
//            DQ / Unsuccessful still count as shown.
//   Closed = outcome IN ('Sold', 'Bloodwork Only', 'Bloodwork Sold').
//            Nothing else counts as closed.

import { fetchBookedCallsItems, resolveUsers, __getCachedUserName } from './monday-sales.js';

const GHL_API = 'https://services.leadconnectorhq.com';
const GHL_VERSION_CALENDARS = '2021-04-15';
const GHL_VERSION_CONTACTS = '2021-07-28';

// ── Rules ─────────────────────────────────────────────────
const NOT_SHOWN_OUTCOMES = new Set(['No Show', 'Needs Rebooking', '']);
const CLOSED_OUTCOMES = new Set(['Sold', 'Bloodwork Only', 'Bloodwork Sold']);

// Monday column IDs (verified against board 18372257888 on 2026-07-17).
const MONDAY_COL = {
  date_15: 'date4',
  date_45: 'date_mkxxtzhe',
  outcome: 'status',
  closer: 'person',                       // "45 Call" people col (single)
  setter: 'multiple_person_mkvsxzf9',     // "DMer" people col
  contracted: 'numeric_mkpq8d77',
  collected: 'numeric_mkpq7kcy',
  phone: 'phone_mkrv3wst',
  keyword: 'dropdown_mkpq2nxj',           // rough lead-source proxy
  lost_reason: 'dropdown_mm2qma67',
  program: 'dropdown_mkpq36f8',
};

// ── Env / helpers ────────────────────────────────────────
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const PERSON_COL_IDS = new Set(['person', 'multiple_person_mkvsxzf9']);

function pickCol(item, colId) {
  for (const c of item.column_values || []) {
    if (c.id !== colId) continue;
    if (isPersonCol(c)) return resolvePersonNamesFromCol(c).join(', ');
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

// Access the resolved user names via the same cache the monday-sales module populates.
// fetchBookedCallsItems() hydrates the cache before returning, so this is sync.
function resolvePersonNamesFromCol(col) {
  const raw = col.value;
  if (!raw) return [];
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return col.text ? [col.text] : [];
  }
  const arr = parsed?.personsAndTeams || [];
  const ids = arr.filter(p => p && (p.kind === 'person' || !p.kind)).map(p => String(p.id));
  const names = ids.map(id => __getCachedUserName(id)).filter(Boolean);
  return names.length > 0 ? names : (col.text ? [col.text] : []);
}

function normalizePhone(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').slice(-10); // last 10 digits
}

function normalizeName(raw) {
  if (!raw) return '';
  return String(raw).toLowerCase().replace(/\s+/g, ' ').trim();
}

function toIsoDate(v) {
  if (!v) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// ── GHL client ───────────────────────────────────────────
async function ghlFetch(path, version = GHL_VERSION_CALENDARS) {
  const token = requireEnv('GHL_API_KEY');
  const res = await fetch(`${GHL_API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Version: version },
  });
  if (!res.ok) throw new Error(`GHL ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function fetchGhlEventsForCalendar(calendarId, startMs, endMs) {
  const locationId = requireEnv('GHL_LOCATION_ID');
  const path = `/calendars/events?locationId=${locationId}&calendarId=${calendarId}&startTime=${startMs}&endTime=${endMs}`;
  const data = await ghlFetch(path, GHL_VERSION_CALENDARS);
  return data.events || [];
}

// Contact cache — avoid hammering /contacts/:id for the same contact twice.
const contactCache = new Map();
async function fetchGhlContact(contactId) {
  if (!contactId) return null;
  if (contactCache.has(contactId)) return contactCache.get(contactId);
  try {
    const data = await ghlFetch(`/contacts/${contactId}`, GHL_VERSION_CONTACTS);
    const c = data?.contact || null;
    contactCache.set(contactId, c);
    return c;
  } catch (e) {
    // If a single contact 404s / perms-fail, don't tank the whole run.
    contactCache.set(contactId, null);
    return null;
  }
}

// ── Data shape ───────────────────────────────────────────
// Every unified item exposes this shape:
// {
//   source: 'monday' | 'ghl' | 'both',
//   name, phone, email,
//   booked_date,          // ISO date the call was booked FOR
//   outcome,              // Monday status text; '' if GHL-only
//   closer_assigned,      // Monday `person` text
//   setter_assigned,      // Monday `multiple_person_mkvsxzf9` text
//   cash_collected,       // Monday
//   cash_contracted,      // Monday
//   lead_source,          // Monday keyword OR GHL calendar name
//   monday_item_id,       // string | null
//   ghl_appointment_id,   // string | null
// }

function mondayItemToUnified(item) {
  const date45 = pickCol(item, MONDAY_COL.date_45);
  const date15 = pickCol(item, MONDAY_COL.date_15);
  const booked_date = date45 || date15 || null;
  const outcome = pickCol(item, MONDAY_COL.outcome) || '';
  const phone = normalizePhone(pickCol(item, MONDAY_COL.phone));
  return {
    source: 'monday',
    name: item.name || '',
    phone,
    email: '',
    booked_date,
    outcome,
    closer_assigned: pickCol(item, MONDAY_COL.closer) || '',
    setter_assigned: pickCol(item, MONDAY_COL.setter) || '',
    cash_collected: Number(pickCol(item, MONDAY_COL.collected) || 0),
    cash_contracted: Number(pickCol(item, MONDAY_COL.contracted) || 0),
    lead_source: pickCol(item, MONDAY_COL.keyword) || '',
    program: pickCol(item, MONDAY_COL.program) || '',
    lost_reason: pickCol(item, MONDAY_COL.lost_reason) || '',
    monday_item_id: item.id,
    ghl_appointment_id: null,
    _group: item.group?.title || '',
    _has_45: !!date45,
    _has_15: !!date15,
  };
}

async function ghlEventToUnified(ev, calendarName) {
  const contact = await fetchGhlContact(ev.contactId);
  const first = contact?.firstName || '';
  const last = contact?.lastName || '';
  const combined = [first, last].filter(Boolean).join(' ') || contact?.name || '';
  return {
    source: 'ghl',
    name: combined,
    phone: normalizePhone(contact?.phone),
    email: (contact?.email || '').toLowerCase(),
    booked_date: toIsoDate(ev.startTime),
    outcome: '', // GHL has appointmentStatus but not our outcome vocabulary
    closer_assigned: '',
    setter_assigned: '',
    cash_collected: 0,
    cash_contracted: 0,
    lead_source: calendarName || 'GHL',
    program: '',
    lost_reason: '',
    monday_item_id: null,
    ghl_appointment_id: ev.id,
    _ghl_status: ev.appointmentStatus || '',
    _ghl_calendar_id: ev.calendarId,
  };
}

// ── Classify per Zach's rules ────────────────────────────
export function classify(item) {
  const outcome = (item.outcome || '').trim();
  // Booked: everything present is booked; the caller filters by date window before counting.
  const is_booked = true;

  // Shown: outcome NOT in {No Show, Needs Rebooking, blank}.
  // Special case: GHL-only rows have no outcome — treat as booked-but-status-unknown → NOT shown.
  let is_shown;
  if (item.source === 'ghl' && !outcome) {
    // fall back to GHL's own appointmentStatus if present
    const st = (item._ghl_status || '').toLowerCase();
    is_shown = st === 'showed' || st === 'confirmed';
  } else {
    is_shown = !NOT_SHOWN_OUTCOMES.has(outcome);
  }

  const is_closed = CLOSED_OUTCOMES.has(outcome);
  return { is_booked, is_shown, is_closed };
}

// ── Dedupe ───────────────────────────────────────────────
// Match if (normalized name matches AND either normalized phone matches OR booked_date is within 1 day).
// If matched: keep Monday side (has outcome + cash) but keep GHL id + calendar for reference.
function dedupe(unified) {
  const monday = unified.filter(u => u.source === 'monday');
  const ghl = unified.filter(u => u.source === 'ghl');

  const out = [];
  const mondayByKey = new Map();
  for (const m of monday) {
    const key = normalizeName(m.name);
    if (!key) { out.push(m); continue; }
    if (!mondayByKey.has(key)) mondayByKey.set(key, []);
    mondayByKey.get(key).push(m);
    out.push(m);
  }

  let matched = 0;
  let ghlOnly = 0;
  for (const g of ghl) {
    const gName = normalizeName(g.name);
    const candidates = gName ? (mondayByKey.get(gName) || []) : [];
    let match = null;
    for (const m of candidates) {
      const phoneMatch = m.phone && g.phone && m.phone === g.phone;
      const dateClose = m.booked_date && g.booked_date &&
        Math.abs(new Date(m.booked_date) - new Date(g.booked_date)) <= 24 * 3600 * 1000;
      if (phoneMatch || dateClose) { match = m; break; }
    }
    if (match) {
      match.source = 'both';
      match.ghl_appointment_id = g.ghl_appointment_id;
      // Fill in email if Monday had none
      if (!match.email && g.email) match.email = g.email;
      matched += 1;
    } else {
      out.push(g);
      ghlOnly += 1;
    }
  }

  const mondayOnly = monday.length - matched;
  return { unified: out, stats: { monday_total: monday.length, ghl_total: ghl.length, matched, monday_only: mondayOnly, ghl_only: ghlOnly } };
}

// ── Main entry ───────────────────────────────────────────
export async function fetchBookedCallsUnified(days) {
  const endD = new Date();
  const startD = new Date();
  startD.setDate(startD.getDate() - (days - 1));
  const start = startD.toISOString().slice(0, 10);
  const end = endD.toISOString().slice(0, 10);

  // Monday: fetch all items (paginated), then filter by booked_date in window later.
  const mondayItems = await fetchBookedCallsItems();
  const mondayUnified = mondayItems.map(mondayItemToUnified);

  // GHL: fetch events per configured sales calendar over the window (widen 7d each side
  // so booking-lead-time captures near-window overlaps).
  const salesCalIds = (process.env.GHL_SALES_CALENDAR_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const discoveryCalIds = (process.env.GHL_DISCOVERY_CALENDAR_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  const allCalIds = [...new Set([...salesCalIds, ...discoveryCalIds])];

  const startMs = new Date(start + 'T00:00:00Z').getTime() - 7 * 24 * 3600 * 1000;
  const endMs = new Date(end + 'T23:59:59Z').getTime() + 7 * 24 * 3600 * 1000;

  const calNameById = new Map();
  // Cheap name lookup — GHL_SALES / DISCOVERY are just IDs; use fixed name if unknown.
  // Discovery = "15", Sales = "45"
  for (const id of salesCalIds) calNameById.set(id, `GHL Sales (${id.slice(-4)})`);
  for (const id of discoveryCalIds) calNameById.set(id, `GHL Discovery (${id.slice(-4)})`);

  let ghlUnified = [];
  for (const calId of allCalIds) {
    try {
      const events = await fetchGhlEventsForCalendar(calId, startMs, endMs);
      // Only keep events whose startTime falls inside our real window
      const inWindow = events.filter(ev => {
        const iso = toIsoDate(ev.startTime);
        return iso && iso >= start && iso <= end;
      });
      const calName = calNameById.get(calId) || 'GHL';
      // Enrich with contact info (parallel by calendar, sequential within to be gentle)
      for (const ev of inWindow) {
        ghlUnified.push(await ghlEventToUnified(ev, calName));
      }
    } catch (e) {
      console.warn(`[booked-calls] GHL fetch failed for ${calId}:`, e.message);
    }
  }

  // Filter monday side by booked_date in window
  const mondayInWindow = mondayUnified.filter(u => u.booked_date && u.booked_date >= start && u.booked_date <= end);

  const { unified, stats } = dedupe([...mondayInWindow, ...ghlUnified]);

  return { window: { start, end, days }, items: unified, dedup_stats: stats };
}

// ── Aggregations ─────────────────────────────────────────
export function summarize(items) {
  let booked = 0, shown = 0, closed = 0;
  let cash_collected = 0, cash_contracted = 0;
  const bySource = { monday: 0, ghl: 0, both: 0 };

  for (const item of items) {
    const c = classify(item);
    if (c.is_booked) booked += 1;
    if (c.is_shown) shown += 1;
    if (c.is_closed) closed += 1;
    cash_collected += Number(item.cash_collected || 0);
    cash_contracted += Number(item.cash_contracted || 0);
    bySource[item.source] = (bySource[item.source] || 0) + 1;
  }
  return {
    booked, shown, closed,
    cash_collected, cash_contracted,
    close_rate: shown > 0 ? closed / shown : null,
    show_rate: booked > 0 ? shown / booked : null,
    by_source: bySource,
  };
}

function bumpAgg(map, key) {
  if (!map[key]) map[key] = { key, booked: 0, shown: 0, closed: 0, cash_collected: 0, cash_contracted: 0 };
  return map[key];
}

export function groupByCloser(items) {
  const map = {};
  for (const item of items) {
    const key = item.closer_assigned || '(unassigned)';
    const row = bumpAgg(map, key);
    const c = classify(item);
    if (c.is_booked) row.booked += 1;
    if (c.is_shown) row.shown += 1;
    if (c.is_closed) row.closed += 1;
    row.cash_collected += Number(item.cash_collected || 0);
    row.cash_contracted += Number(item.cash_contracted || 0);
  }
  return Object.values(map).map(r => ({
    closer: r.key,
    booked: r.booked, shown: r.shown, closed: r.closed,
    cash_collected: r.cash_collected, cash_contracted: r.cash_contracted,
    close_rate: r.shown > 0 ? r.closed / r.shown : null,
  })).sort((a, b) => b.cash_collected - a.cash_collected);
}

export function groupBySetter(items) {
  const map = {};
  for (const item of items) {
    const raw = item.setter_assigned || '(unassigned)';
    // Monday multi-person can be comma-separated ("Spencer Stevens, Dina Kay")
    const names = raw === '(unassigned)' ? ['(unassigned)'] : raw.split(',').map(s => s.trim()).filter(Boolean);
    for (const name of names) {
      const row = bumpAgg(map, name);
      const c = classify(item);
      if (c.is_booked) row.booked += 1;
      if (c.is_closed) row.closed += 1;
    }
  }
  return Object.values(map).map(r => ({
    setter: r.key,
    booked: r.booked,
    closed: r.closed,
    dms_sent: null, // placeholder — VA DM volume comes from team-kpi
  })).sort((a, b) => b.booked - a.booked);
}

export function groupBySource(items) {
  const map = {};
  for (const item of items) {
    const key = item.lead_source || '(unknown)';
    const row = bumpAgg(map, key);
    const c = classify(item);
    if (c.is_booked) row.booked += 1;
    if (c.is_shown) row.shown += 1;
    if (c.is_closed) row.closed += 1;
    row.cash_collected += Number(item.cash_collected || 0);
  }
  return Object.values(map).map(r => ({
    source: r.key,
    booked: r.booked, shown: r.shown, closed: r.closed,
    cash_collected: r.cash_collected,
  })).sort((a, b) => b.booked - a.booked);
}

/**
 * Aggregate lost reasons over items whose outcome represents a *loss*.
 * Skips blank / "(not filled in)" — Zach filled the column via the backfill script,
 * so anything still blank is not real signal.
 */
const LOSS_OUTCOMES = new Set([
  'No Show', 'Not Interested', 'DQ', 'Ghosted', 'Ghosted After Call',
  'Nurture', 'Canceled', 'Unsuccessful', 'Needs Rebooking',
]);

export function groupByLostReason(items) {
  const map = {};
  for (const item of items) {
    const outcome = (item.outcome || '').trim();
    if (!LOSS_OUTCOMES.has(outcome)) continue;
    const reason = (item.lost_reason || '').trim();
    if (!reason) continue; // suppress blanks — see comment above
    map[reason] = (map[reason] || 0) + 1;
  }
  return Object.entries(map)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Daily counts over the window — used for the booked sparkline on the overview.
 * Returns { dates: [...isoDate], booked: [n], shown: [n], closed: [n] }.
 */
export function dailySeries(items, start, end) {
  const days = {};
  const startD = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T00:00:00Z');
  for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    days[iso] = { booked: 0, shown: 0, closed: 0 };
  }
  for (const item of items) {
    const iso = item.booked_date;
    if (!iso || !days[iso]) continue;
    const c = classify(item);
    if (c.is_booked) days[iso].booked += 1;
    if (c.is_shown) days[iso].shown += 1;
    if (c.is_closed) days[iso].closed += 1;
  }
  const dates = Object.keys(days).sort();
  return {
    dates,
    booked: dates.map(d => days[d].booked),
    shown: dates.map(d => days[d].shown),
    closed: dates.map(d => days[d].closed),
  };
}

// ── Ad-attribution filter ────────────────────────────────
// Reality check (2026-07-17): the Monday `keyword` column (dropdown_mkpq2nxj) is
// empty across all 654 items on the Booked Calls board. There is no populated
// lead_source signal on any row.
// Per Zach's biweekly-report skill: "No organic/paid split — marketing spend
// is marketing spend." Ads are the primary funnel, so default = ad-attributed.
// EXCLUDE anything explicitly flagged organic/referral/manual/word-of-mouth.
const ORGANIC_MARKERS = ['organic', 'referral', 'manual', 'word of mouth'];

function isAdAttributed(item) {
  const src = (item.lead_source || '').toLowerCase();
  if (!src) return item.source !== 'ghl'; // GHL-only rows always have a cal name; empty src = Monday
  return !ORGANIC_MARKERS.some(m => src.includes(m));
}

export function filterAdAttributed(items) {
  return items.filter(isAdAttributed);
}

// Per-day series of ad-attributed booked / cash — sparklines for the Ads tab.
export function dailyFromAds(items, start, end) {
  const startD = new Date(start + 'T00:00:00Z');
  const endD = new Date(end + 'T00:00:00Z');
  const days = {};
  for (let d = new Date(startD); d <= endD; d.setUTCDate(d.getUTCDate() + 1)) {
    days[d.toISOString().slice(0, 10)] = { booked: 0, collected: 0, contracted: 0 };
  }
  const ad = filterAdAttributed(items);
  for (const item of ad) {
    const iso = item.booked_date;
    if (!iso || !days[iso]) continue;
    days[iso].booked += 1;
    days[iso].collected += Number(item.cash_collected || 0);
    days[iso].contracted += Number(item.cash_contracted || 0);
  }
  const dates = Object.keys(days).sort();
  return {
    dates,
    booked: dates.map(d => days[d].booked),
    collected: dates.map(d => days[d].collected),
    contracted: dates.map(d => days[d].contracted),
  };
}
