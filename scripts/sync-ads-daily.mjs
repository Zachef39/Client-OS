#!/usr/bin/env node
// Daily cron: pull the last 3 days of Meta ads insights and upsert into ad_metrics.
// Usage:
//   node scripts/sync-ads-daily.mjs         # default: last 3 days
//   node scripts/sync-ads-daily.mjs 7       # last 7 days
//
// Cron (once a day at 6am):
//   0 6 * * * cd /Users/zachef/Desktop/Playground\ -\ Claude/scripts/faerber-client-os && /usr/local/bin/node scripts/sync-ads-daily.mjs >> ~/Library/Logs/faerber-ads-sync.log 2>&1
//
// Env: reads META_ADS_TOKEN + META_AD_ACCOUNT_ID from
//      /Users/zachef/Desktop/Playground - Claude/.env
//      SUPABASE anon key from server/server.js constants.

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { syncMetaAds } from '../server/v2/meta-ads.js';

dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/faerber-checkin/.env' });
dotenv.config({ path: '/Users/zachef/Desktop/Playground - Claude/.env' });

const SUPABASE_URL = 'https://sfuvqaoeuajsrvldoiek.supabase.co';
const SUPABASE_KEY = 'sb_publishable_fRb1TIgDRxvkXFskGIMsnA_QikUcw9U';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const days = Math.max(1, Math.min(30, Number(process.argv[2]) || 3));

console.log(`[${new Date().toISOString()}] syncing last ${days} days of Meta ads...`);
try {
  const result = await syncMetaAds(supabase, days);
  console.log(`[${new Date().toISOString()}] ok — ${result.rows} rows upserted.`);
  process.exit(0);
} catch (e) {
  console.error(`[${new Date().toISOString()}] failed:`, e.message);
  process.exit(1);
}
