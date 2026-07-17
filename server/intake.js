// Coach OS — Auto-onboarding intake pipeline
// Receives form submission → writes Supabase → creates Trainerize user
// → computes macros → picks workout split → creates Monday Coach Board item
// → flags risky cases → marks ready for review.

import Anthropic from '@anthropic-ai/sdk';

const TRAINERIZE_BASE = 'https://api.trainerize.com/v03';
const DEFAULT_PASSWORD = 'Welcome123!';
const COACH_BOARD_ID = 8896739421;
const NOTES_DOC_COLUMN_ID = 'doc_mm2sfz0d';

// Health flags that auto-trigger human review
const REVIEW_FLAGS = ['pregnant', 'postpartum', 'breastfeeding', 'diabetic', 'autoimmune', 'heart', 'ed-history'];

// ─── HELPERS ──────────────────────────────────────────────────────
function tzAuth() {
  const basic = Buffer.from(`${process.env.TRAINERIZE_GROUP_ID}:${process.env.TRAINERIZE_API_TOKEN}`).toString('base64');
  return { Authorization: `Basic ${basic}`, 'Content-Type': 'application/json' };
}

async function tzPost(path, body) {
  const res = await fetch(TRAINERIZE_BASE + path, {
    method: 'POST',
    headers: tzAuth(),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function splitFullName(fullName) {
  const parts = (fullName || '').trim().split(/\s+/);
  return { firstName: parts[0] || 'Client', lastName: parts.slice(1).join(' ') || '—' };
}

function parseHeightToCm(heightStr) {
  if (!heightStr) return null;
  const s = heightStr.trim().toLowerCase();
  // 170cm / 170 cm
  const cmMatch = s.match(/(\d+\.?\d*)\s*cm/);
  if (cmMatch) return parseFloat(cmMatch[1]);
  // 5'7" or 5'7 or 5ft7in
  const ftMatch = s.match(/(\d+)\s*['ft]+\s*(\d+\.?\d*)/);
  if (ftMatch) {
    const ft = parseFloat(ftMatch[1]);
    const inches = parseFloat(ftMatch[2]);
    return Math.round((ft * 30.48) + (inches * 2.54));
  }
  // just a number → assume inches
  const num = parseFloat(s);
  if (!isNaN(num)) return num > 100 ? num : Math.round(num * 2.54);
  return null;
}

// ─── MACRO MATH ──────────────────────────────────────────────────
// Mifflin-St Jeor BMR → activity (downshifted 1 notch silently) → deficit → macros
function computeMacros(intake) {
  const lb = intake.weight_lb;
  if (!lb || !intake.age || !intake.gender) return { ok: false, reason: 'Missing weight/age/gender' };
  const kg = lb / 2.20462;
  const cm = parseHeightToCm(intake.height) || 170;
  const age = intake.age;

  const bmr = intake.gender === 'Male'
    ? (10 * kg) + (6.25 * cm) - (5 * age) + 5
    : (10 * kg) + (6.25 * cm) - (5 * age) - 161;

  // Activity multiplier — DOWNSHIFTED 1 notch (we trust clients over-estimate)
  const downshift = {
    sedentary: 1.2,   // stays
    light: 1.2,       // was 1.375
    moderate: 1.375,  // was 1.55
    heavy: 1.55,      // was 1.725
    athlete: 1.725,   // was 1.9
  };
  const mult = downshift[intake.activity] || 1.375;
  const tdee = bmr * mult;

  // Deficit based on goal magnitude + timeline
  let deficit = 0;
  if (intake.goal_type === 'fat-loss' || intake.goal_type === 'recomp') {
    const toLose = lb - (intake.goal_weight_lb || lb);
    if (toLose >= 50) deficit = 700;
    else if (toLose >= 30) deficit = 600;
    else if (toLose >= 15) deficit = 500;
    else deficit = 400;
  } else if (intake.goal_type === 'muscle') {
    deficit = -250; // small surplus
  }
  // maintain → no deficit

  const cal = Math.round(tdee - deficit);

  // Protein
  const proteinPerLb = intake.goal_type === 'muscle' ? 0.8 : 0.6;
  const proteinG = Math.round(lb * proteinPerLb);

  // Fat 28% of cal
  const fatG = Math.round((cal * 0.28) / 9);

  // Carbs = balance
  const carbsCal = cal - (proteinG * 4) - (fatG * 9);
  const carbsG = Math.max(50, Math.round(carbsCal / 4));

  return {
    ok: true,
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    activity_used: mult,
    declared_activity: intake.activity,
    deficit,
    caloricGoal: cal,
    proteinGrams: proteinG,
    carbsGrams: carbsG,
    fatGrams: fatG,
    proteinPercent: Math.round((proteinG * 4 / cal) * 100),
    carbsPercent: Math.round((carbsG * 4 / cal) * 100),
    fatPercent: Math.round((fatG * 9 / cal) * 100),
  };
}

// ─── WORKOUT SPLIT PICKER ────────────────────────────────────────
// Returns shape: { days, style, equipment_tier, notes }
async function selectSplit(intake, coachOverrides = '') {
  const anthropic = getAnthropic();
  const overrideBlock = coachOverrides
    ? `\n\n🔴 COACH OVERRIDES (ABSOLUTE — SUPERSEDE EVERY RULE BELOW):\n"""${coachOverrides}"""\nIf the coach specifies a different day count, split type, equipment restriction, or anything else, OBEY EXACTLY. Their word > the rules. Do not argue, do not default back to the locked split rules.\n`
    : '';
  const sys = `You are Zach Faerber's coaching system AI. Pick a Phase 1 workout split for this new client.${overrideBlock}

Output ONLY JSON:
{
  "days_per_week": 3 | 4 | 5 | 6,
  "split_name": "<short name e.g. 'Upper/Lower/Full' or 'PPL+Conditioning'>",
  "split_breakdown": ["Day 1: ...", "Day 2: ...", ...],
  "equipment_tier": "gym" | "home-weights" | "home-minimal" | "bw" | "mixed",
  "schedule_pattern": "<e.g. 'M/W/F mornings'>",
  "intensity": "deload" | "foundation" | "build" | "push",
  "injury_swaps": ["<short list of exercises to avoid + replacements>"],
  "rationale": "<one short sentence explaining the choice>"
}

Rules:
- Phase 1 = FOUNDATION (first 6 weeks). Default to 'foundation' intensity unless client clearly advanced.
- **HARD SPLIT RULES (locked):**
  - 3 days → Full Body × 3 (e.g. Full Body A / Full Body B / Full Body C w/ rotating focus)
  - 4 days → Upper / Lower / Upper / Lower
  - 5 days → Push / Pull / Legs / Accessories (Upper) / Accessories (Lower)
  - 6 days → PPL × 2 (Sonnet pick if needed)
- Beginner experience → max 4 days, never 6 (downshift if needed)
- Advanced → can use 5-6 days
- 5lb DBs only or pure BW → no barbell movements
- Injuries listed → propose specific swaps (e.g. "back issues → swap BB squat for goblet squat / leg press")
- If equipment is just "bodyweight" or minimal → bodyweight progression-focused split
- If client checks any of: pregnant, postpartum, heart condition, autoimmune flare → default to 3 days max + 'deload' intensity + note "human review required"`;

  const user = `# Client intake summary
- Name: ${intake.full_name}
- Age: ${intake.age}, gender: ${intake.gender}, weight: ${intake.weight_lb}lb
- Goal type: ${intake.goal_type}
- History: ${intake.history_level}
- Experience: ${intake.experience}
- Activity: ${intake.activity}
- Train days (authoritative — schedule on EXACTLY these): ${(intake.raw_payload?.train_days || []).join(', ') || 'not specified'}
- Time of day notes: ${intake.availability}
- Train where: ${(intake.train_where || []).join(', ')}
- Equipment: ${intake.equipment}
- Feel strong with: ${intake.feel_strong}
- Injuries / avoid: ${intake.injuries}
- Health flags: ${(intake.flags || []).join(', ') || 'none'}
- Other conditions: ${intake.other_condition || 'none'}

Output the JSON spec now.`;

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: sys,
      messages: [{ role: 'user', content: user }],
    });
    const text = resp.content?.[0]?.text || '';
    const s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s < 0 || e < 0) return { ok: false, error: 'No JSON in response' };
    return { ok: true, ...JSON.parse(text.slice(s, e + 1)) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── TRAINERIZE USER CREATION ─────────────────────────────────────
async function createTrainerizeUser(intake) {
  const { firstName, lastName } = splitFullName(intake.full_name);
  // First check: does a user with this email already exist in Trainerize?
  try {
    const list = await tzPost('/user/getList', { count: 500 });
    const existing = (list.data?.users || []).find(u => (u.email || '').toLowerCase() === intake.email.toLowerCase());
    if (existing?.id) {
      return { ok: true, userID: existing.id, welcomeEmailSent: false, _reused: true };
    }
  } catch {}
  const r = await tzPost('/user/add', {
    user: {
      firstName,
      lastName,
      email: intake.email.toLowerCase(),
      password: DEFAULT_PASSWORD,
      type: 'client',
    },
  });
  if (!r.ok || r.data?.code !== '0' || !r.data?.userID) {
    return { ok: false, error: r.data?.message || r.text };
  }
  // Send welcome email — Trainerize includes password setup link
  const userID = r.data.userID;
  const w = await tzPost('/user/sendWelcomeEmail', { userID });
  if (!w.ok || w.data?.code !== '0') {
    console.warn(`[trainerize] welcome email failed for ${userID}:`, w.text);
  }
  return { ok: true, userID, welcomeEmailSent: w.ok && w.data?.code === '0' };
}

// ─── MONDAY DOC CONTENT ───────────────────────────────────────────
function buildMondayMarkdown({ intake, macros, split, flags }) {
  const fmt = v => v == null || v === '' ? '—' : String(v);
  const flagBadge = flags.length ? `\n\n> ⚠️ **HUMAN REVIEW REQUIRED**\n> Flags: ${flags.join(', ')}\n` : '';

  return `# ${intake.full_name} — Claude Notes

${flagBadge}

## Client Overview

- Email: ${fmt(intake.email)}
- Phone: ${fmt(intake.phone)}
- Age: ${fmt(intake.age)} · Gender: ${fmt(intake.gender)}
- Location: ${fmt(intake.city)} · ${fmt(intake.timezone)}
- Submitted intake: ${new Date(intake.submitted_at).toLocaleString()}

## Goals

- Current weight: ${fmt(intake.weight_lb)}lb · Goal: ${fmt(intake.goal_weight_lb)}lb · By ${fmt(intake.deadline)}
- Goal type: ${fmt(intake.goal_type)}
- Why now: ${fmt(intake.why_now)}

## Macros (auto-computed)

- **${macros.caloricGoal} cal / ${macros.proteinGrams}g P / ${macros.carbsGrams}g C / ${macros.fatGrams}g F**
- BMR: ${macros.bmr} · TDEE: ${macros.tdee} (activity ${macros.activity_used}× — downshifted from declared ${macros.declared_activity})
- Deficit applied: ${macros.deficit}
- Protein ratio: ${(intake.goal_type === 'muscle' ? 0.8 : 0.6)} × ${intake.weight_lb}lb

## Workout Plan (Phase 1, draft for review)

- Days/week: ${split.days_per_week}
- Split: ${split.split_name}
- Equipment tier: ${split.equipment_tier}
- Schedule pattern: ${split.schedule_pattern}
- Intensity: ${split.intensity}
- Breakdown:
${(split.split_breakdown || []).map(d => `  - ${d}`).join('\n')}

- Injury swaps:
${(split.injury_swaps || []).map(s => `  - ${s}`).join('\n') || '  - none'}

- Rationale: ${split.rationale}

## Training Context

- History: ${fmt(intake.history_level)}
- Experience: ${fmt(intake.experience)}
- Declared activity: ${fmt(intake.activity)}
- Availability: ${fmt(intake.availability)}
- Trains at: ${(intake.train_where || []).join(', ') || '—'}
- Equipment: ${fmt(intake.equipment)}
- Feels strong with: ${fmt(intake.feel_strong)}
- Injuries / avoids: ${fmt(intake.injuries)}

## Health Flags

- Critical: ${(intake.flags || []).join(', ') || 'none'}
- Other conditions: ${fmt(intake.other_condition)}
- Meds + supplements: ${fmt(intake.meds)}

## Nutrition Context

- Relationship w/ food: ${fmt(intake.food_relationship)}
- Foods love (include): ${fmt(intake.food_love)}
- Foods avoid (exclude): ${fmt(intake.food_avoid)}
- Typical weekday meals: ${fmt(intake.typical_day)}

## Lifestyle

- Sleep: ${fmt(intake.sleep_hrs)}h · Quality: ${fmt(intake.sleep_quality)}
- Stress: ${fmt(intake.stress)}
- Typical weekday: ${fmt(intake.typical_weekday)}

## Coaching Preferences

- Tone: ${fmt(intake.coaching_tone)}
- Anything else: ${fmt(intake.anything_else)}

## Referral

- Name: ${fmt(intake.referral_name)}
- Phone: ${fmt(intake.referral_phone)}

## Session Notes

- **${new Date().toISOString().slice(0, 10)}:** Intake submitted via form. Trainerize user created w/ welcome123. Macros + split drafted by Sonnet. **${flags.length ? 'NEEDS HUMAN REVIEW before workouts push.' : 'Ready for Zach approval — workouts not yet pushed to calendar.'}**

---

## FULL INTAKE ANSWERS (verbatim — copy/paste into Trainerize)

**Step 1 · About you**
- Full name: ${fmt(intake.full_name)}
- Email: ${fmt(intake.email)}
- Phone: ${fmt(intake.phone)}
- Age: ${fmt(intake.age)}
- Biological sex: ${fmt(intake.gender)}
- City + state: ${fmt(intake.city)}
- Timezone: ${fmt(intake.timezone)}
- Weight unit: ${fmt(intake.weight_unit)}

**Step 2 · Goal**
- Current weight: ${fmt(intake.weight_lb)} lb
- Height: ${fmt(intake.height)}
- Goal weight: ${fmt(intake.goal_weight_lb)} lb
- Target date: ${fmt(intake.deadline)}
- Why now: ${fmt(intake.why_now)}
- Goal type: ${fmt(intake.goal_type)}

**Step 3 · Training reality**
- Exercise history: ${fmt(intake.history_level)}
- Experience: ${fmt(intake.experience)}
- Activity level (declared): ${fmt(intake.activity)}
- Train days: ${(intake.raw_payload?.train_days || []).join(', ') || '—'}
- Time of day / constraints: ${fmt(intake.availability)}
- Where you train: ${(intake.train_where || []).join(', ') || '—'}
- Equipment you ALWAYS have: ${fmt(intake.equipment)}
- Workouts that make you feel STRONG: ${fmt(intake.feel_strong)}
- Injuries / movements you avoid: ${fmt(intake.injuries)}

**Step 4 · Health flags**
- Critical flags: ${(intake.flags || []).join(', ') || 'none'}
- Other conditions: ${fmt(intake.other_condition)}
- Meds + supplements: ${fmt(intake.meds)}

**Step 5 · Food**
- Relationship w/ food + trigger: ${fmt(intake.food_relationship)}
- Foods LOVE (include): ${fmt(intake.food_love)}
- Foods AVOID (exclude): ${fmt(intake.food_avoid)}
- Typical weekday eating: ${fmt(intake.typical_day)}

**Step 6 · Lifestyle + coaching**
- Sleep hours: ${fmt(intake.sleep_hrs)}
- Sleep quality: ${fmt(intake.sleep_quality)}
- Stress level: ${fmt(intake.stress)}
- Typical weekday: ${fmt(intake.typical_weekday)}
- Coaching tone preference: ${fmt(intake.coaching_tone)}
- Anything else: ${fmt(intake.anything_else)}

**Referral (optional)**
- Name: ${fmt(intake.referral_name)}
- Phone: ${fmt(intake.referral_phone)}
`;
}

// ─── MAIN PIPELINE ───────────────────────────────────────────────
async function processIntakeSubmission({ supabase, intake_id, existingTrainerizeUserId = null }) {
  const log = (msg, data) => console.log(`[intake:${intake_id}] ${msg}`, data || '');

  // 1. Load intake row
  const { data: intake, error: intakeErr } = await supabase
    .from('intake_submissions')
    .select('*')
    .eq('id', intake_id)
    .single();
  if (intakeErr || !intake) throw new Error(`Intake ${intake_id} not found: ${intakeErr?.message}`);

  // 2. Create pending_onboardings row
  const { data: pending, error: pErr } = await supabase
    .from('pending_onboardings')
    .insert({
      intake_submission_id: intake.id,
      client_email: intake.email,
      client_name: intake.full_name,
      status: 'intake_received',
      pipeline_log: [{ step: 'received', at: new Date().toISOString() }],
    })
    .select()
    .single();
  if (pErr) throw new Error(`Failed to create pending: ${pErr.message}`);
  const pendingId = pending.id;

  const updatePending = async (patch) => {
    await supabase.from('pending_onboardings').update(patch).eq('id', pendingId);
  };
  const appendLog = async (step, info = {}) => {
    const entry = { step, at: new Date().toISOString(), ...info };
    const { data } = await supabase.from('pending_onboardings').select('pipeline_log').eq('id', pendingId).single();
    const newLog = [...(data?.pipeline_log || []), entry];
    await supabase.from('pending_onboardings').update({ pipeline_log: newLog }).eq('id', pendingId);
  };

  try {
    // 3. Flag risky clients
    const flags = (intake.flags || []).filter(f => REVIEW_FLAGS.includes(f));
    const needsReview = flags.length > 0;
    log('flags detected', flags);

    // 4. Trainerize user — create new OR use existing
    let tzResult;
    if (existingTrainerizeUserId) {
      tzResult = { ok: true, userID: existingTrainerizeUserId, welcomeEmailSent: false };
      log('using existing Trainerize user', existingTrainerizeUserId);
      await appendLog('trainerize_existing', { userID: existingTrainerizeUserId });
    } else {
      log('creating Trainerize user');
      tzResult = await createTrainerizeUser(intake);
      if (!tzResult.ok) {
        await updatePending({ status: 'failed', review_reason: `Trainerize create failed: ${tzResult.error}` });
        await appendLog('trainerize_create_failed', { error: tzResult.error });
        throw new Error(`Trainerize: ${tzResult.error}`);
      }
      await appendLog('trainerize_created', { userID: tzResult.userID });
      log('trainerize user created', tzResult.userID);
    }
    await updatePending({ trainerize_user_id: tzResult.userID, status: 'trainerize_created' });

    // 5. Compute macros
    log('computing macros');
    const macros = computeMacros(intake);
    if (!macros.ok) {
      await updatePending({ status: 'needs_review', needs_human_review: true, review_reason: `Macro calc: ${macros.reason}` });
      await appendLog('macros_failed', { reason: macros.reason });
      return { ok: true, pendingId, status: 'needs_review', reason: macros.reason };
    }
    await updatePending({ computed_macros: macros, status: 'macros_computed' });
    await appendLog('macros_computed', { caloricGoal: macros.caloricGoal, proteinGrams: macros.proteinGrams });
    log('macros', `${macros.caloricGoal} cal / ${macros.proteinGrams}P`);

    // 6. Pick workout split via Sonnet
    log('selecting workout split');
    const split = await selectSplit(intake);
    if (!split.ok) {
      await updatePending({ status: 'needs_review', needs_human_review: true, review_reason: `Split selection failed: ${split.error}` });
      await appendLog('split_failed', { error: split.error });
      return { ok: true, pendingId, status: 'needs_review', reason: split.error };
    }
    await updatePending({ selected_split: split, status: 'workouts_built' });
    await appendLog('split_chosen', { days: split.days_per_week, name: split.split_name });
    log('split chosen', split.split_name);

    // 7. Calculate "starts on" (next Monday)
    const today = new Date();
    const nextMon = new Date(today);
    const daysUntilMon = ((1 - today.getDay()) + 7) % 7 || 7;
    nextMon.setDate(today.getDate() + daysUntilMon);
    const startsOn = nextMon.toISOString().slice(0, 10);
    await updatePending({ starts_on: startsOn });

    // 8. Create Monday Coach Board item + Notes Doc (skip if no API key)
    const mondayMd = buildMondayMarkdown({ intake, macros, split, flags });
    let itemId = null;

    const mondayKey = process.env.MONDAY_API_KEY || process.env.MONDAY_API_TOKEN;
    // Skip Monday for test submissions (Zach's own email or name starts with "Test")
    const isTest = intake.email === 'zacharyfaerber@gmail.com'
      || /^test/i.test(intake.full_name)
      || intake.email.includes('+test');
    // Skip Monday if existing client (paste-onboard) — they already have an item
    const isExistingClient = !!existingTrainerizeUserId;
    if (!mondayKey) {
      log('MONDAY_API_KEY missing — skipping Monday item create');
      await appendLog('monday_skipped', { reason: 'MONDAY_API_KEY not set' });
    } else if (isTest) {
      log('test submission — skipping Monday item create');
      await appendLog('monday_skipped', { reason: 'test submission detected' });
    } else if (isExistingClient) {
      log('existing client (paste-onboard) — skipping Monday item create to avoid duplicate');
      await appendLog('monday_skipped', { reason: 'existing client paste-onboard' });
    } else {
      const mondayPost = (query) => fetch('https://api.monday.com/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': mondayKey },
        body: JSON.stringify({ query }),
      }).then(r => r.json());

      // First check if Monday already has a matching item for this name → REUSE
      log('checking Monday for existing item');
      const nameEsc = intake.full_name.replace(/"/g, '\\"');
      const searchJson = await mondayPost(`query { items_page_by_column_values(board_id: ${COACH_BOARD_ID}, columns: [{ column_id: "name", column_values: ["${nameEsc}"] }]) { items { id } } }`);
      const existingItems = searchJson?.data?.items_page_by_column_values?.items || [];
      if (existingItems.length) {
        itemId = existingItems[0].id;
        log('Monday item already exists — reusing', itemId);
        await updatePending({ monday_item_id: String(itemId) });
        await appendLog('monday_item_reused', { itemId, found: existingItems.length });
      } else {

      log('creating Monday item');
      const itemEsc = intake.full_name.replace(/"/g, '\\"');
      const itemJson = await mondayPost(`mutation { create_item (board_id: ${COACH_BOARD_ID}, item_name: "${itemEsc}", create_labels_if_missing: true) { id } }`);
      itemId = itemJson?.data?.create_item?.id;
      if (!itemId) {
        log('Monday item create failed', itemJson);
        await appendLog('monday_item_failed', { error: JSON.stringify(itemJson).slice(0, 500) });
      } else {
        await updatePending({ monday_item_id: String(itemId) });
        await appendLog('monday_item_created', { itemId });

        // Create empty doc attached to item — capture URL + ID for review surface
        const docJson = await mondayPost(`mutation { create_doc (location: { board: { item_id: ${itemId}, column_id: "${NOTES_DOC_COLUMN_ID}" } }) { id object_id url } }`);
        const docId = docJson?.data?.create_doc?.object_id || docJson?.data?.create_doc?.id;
        if (docId) {
          await updatePending({ monday_doc_id: String(docId), status: 'monday_doc_written' });
          await appendLog('monday_doc_created', { docId });
        } else {
          await appendLog('monday_doc_create_failed', { resp: JSON.stringify(docJson).slice(0, 400) });
        }

        // Mirror the full markdown as an UPDATE (item comment) — always visible on the board
        const updateBodyHtml = mondayMd
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/^# (.+)$/gm, '<h1>$1</h1>')
          .replace(/^## (.+)$/gm, '<h2>$1</h2>')
          .replace(/^### (.+)$/gm, '<h3>$1</h3>')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/^- (.+)$/gm, '<li>$1</li>')
          .replace(/(<li>.*<\/li>\n?)+/gs, m => `<ul>${m}</ul>`)
          .replace(/\n\n/g, '<br><br>');
        const updateBodyEsc = updateBodyHtml.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
        const updateJson = await mondayPost(`mutation { create_update (item_id: ${itemId}, body: "${updateBodyEsc}") { id } }`);
        const updateId = updateJson?.data?.create_update?.id;
        if (updateId) {
          await appendLog('monday_update_posted', { updateId, len: mondayMd.length });
        } else {
          await appendLog('monday_update_failed', { resp: JSON.stringify(updateJson).slice(0, 400) });
        }
      }
      } // end "else create new item" branch
    }

    // 9. Mark ready for review
    const finalStatus = needsReview ? 'needs_review' : 'ready_for_review';
    await updatePending({
      status: finalStatus,
      flags,
      needs_human_review: needsReview,
      review_reason: needsReview ? `Critical health flag(s): ${flags.join(', ')}` : null,
    });
    await appendLog('pipeline_complete', { final_status: finalStatus });

    log('pipeline complete', finalStatus);
    return {
      ok: true,
      pendingId,
      status: finalStatus,
      trainerize_user_id: tzResult.userID,
      macros,
      split,
      starts_on: startsOn,
      monday_item_id: itemId,
      notes_markdown: mondayMd,
      flags,
      needs_human_review: needsReview,
    };
  } catch (e) {
    log('pipeline error', e.message);
    await updatePending({ status: 'failed', review_reason: e.message });
    await appendLog('error', { message: e.message });
    return { ok: false, error: e.message, pendingId };
  }
}

export { processIntakeSubmission, computeMacros, selectSplit, createTrainerizeUser };
