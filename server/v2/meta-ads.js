// Meta Ads sync — pulls per-day per-campaign insights and upserts into ad_metrics.
// Reads META_ADS_TOKEN + META_AD_ACCOUNT_ID from env.

import { fetchRetry } from './http.js';

const META_API = 'https://graph.facebook.com/v21.0';

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

/**
 * Fetch daily campaign-level insights for the last `days` days.
 * Returns raw rows: [{ date, campaign_id, campaign_name, spend, impressions, clicks, actions }]
 */
export async function fetchMetaDailyCampaigns(days = 30) {
  const token = requireEnv('META_ADS_TOKEN');
  const account = requireEnv('META_AD_ACCOUNT_ID');
  const until = new Date();
  const since = new Date();
  since.setDate(since.getDate() - (days - 1));
  const range = {
    since: since.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10),
  };

  const url = new URL(`${META_API}/${account}/insights`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('time_range', JSON.stringify(range));
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('level', 'campaign');
  url.searchParams.set(
    'fields',
    'campaign_id,campaign_name,spend,impressions,clicks,actions,date_start,date_stop',
  );
  url.searchParams.set('limit', '500');

  const all = [];
  let next = url.toString();
  while (next) {
    const res = await fetchRetry(next, { method: 'GET' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Meta insights ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    all.push(...(json.data || []));
    next = json.paging?.next || null;
  }
  return all;
}

/**
 * Convert Meta actions array to a { action_type: number } map, then extract known metrics.
 */
function actionsMap(row) {
  const map = {};
  for (const a of row.actions || []) {
    map[a.action_type] = Number(a.value || 0);
  }
  return map;
}

export function normalizeMetaRow(row) {
  const a = actionsMap(row);
  const messages = a['onsite_conversion.messaging_conversation_started_7d'] || a['onsite_conversion.messaging_first_reply'] || 0;
  return {
    date: row.date_start,
    campaign_id: row.campaign_id || null,
    campaign_name: row.campaign_name || null,
    spend: Number(row.spend || 0),
    impressions: Number(row.impressions || 0),
    clicks: Number(row.clicks || 0),
    messages: Math.round(messages),
    // booked/shown/closed/cash get filled in via Monday cross-join later
    booked_calls: 0,
    shown_calls: 0,
    closed: 0,
    cash_collected: 0,
    cash_contracted: 0,
    roas: null,
  };
}

/**
 * Upsert normalized rows into ad_metrics.
 * `supabase` is a live client.
 */
export async function upsertAdMetrics(supabase, rows) {
  if (!rows.length) return { rows: 0 };

  // Upsert by (date, campaign_id) — matches unique index.
  // We use manual upsert: delete then insert per (date, campaign_id) pair
  // because the unique index uses coalesce() and PostgREST can't infer it.
  let count = 0;
  for (const r of rows) {
    const q = supabase.from('ad_metrics')
      .delete()
      .eq('date', r.date);
    if (r.campaign_id) q.eq('campaign_id', r.campaign_id);
    else q.is('campaign_id', null);
    const { error: delErr } = await q;
    if (delErr) throw new Error(`ad_metrics delete failed: ${delErr.message}`);

    const { error: insErr } = await supabase.from('ad_metrics').insert(r);
    if (insErr) throw new Error(`ad_metrics insert failed: ${insErr.message}`);
    count += 1;
  }
  return { rows: count };
}

export async function syncMetaAds(supabase, days = 30) {
  const raw = await fetchMetaDailyCampaigns(days);
  const rows = raw.map(normalizeMetaRow);
  return upsertAdMetrics(supabase, rows);
}

/**
 * Live pull of Meta ad spend for a date window (inclusive). Bypasses Supabase.
 * Used by the dashboard for CPA/CPBC math when we need current spend regardless
 * of whether the last ad_metrics sync ran.
 *
 * @param {string} fromISO  YYYY-MM-DD (inclusive)
 * @param {string} toISO    YYYY-MM-DD (inclusive)
 * @returns {Promise<{ spend: number, byDay: Array<{ date: string, spend: number }> }>}
 */
export async function getMetaSpend(fromISO, toISO) {
  if (!fromISO || !toISO) throw new Error('getMetaSpend: from + to (YYYY-MM-DD) required');
  const token = requireEnv('META_ADS_TOKEN');
  const account = requireEnv('META_AD_ACCOUNT_ID');

  const url = new URL(`${META_API}/${account}/insights`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('time_range', JSON.stringify({ since: fromISO, until: toISO }));
  url.searchParams.set('time_increment', '1');
  url.searchParams.set('level', 'account');
  url.searchParams.set('fields', 'spend,date_start');
  url.searchParams.set('limit', '500');

  let spend = 0;
  const byDay = [];
  let next = url.toString();
  while (next) {
    const res = await fetchRetry(next, { method: 'GET' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Meta getMetaSpend ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    for (const row of json.data || []) {
      const daySpend = Number(row.spend || 0);
      spend += daySpend;
      byDay.push({ date: row.date_start, spend: daySpend });
    }
    next = json.paging?.next || null;
  }
  byDay.sort((a, b) => a.date.localeCompare(b.date));
  return { spend, byDay };
}
