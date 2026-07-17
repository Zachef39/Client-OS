// Cloud cron jobs — replaces the local macOS launchd jobs so syncs keep
// running even when Zach's Mac sleeps. Runs in-process alongside the Express
// server. Auto-restarts with the server (Railway restartPolicy=always).
//
// Skipped when LOCAL_ONLY=true so the Mac wrapper doesn't double-fire.
//
// All 4 scripts are cloud-safe (direct API calls to Meta / Monday / Supabase /
// Slack — no MCP dependencies). One caveat: alerts-monitor's bloodwork_pdf_new
// check reads ~/Downloads and will no-op cleanly in the cloud container.
//
// Schedule (all UTC — Railway uses UTC):
//   05:00  sync-ads-daily     (Meta ads → ad_metrics)
//   05:15  sync-programmed-to (Monday Coach Board → clients.programmed_to)
//   05:30  sync-assigned-coach (Monday Clients Board → clients.assigned_coach)
//   */4h   alerts-monitor     (Slack alerts)

import cron from 'node-cron';
import { spawn } from 'child_process';
import path from 'path';

const SCRIPTS_DIR = path.join(process.cwd(), 'scripts');
const NODE = process.execPath;

function runScript(name) {
  const start = new Date().toISOString();
  console.log(`[cron ${start}] running ${name}`);
  const proc = spawn(NODE, [path.join(SCRIPTS_DIR, name)], {
    stdio: 'inherit',
    env: process.env,
  });
  proc.on('exit', (code) => {
    const end = new Date().toISOString();
    console.log(`[cron ${end}] ${name} exited ${code}`);
  });
  proc.on('error', (err) => {
    console.error(`[cron] ${name} spawn error: ${err.message}`);
  });
}

export function startCronJobs() {
  // Local Mac wrapper already has launchd running these — skip in local mode
  // so we don't double-fire.
  if (process.env.LOCAL_ONLY === 'true') {
    console.log('[cron] LOCAL_ONLY=true — cloud cron disabled (launchd handles it)');
    return;
  }

  // Meta ads → ad_metrics (daily @ 05:00 UTC)
  cron.schedule('0 5 * * *', () => runScript('sync-ads-daily.mjs'));

  // Monday Coach Board programmed_to → clients (daily @ 05:15 UTC)
  cron.schedule('15 5 * * *', () => runScript('sync-programmed-to.mjs'));

  // Monday Clients Board assigned_coach → clients (daily @ 05:30 UTC)
  cron.schedule('30 5 * * *', () => runScript('sync-assigned-coach.mjs'));

  // Slack alerts monitor (every 4 hours)
  cron.schedule('0 */4 * * *', () => runScript('alerts-monitor.mjs'));

  console.log('[cron] 4 jobs scheduled (UTC): 05:00 ads · 05:15 programmed-to · 05:30 assigned-coach · */4h alerts');
}
