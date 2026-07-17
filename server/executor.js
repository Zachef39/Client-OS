// Coach OS Executor
// Per-category handlers that actually DO the work behind each to-do.
// Each handler receives: { todo, client, checkin, env } and returns { status, result }
// where status ∈ 'completed' | 'blocked' | 'needs_input' | 'failed'
// and result is a markdown log string the dashboard renders.

import { spawn } from 'child_process';
import { generateMealPlan } from './meal-plan-gen.js';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

const FF_CHECKIN = process.env.FF_CHECKIN || '/Users/zachef/Desktop/Playground - Claude/faerber-checkin';
const BOOKING_LINK = 'https://go.faerberfitness.com/widget/bookings/15zf';
const DEFAULT_BOOKING_MESSAGE = `Hey, book some time with me here: ${BOOKING_LINK}`;

// ─── TRAINERIZE HELPERS ──────────────────────────────────────────
function tzAuth() {
  const basic = Buffer.from(`${process.env.TRAINERIZE_GROUP_ID}:${process.env.TRAINERIZE_API_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
}

async function tzPost(path, body) {
  const res = await fetch('https://api.trainerize.com/v03' + path, {
    method: 'POST',
    headers: tzAuth(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

async function tzGetThreadID(userID) {
  const r = await tzPost('/message/getThreadList', { count: 200 });
  if (!r.ok) return null;
  const threads = r.data?.threads || [];
  const thread = threads.find(t => t.users?.some(u => u.userID === userID));
  return thread?.id || null;
}

async function tzSendMessage(userID, body) {
  const threadID = await tzGetThreadID(userID);
  if (!threadID) {
    return { ok: false, error: `No Trainerize thread found for userID ${userID}` };
  }
  const r = await tzPost('/message/reply', {
    threadID,
    body,
  });
  return { ok: r.ok, status: r.status, error: r.ok ? null : r.text };
}

async function tzGetNutritionGoal(userID) {
  const r = await tzPost('/goal/getList', { userID });
  if (!r.ok) return null;
  const goals = r.data?.goals || [];
  return goals.find(g => g.type === 'nutritionGoal') || null;
}

async function tzSetNutritionGoal(userID, { caloricGoal, proteinGrams, carbsGrams, fatGrams }) {
  const current = await tzGetNutritionGoal(userID);
  if (!current) return { ok: false, error: 'No existing nutritionGoal record on user — cannot update via /goal/set' };

  // Derive percents
  const cal = caloricGoal ?? current.caloricGoal;
  const p = proteinGrams ?? current.proteinGrams;
  const c = carbsGrams ?? current.carbsGrams;
  const f = fatGrams ?? current.fatGrams;
  const pPct = Math.round((p * 4 / cal) * 100);
  const cPct = Math.round((c * 4 / cal) * 100);
  const fPct = 100 - pPct - cPct;

  const r = await tzPost('/goal/set', {
    id: current.id,
    userID,
    type: 'nutritionGoal',
    caloricGoal: cal,
    proteinGrams: p,
    carbsGrams: c,
    fatGrams: f,
    proteinPercent: pPct,
    carbsPercent: cPct,
    fatPercent: fPct,
    trackingType: current.trackingType || 'trackWithTZ',
    nutritionDeviation: current.nutritionDeviation || 20,
  });
  return { ok: r.ok, status: r.status, error: r.ok ? null : r.text, before: current, after: { caloricGoal: cal, proteinGrams: p, carbsGrams: c, fatGrams: f } };
}

// ─── ANTHROPIC SPEC DRAFTER ──────────────────────────────────────
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

async function draftSpec({ category, note, client, checkin, recentMessages }) {
  const anthropic = getAnthropic();
  if (!anthropic) return { ok: false, error: 'ANTHROPIC_API_KEY missing' };

  const systemPrompt = `You are Zach Faerber's coaching ops AI. Your job: take a coach to-do, the client's check-in context, and recent Trainerize messages, then output a structured EXECUTION SPEC as JSON.

Output ONLY valid JSON with this shape:
{
  "executable": true | false,
  "category": "<original category>",
  "params": { ... structured params required to execute, varies by category ... },
  "confidence": "high" | "medium" | "low",
  "blockers": ["<reason if not executable>"],
  "human_notes": "<one-line summary for Zach to confirm>"
}

CATEGORY-SPECIFIC param shapes:

calorie:
  { "userID": <trainerize_user_id>, "caloricGoal": <num>, "proteinGrams": <num>, "carbsGrams": <num optional>, "fatGrams": <num optional>, "reason": "<short>" }

call:
  { "userID": <trainerize_user_id>, "message": "<full Trainerize message text including booking link>" }

check-in:
  { "userID": <trainerize_user_id>, "message": "<reply text to send>" }

mealplan:
  { "client_slug": "<first_last lowercase>", "phase": "<Phase X>", "macros": { ... }, "notes": "<context>" }

workout (add/build):
  { "client_name": "<full>", "phase_plan_id": <num or null>, "exercises": ["Name: SxR, Rs rest", ...], "schedule_pattern": "<e.g. M/W/F>", "confirm_required": true }

workout (delete):
  { "userID": <trainerize_user_id>, "calendar_item_ids": [<num>, ...], "reason": "<short>" }

bloodwork:
  { "executable": false, "blockers": ["Manual lab analysis required — flag for Zach"] }

other:
  { "spawn_claude_prompt": "<full prompt to give Claude Code CLI to attack this task>" }

RULES:
- Set executable=false if any required param can't be confidently extracted from context.
- For 'call' category: ALWAYS include booking link ${BOOKING_LINK}.
- For 'check-in' category: write in Zach's voice — conversational, supportive, no numbered lists, references their check-in struggles/wins.
- For 'calorie' category: math the macros if not explicitly given (protein floor stays, balance via carbs/fat).
- If confidence < high, set executable=false and include human_notes asking for clarification.`;

  const userMsg = `# To-Do
Category: ${category}
Note: ${note}

# Client
Name: ${client.full_name}
Trainerize User ID: ${client.trainerize_user_id}
Goal: ${client.goal || '—'}
Current Cal Target: ${client.daily_calorie_target || '—'}
Current Protein Target: ${client.daily_protein_target_g || '—'}
Notes: ${(client.notes || '').slice(0, 800)}

# Latest Check-in
${checkin ? `Date: ${checkin.checkin_date}
Tier: ${checkin.tier}
Wins: ${checkin.wins || '—'}
Struggles: ${checkin.struggles || '—'}
Questions: ${checkin.questions || '—'}
Energy: ${checkin.energy_1to10}/10  Sleep: ${checkin.sleep_hours_avg}h  Stress: ${checkin.stress_1to10}/10` : 'No recent check-in.'}

# Recent Trainerize Messages (last 7 days)
${recentMessages || '(none captured)'}

Output the JSON spec now.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content?.[0]?.text || '';
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart < 0 || jsonEnd < 0) return { ok: false, error: 'No JSON in response', raw: text };
    const json = text.slice(jsonStart, jsonEnd + 1);
    const spec = JSON.parse(json);
    return { ok: true, spec };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── HANDLERS ─────────────────────────────────────────────────────

async function handleCalorie({ todo, client, spec }) {
  const params = spec?.params || {};
  const userID = params.userID || Number(client.trainerize_user_id);
  if (!userID) return { status: 'failed', result: '❌ Missing Trainerize userID' };
  if (!params.caloricGoal && !params.proteinGrams) return { status: 'needs_input', result: '⚠️ Spec missing caloricGoal or proteinGrams' };

  const r = await tzSetNutritionGoal(userID, params);
  if (!r.ok) return { status: 'failed', result: `❌ Trainerize /goal/set failed: ${r.error}` };

  const log = [
    `✅ Bumped ${client.full_name} nutrition target.`,
    ``,
    `**Before:** ${r.before.caloricGoal} cal / ${r.before.proteinGrams}P / ${r.before.carbsGrams}C / ${r.before.fatGrams}F`,
    `**After:** ${r.after.caloricGoal} cal / ${r.after.proteinGrams}P / ${r.after.carbsGrams}C / ${r.after.fatGrams}F`,
    ``,
    `**Reason:** ${params.reason || todo.note}`,
  ].join('\n');
  return { status: 'completed', result: log };
}

async function handleCall({ todo, client, spec }) {
  const params = spec?.params || {};
  const userID = params.userID || Number(client.trainerize_user_id);
  if (!userID) return { status: 'failed', result: '❌ Missing Trainerize userID' };

  // Default message ALWAYS works — never fail on empty body
  let body = (params.message || '').trim();
  if (!body) body = DEFAULT_BOOKING_MESSAGE;
  // Guarantee link present
  if (!body.includes(BOOKING_LINK) && !body.includes('go.faerberfitness.com')) {
    body += `\n\n${BOOKING_LINK}`;
  }
  const r = await tzSendMessage(userID, body);
  if (!r.ok) return { status: 'failed', result: `❌ Trainerize message failed: ${r.error}` };
  return { status: 'completed', result: `✅ Booking-link message sent to ${client.full_name} via Trainerize.\n\n**Sent:**\n> ${body.replace(/\n/g, '\n> ')}` };
}

async function handleCheckin({ todo, client, spec }) {
  const params = spec?.params || {};
  const userID = params.userID || Number(client.trainerize_user_id);
  if (!userID) return { status: 'failed', result: '❌ Missing Trainerize userID' };
  if (!params.message) return { status: 'needs_input', result: '⚠️ Spec missing message body' };

  const r = await tzSendMessage(userID, params.message);
  if (!r.ok) return { status: 'failed', result: `❌ Trainerize message failed: ${r.error}` };
  return { status: 'completed', result: `✅ Check-in message sent to ${client.full_name}.\n\n**Sent:**\n> ${params.message.replace(/\n/g, '\n> ')}` };
}

async function handleMealplan({ todo, client, spec }) {
  // Path 1 — auto-generator. Try intake_id from context, OR fall back to looking up latest intake by client email/name.
  const ctx = todo.context || {};
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(
      'https://sfuvqaoeuajsrvldoiek.supabase.co',
      process.env.SUPABASE_SERVICE_KEY,
    );

    // Step 1 — find intake row
    let intake = null;
    const intakeId = ctx.intake_id || spec?.params?.intake_id;
    if (intakeId) {
      const { data } = await supabase.from('intake_submissions').select('*').eq('id', intakeId).single();
      intake = data;
    }
    if (!intake && client.email) {
      const { data } = await supabase
        .from('intake_submissions')
        .select('*')
        .ilike('email', client.email)
        .order('submitted_at', { ascending: false })
        .limit(1);
      intake = data?.[0] || null;
    }
    if (!intake && client.full_name) {
      const { data } = await supabase
        .from('intake_submissions')
        .select('*')
        .ilike('full_name', `%${client.full_name}%`)
        .order('submitted_at', { ascending: false })
        .limit(1);
      intake = data?.[0] || null;
    }

    // Step 2 — find macros. Trainerize current goal is THE source of truth (what client sees in app).
    let macros = null;
    const tzUserId = client.trainerize_user_id || ctx.trainerize_user_id;
    if (tzUserId) {
      try {
        const list = await tzPost('/goal/getList', { userID: Number(tzUserId) });
        const goal = (list.data?.goals || []).find(g => g.type === 'nutritionGoal');
        if (goal && goal.caloricGoal > 0) {
          macros = {
            ok: true,
            caloricGoal: goal.caloricGoal,
            proteinGrams: goal.proteinGrams,
            carbsGrams: goal.carbsGrams,
            fatGrams: goal.fatGrams,
            proteinPercent: goal.proteinPercent,
            carbsPercent: goal.carbsPercent,
            fatPercent: goal.fatPercent,
            _source: 'trainerize_current',
          };
        }
      } catch {}
    }
    // Fallback: context macros (only if Trainerize had nothing AND context has valid cal)
    if (!macros && (ctx.macros?.caloricGoal > 0 || spec?.params?.macros?.caloricGoal > 0)) {
      macros = ctx.macros || spec?.params?.macros;
    }
    if (!macros && intake) {
      const { data: pending } = await supabase
        .from('pending_onboardings')
        .select('computed_macros')
        .eq('intake_submission_id', intake.id)
        .limit(1);
      const pm = pending?.[0]?.computed_macros;
      if (pm && pm.caloricGoal > 0) macros = pm;
    }
    if (!macros && client.daily_calorie_target && client.daily_protein_target_g) {
      const cal = client.daily_calorie_target;
      const p = client.daily_protein_target_g;
      const f = Math.round((cal * 0.28) / 9);
      const c = Math.max(50, Math.round((cal - (p * 4) - (f * 9)) / 4));
      macros = {
        ok: true,
        caloricGoal: cal,
        proteinGrams: p,
        carbsGrams: c,
        fatGrams: f,
        proteinPercent: Math.round((p * 4 / cal) * 100),
        carbsPercent: Math.round((c * 4 / cal) * 100),
        fatPercent: Math.round((f * 9 / cal) * 100),
      };
    }

    // Step 3 — if no intake found, synthesize from Monday Notes Doc + Trainerize eating
    if (!intake) {
      const synth = await synthesizeIntakeFromClient({ client, macros, tzUserId });
      if (synth.ok) intake = synth.intake;
      else return { status: 'needs_input', result: `⚠️ No intake found for ${client.full_name} AND fallback failed: ${synth.error}. Use the Onboard button (paste their info) first, then retry.` };
    }

    if (intake && macros) {
      const result = await generateMealPlan({ intake, macros });
      // Auto-open PDF in Preview for review
      try { spawn('open', [result.path], { detached: true, stdio: 'ignore' }).unref(); } catch {}
      return {
        status: 'completed',
        result: `✅ Generated ${client.full_name}'s meal plan.\n\n**Saved:** \`${result.path}\`\n\n**Macros locked:** ${macros.caloricGoal} cal · ${macros.proteinGrams}g P · ${macros.carbsGrams}g C · ${macros.fatGrams}g F\n\nPDF opened in Preview. Review it, then send to ${client.full_name} via Trainerize manually (web or phone app).`,
      };
    }
    if (!macros) {
      return { status: 'needs_input', result: `⚠️ No macros for ${client.full_name}. Set daily_calorie_target + daily_protein_target_g on clients row OR ensure Trainerize has a nutrition goal set.` };
    }
  } catch (e) {
    return { status: 'failed', result: `❌ Auto-generator failed: ${e.message}` };
  }

  // Path 2 — legacy per-client script (existing clients like Miriah/Jaelyn)
  const slug = (spec?.params?.client_slug || client.full_name.toLowerCase().replace(/\s+/g, '-')).replace(/[^a-z0-9-]/g, '');
  const scriptPath = path.join(FF_CHECKIN, `${slug}-plan-pdf.js`);
  if (!fs.existsSync(scriptPath)) {
    return {
      status: 'needs_input',
      result: `⚠️ No legacy script at \`${scriptPath}\` AND no intake_id in to-do context.\n\nUse "Draft spec" first to add intake_id, OR build the per-client script.`,
    };
  }
  return await new Promise(resolve => {
    const proc = spawn('node', [scriptPath], { cwd: FF_CHECKIN });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { out += d.toString(); });
    proc.on('close', code => {
      if (code === 0) {
        resolve({ status: 'completed', result: `✅ Regenerated ${client.full_name}'s meal plan PDF.\n\n\`\`\`\n${out.slice(-1500)}\n\`\`\`` });
      } else {
        resolve({ status: 'failed', result: `❌ PDF script exited ${code}\n\n\`\`\`\n${out.slice(-1500)}\n\`\`\`` });
      }
    });
  });
}

async function handleWorkoutDelete({ client, spec }) {
  const params = spec?.params || {};
  const userID = params.userID || Number(client.trainerize_user_id);
  const ids = params.calendar_item_ids || [];
  if (!userID || !ids.length) return { status: 'needs_input', result: '⚠️ Spec missing userID or calendar_item_ids' };

  const r = await tzPost('/dailyWorkout/delete', { ids });
  if (!r.ok) return { status: 'failed', result: `❌ Delete failed: ${r.text}` };
  return { status: 'completed', result: `✅ Deleted ${ids.length} calendar item(s) for ${client.full_name}.\n**Reason:** ${params.reason || '—'}` };
}

async function handleBloodwork({ client }) {
  return {
    status: 'blocked',
    result: `🚧 Bloodwork interpretation requires manual review. Lab values + supplement protocol decisions stay with Zach.\n\nFor ${client.full_name}: pull labs, draft Bloodwork PDF using the universal rules in memory.`,
  };
}

async function handleWorkoutAdd({ todo, client, spec }) {
  // Always require human spec confirmation — too high-stakes to autonomous-execute
  const params = spec?.params || {};
  if (!params.confirm_required) {
    return {
      status: 'needs_input',
      result: `⚠️ Workout additions need spec confirmation before push.\n\n**Draft spec:**\n\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\`\n\nUse the "Edit spec" button to lock in exercises + schedule pattern, then re-run.`,
    };
  }
  // If confirmed, the user has approved the spec — but we still don't auto-schedule.
  // Surface the create-workout.js command for Zach to run.
  const exLines = (params.exercises || []).map(e => `  "${e}"`).join(' \\\n');
  const cmd = `cd faerber-checkin && node create-workout.js "${params.workout_name || todo.note}" \\\n${exLines} \\\n  --client "${client.full_name}"${params.phase_plan_id ? ` --plan-id ${params.phase_plan_id}` : ''}`;
  return {
    status: 'needs_input',
    result: `📋 Confirmed spec — run this in terminal to create the workout, then schedule manually:\n\n\`\`\`bash\n${cmd}\n\`\`\`\n\nSchedule pattern: ${params.schedule_pattern || 'TBD'}`,
  };
}

async function handleOther({ todo, client, spec, checkin }) {
  // Generate a Claude Code CLI prompt the user can run themselves
  const prompt = spec?.params?.spawn_claude_prompt || `Coach to-do for ${client.full_name}:

Category: ${todo.category}
Note: ${todo.note}

Latest check-in tier: ${checkin?.tier || 'n/a'}
Wins: ${checkin?.wins || '—'}
Struggles: ${checkin?.struggles || '—'}

Figure out the right action, propose it, get my approval, then execute.`;
  return {
    status: 'needs_input',
    result: `📤 Open-ended task — handing off to Claude Code.\n\n**Prompt (copy/paste into Claude):**\n\n\`\`\`\n${prompt}\n\`\`\``,
  };
}

// ─── DISPATCHER ──────────────────────────────────────────────────
const HANDLERS = {
  calorie: handleCalorie,
  call: handleCall,
  'check-in': handleCheckin,
  mealplan: handleMealplan,
  bloodwork: handleBloodwork,
  other: handleOther,
};

async function executeTodo({ todo, client, checkin, spec }) {
  // Workout splits into add vs delete based on spec
  if (todo.category === 'workout') {
    const action = spec?.params?.action || (spec?.params?.calendar_item_ids?.length ? 'delete' : 'add');
    if (action === 'delete') return await handleWorkoutDelete({ todo, client, spec });
    return await handleWorkoutAdd({ todo, client, spec });
  }
  const handler = HANDLERS[todo.category];
  if (!handler) return { status: 'blocked', result: `❌ No handler for category "${todo.category}"` };
  return await handler({ todo, client, spec, checkin });
}

// ─── FALLBACK INTAKE SYNTHESIS ────────────────────────────────────
// When no intake_submission exists, pull from Monday Notes Doc + Trainerize eating logs
// → Sonnet synthesizes intake structure → feeds meal plan generator.
async function fetchMondayNotesDocText(mondayItemId, clientFullName) {
  const token = process.env.MONDAY_API_TOKEN || process.env.MONDAY_API_KEY;
  if (!token) return null;
  try {
    // If no monday_item_id, search by name on Coach Board (8896739421)
    let itemId = mondayItemId;
    if (!itemId && clientFullName) {
      const searchQ = `query { items_page_by_column_values(board_id: 8896739421, columns: [{ column_id: "name", column_values: ["${clientFullName.replace(/"/g, '\\"')}"] }]) { items { id } } }`;
      const sr = await fetch('https://api.monday.com/v2', { method:'POST', headers:{'Content-Type':'application/json',Authorization:token}, body: JSON.stringify({ query: searchQ }) });
      const sj = await sr.json();
      const items = sj.data?.items_page_by_column_values?.items || [];
      itemId = items[0]?.id;
    }
    if (!itemId) return null;

    // Read updates (comments) on the item — these contain coach notes
    const updQ = `query { items(ids: [${itemId}]) { name updates(limit: 30) { body created_at creator { name } } } }`;
    const r2 = await fetch('https://api.monday.com/v2', { method:'POST', headers:{'Content-Type':'application/json',Authorization:token}, body: JSON.stringify({ query: updQ }) });
    const j2 = await r2.json();
    const updates = j2.data?.items?.[0]?.updates || [];
    const text = updates.map(u => `(${u.created_at?.slice(0, 10)}) ${u.body || ''}`).join('\n\n').replace(/<[^>]+>/g, ' ').slice(0, 12000);
    return text.length > 30 ? text : null;
  } catch (e) { return null; }
}

async function fetchTrainerizeRecentMeals(userID, days = 14) {
  if (!userID) return null;
  try {
    const today = new Date();
    const start = new Date(today); start.setDate(today.getDate() - days);
    const iso = d => d.toISOString().slice(0, 10);
    const auth = Buffer.from(`${process.env.TRAINERIZE_GROUP_ID}:${process.env.TRAINERIZE_API_TOKEN}`).toString('base64');
    // Trainerize returns nutrition items inside the workout calendar response
    const r = await fetch('https://api.trainerize.com/v03/dailyWorkout/getCalendar', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ userid: userID, start: iso(start), end: iso(today) }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const days_ = j.calendar || j.days || [];
    const lines = [];
    for (const d of days_) {
      for (const it of (d.items || [])) {
        if (it.type === 'nutrition' && it.detail) {
          const det = it.detail;
          const macs = `${det.calories || 0} cal · ${det.proteinGrams || 0}P · ${det.carbsGrams || 0}C · ${det.fatGrams || 0}F`;
          const meals = (det.meals || []).map(m => m.name || 'meal').join(', ');
          lines.push(`${d.date}: ${macs}${meals ? ' — ' + meals : ''}`);
        }
      }
    }
    return lines.length ? lines.slice(-21).join('\n') : null;
  } catch { return null; }
}

async function synthesizeIntakeFromClient({ client, macros, tzUserId }) {
  // Pull Monday context (by ID OR by name search) + Trainerize meals in parallel
  const [mondayText, eatingLog] = await Promise.all([
    fetchMondayNotesDocText(client.monday_item_id, client.full_name),
    fetchTrainerizeRecentMeals(tzUserId),
  ]);

  // Build a quick synthesized intake from whatever's available
  const ctxBlocks = [];
  if (client.notes) ctxBlocks.push(`# Coach notes (from clients table)\n${client.notes}`);
  if (mondayText) ctxBlocks.push(`# Monday Notes Doc / Updates\n${mondayText}`);
  if (eatingLog) ctxBlocks.push(`# Recent Trainerize meals (last 14 days)\n${eatingLog}`);
  // Even if no context, generate a SOLID generic plan using macros + name + age/goal hints from client row
  if (!ctxBlocks.length) {
    ctxBlocks.push(`# Minimal context (no Monday/Trainerize/notes data)\nName: ${client.full_name}\nAge: ${client.age || 'unknown'}\nLocation: ${client.location || 'US'}\nStart date: ${client.start_date || 'recent'}\nGoal: ${client.goal || 'general fat loss + health'}\nWeight: ${client.starting_weight_lbs || '?'} → ${client.goal_weight_lbs || '?'} lb\n\nGenerate a SOLID GENERIC meal plan. No allergies assumed. Common American foods. Cover all dietary lifestyles broadly w/ flexible options.`);
  }

  const anthropic = new (await import('@anthropic-ai/sdk')).default({ apiKey: process.env.ANTHROPIC_API_KEY });
  const sys = `You synthesize a meal-plan-ready intake structure from coach notes + Trainerize eating logs. Return ONLY JSON with this shape:
{
  "full_name": "<from client>",
  "age": <number or null>,
  "gender": "Male" | "Female" | null,
  "weight_lb": <number or null>,
  "goal_weight_lb": <number or null>,
  "goal_type": "fat-loss" | "recomp" | "muscle" | "maintain" | null,
  "why_now": "<one line>",
  "food_relationship": "<one line from context>",
  "food_love": "<comma list inferred from recent Trainerize meals + Monday notes>",
  "food_avoid": "<allergies/dislikes from Monday notes — be cautious, include only if explicitly mentioned>",
  "typical_day": "<2-line summary of what they actually eat based on recent Trainerize meals>",
  "flags": [],
  "sleep_quality": null,
  "stress": null,
  "typical_weekday": null,
  "coaching_tone": null,
  "city": "<from client.location or null>",
  "anything_else": null
}
Never fabricate. If something isn't clearly in the context, set null.`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: sys,
      messages: [{ role: 'user', content: `Client: ${client.full_name}\nLocation: ${client.location || '—'}\nCurrent macros: ${macros?.caloricGoal || '?'} cal / ${macros?.proteinGrams || '?'}g P\n\nContext:\n\n${ctxBlocks.join('\n\n')}\n\nReturn JSON now.` }],
    });
    const text = resp.content?.[0]?.text || '';
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s < 0 || e < 0) return { ok: false, error: 'Sonnet returned no JSON' };
    const intake = JSON.parse(text.slice(s, e + 1));
    intake.full_name = client.full_name;
    intake.email = client.email || '';
    return { ok: true, intake };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export { draftSpec, executeTodo, tzGetThreadID, tzSendMessage, tzSetNutritionGoal };
