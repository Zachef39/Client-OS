#!/usr/bin/env node
// Alerts monitor — scans Supabase views/tables + local filesystem for alert
// conditions and posts one message per fired alert to Slack.
//
// Alerts:
//   1. critical_resigns — client_countdown tier=critical AND days_until_resign <= 7
//      (one daily summary message keyed to "YYYY-MM-DD")
//   2. coach_overloaded — coach_capacity pct_full >= 100 (one message per coach per day)
//   3. missed_eod — team_eod: any active setter/closer w/ no EOD entry today
//      (7 PM ET window — one summary per day, keyed to "YYYY-MM-DD-eod")
//   4. bloodwork_pdf_new — new *_Bloodwork_Report.pdf in ~/Downloads (<24h old)
//      (one message per file basename)
//
// Dedup: writes rows to public.alerts_sent (alert_type, alert_key). A unique
// index on (alert_type, alert_key, sent_day) blocks duplicate inserts for the
// same day — we treat that specific violation as "already sent" and skip.
//
// Flags:
//   --dry-run   Print what would fire; do not touch Slack or alerts_sent.
//
// Cron (every 4 hours):
//   0 */4 * * * cd .../faerber-client-os && node scripts/alerts-monitor.mjs
//
// Env:
//   SLACK_WEBHOOK — Incoming webhook URL (from /Users/zachef/Desktop/Playground - Claude/.env)
//   MONDAY/META — inherited, not used here.

import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createClient } from '@supabase/supabase-js';

dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/.env' });
dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/.env' });

const SUPABASE_URL = 'https://sfuvqaoeuajsrvldoiek.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK;
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const DRY_RUN = process.argv.includes('--dry-run');

// EOD alert only fires when local hour >= EOD_ALERT_HOUR — otherwise it's too
// early to expect team members to have logged. Cron runs every 4h so we'll hit
// the window (7pm-11pm local) once.
const EOD_ALERT_HOUR = 19;

if (!SLACK_WEBHOOK) {
  console.error('[alerts-monitor] SLACK_WEBHOOK missing from env — cannot post. HALT.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── helpers ────────────────────────────────────────────────────────────────

function todayKey() {
  // YYYY-MM-DD in local tz — matches Zach's mental model for "today".
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localHour() {
  return new Date().getHours();
}

async function postSlack(text) {
  if (DRY_RUN) {
    console.log(`[dry-run] WOULD POST → ${text}`);
    return { ok: true, dryRun: true };
  }
  const res = await fetch(SLACK_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (!res.ok || body !== 'ok') {
    throw new Error(`Slack post failed: ${res.status} ${body}`);
  }
  return { ok: true };
}

// Returns true if we already sent this (alert_type, alert_key) today.
async function alreadySent(alertType, alertKey) {
  const { data, error } = await supabase
    .from('alerts_sent')
    .select('id, sent_at')
    .eq('alert_type', alertType)
    .eq('alert_key', alertKey)
    .gte('sent_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .limit(1);
  if (error) {
    // Fail closed → treat lookup failure as "not sent" so we still try; the
    // unique index will still block same-day dupes at insert time.
    console.error(`[alerts-monitor] alerts_sent lookup failed: ${error.message}`);
    return false;
  }
  return (data || []).length > 0;
}

async function markSent(alertType, alertKey) {
  if (DRY_RUN) return;
  const { error } = await supabase
    .from('alerts_sent')
    .insert({ alert_type: alertType, alert_key: alertKey });
  if (error) {
    // 23505 = unique_violation → someone raced us or same-day dupe. Ignore.
    if (error.code === '23505' || /duplicate key/i.test(error.message || '')) return;
    throw error;
  }
}

// Send-if-not-already-sent. Returns 'sent' | 'skipped'.
async function sendOnce(alertType, alertKey, text) {
  if (await alreadySent(alertType, alertKey)) {
    console.log(`[skip] ${alertType}/${alertKey} already sent today`);
    return 'skipped';
  }
  await postSlack(text);
  await markSent(alertType, alertKey);
  console.log(`[sent] ${alertType}/${alertKey}`);
  return 'sent';
}

// ─── alert 1: critical resigns ─────────────────────────────────────────────

async function checkCriticalResigns() {
  const { data, error } = await supabase
    .from('client_countdown')
    .select('id, full_name, days_until_resign, tier, coach_name, programmed_to')
    .eq('tier', 'critical')
    .lte('days_until_resign', 7)
    .not('days_until_resign', 'is', null)
    .order('days_until_resign', { ascending: true });
  if (error) throw error;
  const rows = data || [];
  if (rows.length === 0) {
    console.log('[critical_resigns] none');
    return { fired: false, count: 0 };
  }
  const preview = rows.slice(0, 10).map(r => {
    const d = Number(r.days_until_resign);
    const label = d < 0 ? `${Math.abs(d)}d overdue` : `${d}d`;
    return `${r.full_name} (${label})`;
  });
  const more = rows.length > 10 ? `, +${rows.length - 10} more` : '';
  const text = `:rotating_light: ${rows.length} client${rows.length === 1 ? '' : 's'} in critical resign zone (<=7d): ${preview.join(', ')}${more}`;
  const key = `critical-resigns-${todayKey()}`;
  const result = await sendOnce('critical_resigns', key, text);
  return { fired: result === 'sent', count: rows.length, text };
}

// ─── alert 2: coach at 100%+ capacity ──────────────────────────────────────

async function checkCoachOverloaded() {
  const { data, error } = await supabase
    .from('coach_capacity')
    .select('coach_name, active_clients, max_capacity, pct_full')
    .neq('coach_name', '(unassigned)');
  if (error) throw error;
  const overloaded = (data || []).filter(c => Number(c.pct_full || 0) >= 100);
  if (overloaded.length === 0) {
    console.log('[coach_overloaded] none');
    return { fired: 0, checked: (data || []).length };
  }
  let fired = 0;
  const results = [];
  for (const c of overloaded) {
    const text = `:warning: ${c.coach_name} is at ${c.pct_full}% capacity (${c.active_clients}/${c.max_capacity}). Hire signal.`;
    const key = `coach-overloaded-${c.coach_name}-${todayKey()}`;
    const result = await sendOnce('coach_overloaded', key, text);
    if (result === 'sent') fired += 1;
    results.push({ coach: c.coach_name, pct: c.pct_full, text, result });
  }
  return { fired, checked: (data || []).length, details: results };
}

// ─── alert 3: missed VA EOD > 24h (only after 7pm local) ───────────────────

async function checkMissedEod() {
  const hour = localHour();
  if (hour < EOD_ALERT_HOUR) {
    console.log(`[missed_eod] skip — local hour ${hour} < ${EOD_ALERT_HOUR} (too early)`);
    return { fired: false, reason: 'too_early', hour };
  }
  // Roster: all active setters/closers.
  const { data: roster, error: rosterErr } = await supabase
    .from('team_roster')
    .select('name, role, is_active')
    .in('role', ['setter', 'closer']);
  if (rosterErr) throw rosterErr;
  const active = (roster || []).filter(r => r.is_active !== false);
  if (active.length === 0) {
    console.log('[missed_eod] no active setters/closers in roster');
    return { fired: false, reason: 'empty_roster' };
  }
  // Who logged today?
  const today = todayKey();
  const { data: todays, error: eodErr } = await supabase
    .from('team_eod')
    .select('va_name, date')
    .eq('date', today);
  if (eodErr) throw eodErr;
  const loggedNames = new Set((todays || []).map(r => r.va_name));
  const missed = active.filter(r => !loggedNames.has(r.name));
  if (missed.length === 0) {
    console.log('[missed_eod] all setters/closers logged today');
    return { fired: false, missed: [] };
  }
  const names = missed.map(r => r.name).sort();
  const text = `:bar_chart: Missed EOD today: ${names.join(', ')}`;
  const key = `missed-eod-${today}`;
  const result = await sendOnce('missed_eod', key, text);
  return { fired: result === 'sent', missed: names, text };
}

// ─── alert 4: new bloodwork PDFs ───────────────────────────────────────────

async function checkNewBloodworkPdfs() {
  let entries;
  try {
    entries = await fs.readdir(DOWNLOADS_DIR);
  } catch (e) {
    console.error(`[bloodwork] cannot read ${DOWNLOADS_DIR}: ${e.message}`);
    return { fired: 0, error: e.message };
  }
  const matches = entries.filter(n => /Bloodwork_Report\.pdf$/i.test(n));
  if (matches.length === 0) {
    console.log('[bloodwork] no *_Bloodwork_Report.pdf files in Downloads');
    return { fired: 0, checked: 0 };
  }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const fresh = [];
  for (const name of matches) {
    const full = path.join(DOWNLOADS_DIR, name);
    try {
      const st = await fs.stat(full);
      // Use birthtime when available (macOS), fall back to mtime.
      const created = (st.birthtimeMs || st.mtimeMs || 0);
      if (created >= cutoff) fresh.push({ name, full, created });
    } catch (_) { /* skip */ }
  }
  if (fresh.length === 0) {
    console.log(`[bloodwork] ${matches.length} PDF(s) exist but none created in last 24h`);
    return { fired: 0, checked: matches.length };
  }
  let fired = 0;
  const details = [];
  for (const f of fresh) {
    // Extract client name from file prefix (e.g. Kennedy_Powell_Bloodwork_Report.pdf → "Kennedy Powell")
    const prefix = f.name.replace(/_Bloodwork_Report\.pdf$/i, '').replace(/_/g, ' ');
    const ageHrs = Math.max(0, Math.round((Date.now() - f.created) / (60 * 60 * 1000)));
    const text = `:test_tube: New bloodwork PDF: ${prefix} (created ${ageHrs}h ago) — ${f.full}`;
    // Dedup by filename basename (not by day) — same PDF should only alert once ever.
    const key = f.name;
    const result = await sendOnce('bloodwork_pdf_new', key, text);
    if (result === 'sent') fired += 1;
    details.push({ file: f.name, ageHrs, result });
  }
  return { fired, checked: matches.length, fresh: fresh.length, details };
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[alerts-monitor] start ${new Date().toISOString()} · dry-run=${DRY_RUN}`);
  const summary = {};
  const errors = [];

  for (const [name, fn] of [
    ['critical_resigns', checkCriticalResigns],
    ['coach_overloaded', checkCoachOverloaded],
    ['missed_eod', checkMissedEod],
    ['bloodwork_pdf_new', checkNewBloodworkPdfs],
  ]) {
    try {
      summary[name] = await fn();
    } catch (e) {
      console.error(`[${name}] failed: ${e.message}`);
      errors.push({ alert: name, message: e.message });
      summary[name] = { error: e.message };
    }
  }

  console.log(`[alerts-monitor] done ${new Date().toISOString()}`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`[alerts-monitor] fatal: ${e.message}`);
  process.exit(1);
});
