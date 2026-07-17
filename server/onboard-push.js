// Onboard push — after Zach approves a pending_onboardings row,
// this builds the actual Phase 1 workouts in Trainerize, schedules them
// starting next Monday for 6 weeks, and locks the nutrition goal.

import Anthropic from '@anthropic-ai/sdk';
import { generateMealPlan } from './meal-plan-gen.js';
import { uploadMealPlan } from './meal-plan-upload.js';
import { notifyPipelineFailure } from './notify.js';

const TRAINERIZE_BASE = 'https://api.trainerize.com/v03';
const PHASE_WEEKS = 6;
const PHASE_LABEL = 'Phase 1 - Foundation';

function tzAuth() {
  const basic = Buffer.from(`${process.env.TRAINERIZE_GROUP_ID}:${process.env.TRAINERIZE_API_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
}
async function tzPost(path, body) {
  const res = await fetch(TRAINERIZE_BASE + path, { method: 'POST', headers: tzAuth(), body: JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}
function getAnthropic() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}
const iso = d => d.toISOString().slice(0, 10);

// ─── EXPAND HIGH-LEVEL SPLIT → CONCRETE EXERCISES ─────────────────
async function expandSplitToExercises(intake, split) {
  const anthropic = getAnthropic();
  const sys = `You are Zach Faerber's coaching AI. Convert a high-level workout day breakdown into concrete exercise lists for Trainerize.

Output ONLY JSON with this shape:
{
  "days": [
    {
      "name": "<short workout title — under 35 chars, e.g. 'Day 1 - Upper Push'>",
      "exercises": [
        "Exercise Name: SxR, Rs rest",
        ...
      ],
      "instructions": "<one-line note for the client about intent or form cues>"
    },
    ...
  ]
}

Rules:
- Use EXACT exercise names that match common Trainerize library entries (e.g. "Barbell Bench Press", "Dumbbell Row", "Glute Bridge", "Pike Push Up", "Bulgarian Split Squat")
- Format: "Exercise Name: setsxreps, Ns rest" (e.g. "Barbell Bench Press: 4x6-8, 120s rest")
- BW exercises don't include weight — just "Push Up: 3x10-12, 60s rest"
- **NEVER include warm-up exercises.** Client handles their own warm-up.
- **ALWAYS end each day with 2-3 mobility/stretch movements** as the last entries — light, restorative. Examples: "World's Greatest Stretch: 2x5 per side, 30s rest", "90/90 Hip Stretch: 2x30s per side, 30s rest", "Cat Cow: 2x10, 30s rest", "Standing Forward Fold: 1x60s, 0s rest"
- 6-10 LIFTING exercises per workout day + 2-3 mobility/stretch at the end
- Honor equipment_tier constraints — no barbell movements if "bw" or "home-minimal"
- Honor injury_swaps — substitute restricted movements
- Phase 1 = foundation. Sub-failure RPE, focus on form + consistency.
- For each day in split_breakdown, produce one day object in same order.`;

  const user = `# Client
${intake.full_name}, ${intake.gender}, ${intake.age}, ${intake.weight_lb}lb
Goal: ${intake.goal_type}
Experience: ${intake.experience}

# Equipment
- Tier: ${split.equipment_tier}
- Has: ${intake.equipment}

# Injuries
${intake.injuries}

# Injury swaps already noted
${(split.injury_swaps || []).join('\n')}

# Days to expand (preserve order)
${(split.split_breakdown || []).map((d, i) => `${i + 1}. ${d}`).join('\n')}

# Split name: ${split.split_name}
# Intensity: ${split.intensity}

Output the JSON now.`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });
  const text = resp.content?.[0]?.text || '';
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e < 0) throw new Error('No JSON in Sonnet response');
  return JSON.parse(text.slice(s, e + 1));
}

// ─── EXERCISE RESOLUTION ─────────────────────────────────────────
async function searchExercise(phrase) {
  const r = await tzPost('/exercise/search', {
    phrase,
    start: 1,
    count: 10,
    filters: { equipment: [], level: [], mainMuscle: [], mechanics: [], movement: [], source: [] },
    sortby: 'name',
  });
  const list = r.data?.exercises || [];
  // Prefer exact match, fallback first
  const lower = phrase.toLowerCase();
  return list.find(e => (e.name || '').toLowerCase() === lower) || list[0] || null;
}

function parseExerciseLine(line) {
  // Match: "Exercise Name: 4x8-10, 90s rest" or "Exercise Name: 3x30s, 30s rest"
  const lastColon = line.lastIndexOf(':');
  if (lastColon === -1) return null;
  const name = line.slice(0, lastColon).trim();
  const prescription = line.slice(lastColon + 1).trim();
  const setsMatch = prescription.match(/(\d+)\s*x\s*([^\s,@]+(?:\s+(?:sec|each\s+\w+))?)/i);
  if (!setsMatch) return null;
  const sets = parseInt(setsMatch[1]);
  let target;
  const repPart = setsMatch[2].trim();
  if (repPart.match(/\d+[-\d]*\s*sec/i) || repPart.match(/^\d+[-\d]*s$/)) {
    target = repPart.replace(/\s*sec$/i, 's').replace(/(\d)s$/, '$1 sec');
    if (!target.includes('sec')) target = target + ' sec';
  } else if (repPart.includes('each')) {
    target = repPart;
  } else {
    target = `${repPart} reps`;
  }
  const restMatch = prescription.match(/(?:@|,\s*)(\d+)\s*s(?:\s*rest)?/i);
  const restTime = restMatch ? parseInt(restMatch[1]) : 90;
  return { name, sets, target, restTime, superSetID: 0, supersetType: 'none' };
}

function buildTargetDetail(target) {
  if (target.includes('sec') || /^\d+s/.test(target)) {
    return { type: 20, distance: null, distanceUnit: null, time: null, text: target, zone: null };
  }
  return { type: 10, distance: null, distanceUnit: null, time: null, text: target, zone: null };
}

// ─── BUILD + SCHEDULE WORKOUTS ───────────────────────────────────
async function buildAndScheduleWorkouts({ intake, split, expanded, trainerizeUserId, startsOn, log, appendLog }) {
  // Get the user's training plan list
  const planRes = await tzPost('/trainingPlan/getList', { userID: trainerizeUserId });
  let planId = planRes.data?.plans?.[0]?.id;
  if (!planId) {
    log('no training plan on user yet, creating Phase 1');
    const created = await tzPost('/trainingPlan/add', {
      userID: trainerizeUserId,
      trainingPlan: {
        name: PHASE_LABEL,
        startDate: startsOn,
        durationType: 'weeks',
        duration: PHASE_WEEKS,
        instruction: `Auto-generated Phase 1. Split: ${split.split_name}. Intensity: ${split.intensity}.`,
      },
    });
    planId = created.data?.trainingPlan?.id || created.data?.id;
    await appendLog('plan_created', { planId });
  }
  if (!planId) throw new Error('Could not create or find training plan');

  // Build each workout def — de-dupe by name (Sonnet sometimes emits duplicates)
  const builtWorkouts = [];
  const seenNames = new Set();
  for (const day of expanded.days) {
    const baseName = (day.name || '').trim().toLowerCase();
    if (seenNames.has(baseName)) {
      log(`SKIPPING duplicate workout name: ${day.name}`);
      await appendLog('workout_skipped_dup', { name: day.name });
      continue;
    }
    seenNames.add(baseName);
    const exercises = [];
    for (const line of day.exercises) {
      const parsed = parseExerciseLine(line);
      if (!parsed) { log(`could not parse: ${line}`); continue; }
      const found = await searchExercise(parsed.name);
      if (!found) {
        log(`exercise not found: ${parsed.name}`);
        continue;
      }
      exercises.push({
        def: {
          id: found.id,
          superSetID: parsed.superSetID,
          sets: parsed.sets,
          target: parsed.target,
          targetDetail: buildTargetDetail(parsed.target),
          side: null,
          supersetType: parsed.supersetType,
          intervalTime: 0,
          restTime: parsed.restTime,
          recordType: found.recordType || 'strength',
          type: found.type || 'custom',
        },
        note: null,
      });
    }
    if (exercises.length === 0) continue;

    const addRes = await tzPost('/workoutDef/add', {
      type: 'trainingPlan',
      userID: trainerizeUserId,
      trainingPlanID: planId,
      workoutDef: {
        type: 'workoutRegular',
        name: day.name.slice(0, 35),
        instructions: day.instructions || '',
        exercises,
      },
    });
    const woId = addRes.data?.workoutID || addRes.data?.workoutDef?.id;
    if (woId) {
      builtWorkouts.push({ name: day.name, woId });
      await appendLog('workout_built', { name: day.name, woId });
    } else {
      log(`workout add failed for ${day.name}:`, addRes.text.slice(0, 200));
    }
  }

  // Schedule on calendar — 6 weeks starting startsOn
  // Use AUTHORITATIVE train_days from intake (checkbox-picked) if present.
  // Fallback to parsing schedule_pattern if not.
  const startDate = new Date(startsOn + 'T12:00:00');
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const checkedDays = (intake.raw_payload?.train_days || []).map(d => dayMap[d]).filter(d => d != null);
  // Mon-based offsets (we start Monday)
  let scheduleDays;
  if (checkedDays.length) {
    const baseOffsets = checkedDays.map(d => (d === 0 ? 6 : d - 1)).sort((a, b) => a - b);
    // If more workouts than train days, force builtWorkouts to match train_days count
    if (builtWorkouts.length > baseOffsets.length) {
      log(`WARNING: ${builtWorkouts.length} workouts but only ${baseOffsets.length} train days. Capping to ${baseOffsets.length}.`);
      await appendLog('workouts_capped_to_train_days', { built: builtWorkouts.length, days: baseOffsets.length });
      builtWorkouts.length = baseOffsets.length;
    }
    scheduleDays = baseOffsets.slice(0, builtWorkouts.length);
  } else {
    scheduleDays = guessDaysFromPattern(split.schedule_pattern, builtWorkouts.length);
  }
  // Final guard: dedupe scheduleDays (no two workouts on same day)
  const seenDays = new Set();
  scheduleDays = scheduleDays.filter(d => {
    if (seenDays.has(d)) return false;
    seenDays.add(d);
    return true;
  });
  if (scheduleDays.length < builtWorkouts.length) builtWorkouts.length = scheduleDays.length;

  let scheduledCount = 0;
  for (let week = 0; week < PHASE_WEEKS; week++) {
    for (let i = 0; i < builtWorkouts.length; i++) {
      const dayOffset = scheduleDays[i] != null ? scheduleDays[i] : i;
      const date = new Date(startDate);
      date.setDate(date.getDate() + (week * 7) + dayOffset);
      const r = await tzPost('/dailyWorkout/set', {
        dailyWorkouts: [{
          userID: trainerizeUserId,
          id: 0,
          date: iso(date),
          name: builtWorkouts[i].name,
          type: 'workoutRegular',
          workoutID: builtWorkouts[i].woId,
        }],
        unitDistance: 'miles',
        unitWeight: 'lbs',
      });
      if (r.ok) scheduledCount++;
    }
  }
  await appendLog('workouts_scheduled', { count: scheduledCount, weeks: PHASE_WEEKS });
  return { builtCount: builtWorkouts.length, scheduledCount };
}

function guessDaysFromPattern(pattern, count) {
  if (!pattern) return Array.from({ length: count }, (_, i) => i);
  const p = pattern.toUpperCase();
  const dayMap = { M: 0, T: 1, W: 2, R: 3, F: 4, S: 5, U: 6 };
  // Match "M/W/F" / "M, W, F" / "Mon Wed Fri" / "Monday Tuesday..."
  const matches = [];
  if (/MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY/.test(p)) {
    const days = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
    days.forEach((d, i) => { if (p.includes(d)) matches.push(i); });
  } else if (/MON|TUE|WED|THU|FRI|SAT|SUN/.test(p)) {
    const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
    days.forEach((d, i) => { if (p.includes(d)) matches.push(i); });
  } else {
    // Single-letter M/W/F style
    let m;
    const re = /\b([MTWRFSU])\b/g;
    while ((m = re.exec(p)) !== null) matches.push(dayMap[m[1]]);
  }
  if (matches.length === 0) return Array.from({ length: count }, (_, i) => i);
  // Pad/truncate to count
  const out = [];
  for (let i = 0; i < count; i++) out.push(matches[i] ?? matches[matches.length - 1] + 1 + (i - matches.length));
  return out;
}

// ─── SET NUTRITION GOAL ──────────────────────────────────────────
async function setNutritionGoal(trainerizeUserId, macros) {
  // Pull current goal (may be empty on freshly-created user)
  const list = await tzPost('/goal/getList', { userID: trainerizeUserId });
  const goal = (list.data?.goals || []).find(g => g.type === 'nutritionGoal');
  const payload = {
    userID: trainerizeUserId,
    type: 'nutritionGoal',
    caloricGoal: macros.caloricGoal,
    proteinGrams: macros.proteinGrams,
    carbsGrams: macros.carbsGrams,
    fatGrams: macros.fatGrams,
    proteinPercent: macros.proteinPercent,
    carbsPercent: macros.carbsPercent,
    fatPercent: macros.fatPercent,
    trackingType: 'trackWithTZ',
    nutritionDeviation: 20,
  };
  let r;
  if (goal) {
    // Update existing
    r = await tzPost('/goal/set', { id: goal.id, ...payload });
  } else {
    // Create new
    r = await tzPost('/goal/add', payload);
  }
  return { ok: r.ok, error: r.ok ? null : r.text };
}

// ─── MAIN PUSH FUNCTION ──────────────────────────────────────────
async function pushApprovedOnboarding({ supabase, pendingId }) {
  const log = (msg, data) => console.log(`[push:${pendingId}] ${msg}`, data || '');

  const { data: pending, error } = await supabase
    .from('pending_onboardings')
    .select('*, intake_submissions(*)')
    .eq('id', pendingId)
    .single();
  if (error || !pending) throw new Error(`Pending ${pendingId} not found`);

  const intake = pending.intake_submissions;
  const split = pending.selected_split;
  const macros = pending.computed_macros;
  const userId = pending.trainerize_user_id;
  const startsOn = pending.starts_on || iso(new Date());

  if (!userId) throw new Error('No trainerize_user_id on pending row');
  if (!split?.ok || !macros?.ok) throw new Error('Spec incomplete');

  const appendLog = async (step, info = {}) => {
    const entry = { step, at: new Date().toISOString(), ...info };
    const { data } = await supabase.from('pending_onboardings').select('pipeline_log').eq('id', pendingId).single();
    const newLog = [...(data?.pipeline_log || []), entry];
    await supabase.from('pending_onboardings').update({ pipeline_log: newLog }).eq('id', pendingId);
  };

  try {
    // 1. Expand high-level split into concrete exercises
    log('expanding split into exercises');
    const expanded = await expandSplitToExercises(intake, split);
    await appendLog('split_expanded', { dayCount: expanded.days?.length || 0 });

    // 2. Build + schedule workouts
    log('building + scheduling workouts');
    const built = await buildAndScheduleWorkouts({
      intake, split, expanded,
      trainerizeUserId: userId,
      startsOn,
      log, appendLog,
    });
    log('workouts done', built);

    // 3. Set nutrition goal
    log('setting nutrition goal');
    const macroResult = await setNutritionGoal(userId, macros);
    if (!macroResult.ok) {
      log('macro set failed', macroResult.error);
      await appendLog('macro_set_failed', { error: macroResult.error });
    } else {
      await appendLog('macros_set', macros);
    }

    // 4. To-do spawning is now done via post-approve checkbox modal (see /api/intake/pending/:id/spawn-todos)
    // Pipeline used to auto-create meal plan to-do here — moved to UX layer for flexibility.

    // 5. Mark complete
    await supabase.from('pending_onboardings').update({
      status: 'approved',
      completed_at: new Date().toISOString(),
    }).eq('id', pendingId);

    return { ok: true, built: built.builtCount, scheduled: built.scheduledCount, startsOn };
  } catch (e) {
    log('push error', e.message);
    await appendLog('push_error', { message: e.message });
    await supabase.from('pending_onboardings').update({
      status: 'failed',
      review_reason: `Push failed: ${e.message}`,
    }).eq('id', pendingId);
    // Notify on any catastrophic failure
    try {
      await notifyPipelineFailure({
        supabase,
        clientId: pending?.intake_submissions?.id,
        clientName: pending?.client_name || 'Unknown',
        stage: 'onboard_push',
        error: e.message,
        context: { pendingId, trainerizeUserId: pending?.trainerize_user_id },
      });
    } catch {}
    return { ok: false, error: e.message };
  }
}

export { pushApprovedOnboarding, expandSplitToExercises, buildAndScheduleWorkouts, setNutritionGoal };
