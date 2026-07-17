// Coach OS — Notification helper
// Triple-fires on failure:
//   1. macOS native notification (osascript) — instant local pop-up
//   2. Email via Resend → zacharyfaerber@gmail.com
//   3. coach_alerts row in Supabase (red severity, surfaces on dashboard)

import { exec } from 'child_process';
import { promisify } from 'util';
const execp = promisify(exec);

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'zacharyfaerber@gmail.com';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
// Resend sender — uses Resend's onboarding domain until faerberfitness.com is verified
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

async function notifyMacOS(title, message) {
  try {
    const escTitle = title.replace(/"/g, '\\"');
    const escMsg = message.replace(/"/g, '\\"').slice(0, 240);
    await execp(`osascript -e 'display notification "${escMsg}" with title "${escTitle}" sound name "Glass"'`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function notifyEmail(subject, htmlBody) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY missing' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: `Coach OS <${FROM_EMAIL}>`,
        to: [NOTIFY_EMAIL],
        subject,
        html: htmlBody,
      }),
    });
    const data = await r.json();
    if (!r.ok) return { ok: false, error: data?.message || 'Resend send failed', status: r.status };
    return { ok: true, id: data.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function notifySupabaseAlert(supabase, { clientId, clientName, type, message, severity = 'red' }) {
  if (!supabase) return { ok: false, error: 'supabase client missing' };
  try {
    const { data, error } = await supabase
      .from('coach_alerts')
      .insert({
        client_id: clientId || null,
        alert_type: type,
        severity,
        title: `🚨 ${type}: ${clientName}`,
        message,
      })
      .select()
      .single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: data?.id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Triple-fire failure notification.
 * @param {object} opts
 * @param {object} opts.supabase  Supabase client
 * @param {string} opts.clientId  Supabase client UUID (optional)
 * @param {string} opts.clientName  Display name
 * @param {string} opts.stage  Which pipeline step failed (e.g. 'meal_plan_upload')
 * @param {string} opts.error  Error message
 * @param {object} [opts.context]  Extra context (Trainerize ID, pending ID, etc.)
 */
async function notifyPipelineFailure({ supabase, clientId, clientName, stage, error, context = {} }) {
  const title = `Pipeline failure: ${stage}`;
  const macMsg = `${clientName} — ${error.slice(0, 200)}`;
  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 560px;">
      <h2 style="color: #b3261e; margin: 0 0 12px;">🚨 Pipeline failure</h2>
      <p style="font-size: 16px; color: #14110d; margin: 0 0 6px;"><strong>Client:</strong> ${escapeHtml(clientName)}</p>
      <p style="font-size: 14px; color: #5a4c3f; margin: 0 0 6px;"><strong>Stage:</strong> ${escapeHtml(stage)}</p>
      <p style="font-size: 14px; color: #5a4c3f; margin: 0 0 12px;"><strong>Error:</strong></p>
      <pre style="background: #faf3e3; padding: 12px 14px; border-left: 3px solid #c18b9d; border-radius: 6px; font-size: 13px; white-space: pre-wrap; word-break: break-word;">${escapeHtml(error)}</pre>
      ${Object.keys(context).length ? `<h3 style="margin: 16px 0 8px; font-size: 14px;">Context</h3><pre style="background: #f0ebe1; padding: 10px 12px; border-radius: 6px; font-size: 12px; white-space: pre-wrap;">${escapeHtml(JSON.stringify(context, null, 2))}</pre>` : ''}
      <p style="margin: 18px 0 0; font-size: 13px; color: #8a7d6f;">Dashboard: <a href="http://localhost:3737/">localhost:3737</a></p>
    </div>
  `;

  const [mac, email, supa] = await Promise.all([
    notifyMacOS(title, macMsg),
    notifyEmail(`🚨 [Coach OS] ${stage} failed — ${clientName}`, html),
    notifySupabaseAlert(supabase, {
      clientId,
      clientName,
      type: stage,
      message: `${error}\n\nContext: ${JSON.stringify(context).slice(0, 800)}`,
      severity: 'red',
    }),
  ]);

  console.error(`[notify] ${stage} | ${clientName} | mac=${mac.ok} email=${email.ok} supa=${supa.ok}`);
  if (!mac.ok) console.error('[notify] mac failed:', mac.error);
  if (!email.ok) console.error('[notify] email failed:', email.error);
  if (!supa.ok) console.error('[notify] supa failed:', supa.error);

  return { mac, email, supa };
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export { notifyPipelineFailure, notifyMacOS, notifyEmail, notifySupabaseAlert };
