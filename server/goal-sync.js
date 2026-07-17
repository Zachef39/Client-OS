// Coach OS Goal-Sync
// For each active client, evaluate goal trajectory and generate adjustment to-dos
// for off-track clients. Re-uses the executor's draftSpec for spec generation.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-6';

function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function summarizeWeightProgress(client, latestSnapshot) {
  const start = client.starting_weight_lbs;
  const target = client.goal_weight_lbs;
  if (!start || !target) return { hasGoal: false, summary: 'No weight goal locked' };

  const lost = start - (latestSnapshot?.weight_change_last_4wk != null ? start + latestSnapshot.weight_change_last_4wk : start);
  const totalToLose = start - target;
  const pctToGoal = totalToLose > 0 ? Math.round((lost / totalToLose) * 100) : 0;
  return {
    hasGoal: true,
    start,
    target,
    estLost4wk: latestSnapshot?.weight_change_last_4wk ?? null,
    totalToLose,
    pctToGoal,
    trajectory: latestSnapshot?.weight_trajectory || 'unknown',
    summary: `Start ${start} → Target ${target} (${totalToLose}lb to lose). 4wk change: ${latestSnapshot?.weight_change_last_4wk ?? '—'}lb. Trajectory: ${latestSnapshot?.weight_trajectory || 'unknown'}.`,
  };
}

function buildClientContext({ client, snapshot, checkin }) {
  const progress = summarizeWeightProgress(client, snapshot);
  return `## ${client.full_name}
- Trainerize ID: ${client.trainerize_user_id || '—'}
- Goal: ${client.goal || '—'}
- Weight: ${progress.summary}
- Current cal target: ${client.daily_calorie_target || '—'} / protein floor: ${client.daily_protein_target_g || '—'}g
- Status: ${client.client_status || 'Active'}
- Latest snapshot (${snapshot?.snapshot_date || 'n/a'}):
    Flag: ${snapshot?.flag_color || '—'}
    Workouts this wk: ${snapshot?.workouts_completed_this_week || 0}/${snapshot?.workouts_scheduled_this_week || 0}
    Days logged last 7: ${snapshot?.days_logged_last_7 || 0}
    Avg cal 7d: ${snapshot?.avg_calories_7d || '—'}
    Avg protein 7d: ${snapshot?.avg_protein_g_7d || '—'}g
    Log streak: ${snapshot?.log_streak_days || 0}d
- Latest check-in (${checkin?.checkin_date || 'n/a'}): tier=${checkin?.tier || '—'}
    Wins: ${(checkin?.wins || '—').slice(0, 200)}
    Struggles: ${(checkin?.struggles || '—').slice(0, 200)}
    Questions: ${(checkin?.questions || '—').slice(0, 200)}
- Notes excerpt: ${(client.notes || '—').slice(0, 400)}`;
}

const SYSTEM_PROMPT = `You are Zach Faerber's coaching ops AI. Your job: analyze a single client's goal vs current trajectory and decide if a coaching adjustment is needed.

Output ONLY valid JSON with this shape:
{
  "client_name": "<full name>",
  "on_track": true | false,
  "trajectory_summary": "<one short sentence summarizing where they are vs goal>",
  "recommendation": {
    "category": "calorie" | "workout" | "mealplan" | "check-in" | "call" | "other" | null,
    "note": "<concise to-do note in Zach's voice — what to do and why, 1-2 sentences>",
    "priority": "low" | "normal" | "high" | "urgent",
    "spec": { ... params shape per category, see below ... }
  } | null
}

When on_track=true, set recommendation=null.
When on_track=false, the recommendation should be the SINGLE highest-leverage adjustment to get them back on goal trajectory.

RULES:
- "on_track" means: trajectory aligned with goal AND flag_color is green/yellow.
- If trajectory='good' and they've made progress matching their timeline, on_track=true.
- If trajectory='bad' (gaining when goal is loss, or vice versa), on_track=false. Recommend the adjustment that moves them back.
- If they're plateaued (4wk change ~0lb) AND still have weight to lose, on_track=false. Recommend a calorie cut (~100-150 kcal) OR add a workout day, whichever matches their compliance pattern.
- If they're losing fast AND have low energy/poor sleep → recommend slight calorie BUMP (protect metabolism).
- If they're skipping workouts (flag=red, workouts_completed_this_week < 50% of scheduled), recommend a 'call' to figure out the blocker.
- If onboarding (start_date < 21 days ago), default to on_track=true unless major red flags. Foundation phase.

CATEGORY-SPECIFIC spec shapes (use exactly these):

calorie:
  { "userID": <trainerize_id as integer>, "caloricGoal": <num>, "proteinGrams": <num — keep current floor>, "reason": "<short>" }

call:
  { "userID": <trainerize_id as integer>, "message": "<warm Trainerize message in Zach's voice mentioning the trajectory + asking for a quick call to recalibrate. ALWAYS include the booking link: https://go.faerberfitness.com/widget/bookings/15zf>" }

check-in:
  { "userID": <trainerize_id as integer>, "message": "<warm coaching message in Zach's voice referencing their wins/struggles + a single behavioral nudge>" }

mealplan:
  { "client_slug": "<first_last lowercased>", "phase": "<Phase X>", "macros": { "caloricGoal": <num>, "proteinGrams": <num> }, "notes": "<context>" }

workout:
  { "action": "add" | "delete", "client_name": "<full>", "schedule_pattern": "<e.g. add 1 lift day Thu>", "confirm_required": true }

other:
  { "spawn_claude_prompt": "<full prompt to give Claude CLI to attack this task>" }

Use TRAINERIZE_ID as an INTEGER not string in the spec. If no trainerize_id, set on_track=true (can't act).`;

async function analyzeClient({ client, snapshot, checkin }) {
  if (!client.trainerize_user_id) return { client_name: client.full_name, on_track: true, trajectory_summary: 'No Trainerize ID — skipping', recommendation: null };
  const anthropic = getAnthropic();
  const userMsg = buildClientContext({ client, snapshot, checkin });
  try {
    const resp = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    });
    const text = resp.content?.[0]?.text || '';
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) return { error: 'No JSON in response', raw: text.slice(0, 400) };
    return JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    return { error: e.message };
  }
}

async function processOneClient({ client, supabase }) {
  // Latest snapshot
  const { data: snaps } = await supabase
    .from('daily_snapshots')
    .select('*')
    .eq('client_id', client.id)
    .order('snapshot_date', { ascending: false })
    .limit(1);
  const snapshot = snaps?.[0] || null;

  if (!snapshot) return { kind: 'skipped', client: client.full_name, reason: 'No snapshot data yet' };

  // Pre-filter: skip clients already green (saves a Sonnet call per green client)
  if (snapshot.flag_color === 'green') {
    return { kind: 'skipped', client: client.full_name, reason: 'Green flag — on track' };
  }

  // Latest check-in
  const { data: checkins } = await supabase
    .from('weekly_checkins')
    .select('*')
    .eq('client_id', client.id)
    .order('checkin_date', { ascending: false })
    .limit(1);
  const checkin = checkins?.[0] || null;

  // Skip if already has an open goal-sync to-do
  const { data: existing } = await supabase
    .from('coach_todos')
    .select('id')
    .eq('client_id', client.id)
    .eq('source', 'goal-sync')
    .eq('status', 'open')
    .limit(1);
  if (existing && existing.length) return { kind: 'skipped', client: client.full_name, reason: 'Has open goal-sync to-do' };

  const analysis = await analyzeClient({ client, snapshot, checkin });
  if (analysis.error) return { kind: 'error', client: client.full_name, error: analysis.error };
  if (analysis.on_track || !analysis.recommendation) return { kind: 'skipped', client: client.full_name, reason: 'On track', summary: analysis.trajectory_summary };

  const rec = analysis.recommendation;
  if (!rec.category) return { kind: 'skipped', client: client.full_name, reason: 'No category' };

  const spec = {
    executable: !!rec.spec,
    category: rec.category,
    params: rec.spec || {},
    confidence: 'medium',
    blockers: [],
    human_notes: analysis.trajectory_summary,
  };

  const { data: todo, error: todoErr } = await supabase
    .from('coach_todos')
    .insert({
      client_id: client.id,
      client_name: client.full_name,
      category: rec.category,
      note: rec.note,
      source: 'goal-sync',
      priority: rec.priority || 'normal',
      spec,
      execution_status: 'pending',
      context: { goal_sync: true, trajectory_summary: analysis.trajectory_summary, generated_at: new Date().toISOString() },
    })
    .select()
    .single();
  if (todoErr) return { kind: 'error', client: client.full_name, error: todoErr.message };
  return { kind: 'created', client: client.full_name, todo_id: todo.id, category: rec.category, summary: analysis.trajectory_summary };
}

async function generateGoalToDos({ supabase, onProgress }) {
  const { data: clients, error } = await supabase
    .from('clients')
    .select('*')
    .eq('is_active', true)
    .order('full_name');
  if (error) throw new Error(`Failed to load clients: ${error.message}`);

  const BATCH = 8; // parallel Sonnet calls
  const created = [], skipped = [], errors = [];

  for (let i = 0; i < clients.length; i += BATCH) {
    const batch = clients.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(c => processOneClient({ client: c, supabase }).catch(e => ({ kind: 'error', client: c.full_name, error: e.message }))));
    for (const r of results) {
      if (r.kind === 'created') created.push(r);
      else if (r.kind === 'skipped') skipped.push(r);
      else errors.push(r);
    }
    onProgress?.({ done: i + batch.length, total: clients.length });
  }

  return { total_clients: clients.length, created, skipped, errors };
}

export { generateGoalToDos };
