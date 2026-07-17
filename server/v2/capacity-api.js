// Coach Capacity API — Phase 4
// Reads: coach_capacity view, clients, weekly_checkins, client_notes, coach_settings.
// Writes: coach_settings.max_capacity, clients.assigned_coach.

const UNASSIGNED = '(unassigned)';

// ─── helpers ───
function normCoach(name) {
  if (!name || String(name).trim() === '') return UNASSIGNED;
  return String(name).trim();
}

async function listActiveCoaches(supabase) {
  // Coaches from the view (has assigned + unassigned bucket).
  const { data, error } = await supabase
    .from('coach_capacity')
    .select('coach_name, active_clients, max_capacity, pct_full')
    .order('active_clients', { ascending: false });
  if (error) throw error;
  return (data || []).map(c => ({
    coach_name: c.coach_name,
    active_clients: Number(c.active_clients || 0),
    max_capacity: Number(c.max_capacity || 15),
    pct_full: Number(c.pct_full || 0),
  }));
}

async function lastCheckinByClient(supabase, clientIds) {
  if (!clientIds.length) return {};
  const { data, error } = await supabase
    .from('weekly_checkins')
    .select('client_id, checkin_date, tier')
    .in('client_id', clientIds)
    .order('checkin_date', { ascending: false });
  if (error) throw error;
  const latest = {};
  for (const row of data || []) {
    if (!latest[row.client_id]) {
      latest[row.client_id] = { checkin_date: row.checkin_date, tier: row.tier || null };
    }
  }
  return latest;
}

async function lastNoteByClient(supabase, clientIds) {
  if (!clientIds.length) return {};
  const { data, error } = await supabase
    .from('client_notes')
    .select('client_id, created_at')
    .in('client_id', clientIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const latest = {};
  for (const row of data || []) {
    if (!latest[row.client_id]) latest[row.client_id] = row.created_at;
  }
  return latest;
}

function tierFromCountdown(daysUntil) {
  if (daysUntil == null) return 'unknown';
  if (daysUntil <= 7) return 'critical';
  if (daysUntil <= 21) return 'urgent';
  if (daysUntil <= 30) return 'watch';
  return 'ok';
}

// ─── routes ───
export function registerCapacityRoutes({ app, supabase }) {

  // GET /api/v2/capacity/summary
  app.get('/api/v2/capacity/summary', async (_req, res) => {
    try {
      const coaches = await listActiveCoaches(supabase);

      const active = coaches.filter(c => c.coach_name !== UNASSIGNED && c.active_clients > 0);
      const at80 = active.filter(c => c.pct_full >= 80 && c.pct_full < 100).length;
      const at100 = active.filter(c => c.pct_full >= 100).length;
      const unassignedRow = coaches.find(c => c.coach_name === UNASSIGNED);

      res.json({
        totals: {
          total_coaches: active.length,
          coaches_at_80: at80,
          coaches_at_100: at100,
          unassigned_clients: unassignedRow ? unassignedRow.active_clients : 0,
        },
        coaches: coaches.map(c => ({
          ...c,
          status: c.coach_name === UNASSIGNED
            ? 'unassigned'
            : c.pct_full >= 100 ? 'critical'
            : c.pct_full >= 80 ? 'warning'
            : 'ok',
        })),
      });
    } catch (e) {
      console.error('[capacity/summary]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v2/capacity/:coach/clients
  app.get('/api/v2/capacity/:coach/clients', async (req, res) => {
    const coach = decodeURIComponent(req.params.coach);
    try {
      let q = supabase
        .from('clients')
        .select('id, full_name, assigned_coach, is_active, start_date, monday_item_id')
        .eq('is_active', true)
        .order('full_name', { ascending: true });

      if (coach === UNASSIGNED) {
        q = q.is('assigned_coach', null);
      } else {
        q = q.eq('assigned_coach', coach);
      }
      const { data: rows, error } = await q;
      if (error) throw error;

      const clientIds = (rows || []).map(r => r.id);

      // Parallel: last check-in + countdown tier
      const [checkins, { data: countdown }] = await Promise.all([
        lastCheckinByClient(supabase, clientIds),
        supabase.from('client_countdown')
          .select('id, days_until_resign, tier, programmed_to')
          .in('id', clientIds.length ? clientIds : ['00000000-0000-0000-0000-000000000000']),
      ]);

      const countdownById = {};
      for (const c of countdown || []) countdownById[c.id] = c;

      const clients = (rows || []).map(r => {
        const cd = countdownById[r.id] || {};
        const ci = checkins[r.id] || {};
        return {
          id: r.id,
          full_name: r.full_name,
          assigned_coach: r.assigned_coach,
          start_date: r.start_date,
          last_checkin_date: ci.checkin_date || null,
          last_checkin_tier: ci.tier || null,
          days_until_resign: cd.days_until_resign ?? null,
          tier: cd.tier || tierFromCountdown(cd.days_until_resign),
          programmed_to: cd.programmed_to || null,
        };
      });

      res.json({ coach, count: clients.length, clients });
    } catch (e) {
      console.error('[capacity/:coach/clients]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/v2/capacity/:coach/load-trend?days=90
  // Weekly active-client counts. "Active" = start_date <= week_end AND (still active OR updated_at > week_end).
  // We approximate w/ start_date only since we lack a churn timestamp — surfaces onboard cadence.
  app.get('/api/v2/capacity/:coach/load-trend', async (req, res) => {
    const coach = decodeURIComponent(req.params.coach);
    const days = Math.max(14, Math.min(365, Number(req.query.days) || 90));
    try {
      let q = supabase
        .from('clients')
        .select('start_date, is_active, assigned_coach');
      if (coach === UNASSIGNED) q = q.is('assigned_coach', null);
      else q = q.eq('assigned_coach', coach);
      const { data: rows, error } = await q;
      if (error) throw error;

      // Build weekly buckets — last N days, week-ending on today.
      const now = new Date();
      const buckets = [];
      const weeks = Math.ceil(days / 7);
      for (let i = weeks - 1; i >= 0; i--) {
        const end = new Date(now);
        end.setDate(end.getDate() - i * 7);
        buckets.push({ end: end.toISOString().slice(0, 10), count: 0 });
      }

      for (const r of rows || []) {
        if (!r.start_date) continue;
        for (const b of buckets) {
          if (r.start_date <= b.end && r.is_active) b.count += 1;
        }
      }

      res.json({ coach, days, buckets });
    } catch (e) {
      console.error('[capacity/:coach/load-trend]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v2/capacity/:coach/max  { max_capacity: number }
  app.post('/api/v2/capacity/:coach/max', async (req, res) => {
    const coach = decodeURIComponent(req.params.coach);
    const max = Number(req.body?.max_capacity);
    if (!Number.isFinite(max) || max < 1 || max > 500) {
      return res.status(400).json({ error: 'max_capacity must be 1-500' });
    }
    if (coach === UNASSIGNED) {
      return res.status(400).json({ error: 'cannot set capacity on unassigned bucket' });
    }
    try {
      const { error } = await supabase
        .from('coach_settings')
        .upsert({ coach_name: coach, max_capacity: max, updated_at: new Date().toISOString() }, { onConflict: 'coach_name' });
      if (error) throw error;
      res.json({ ok: true, coach, max_capacity: max });
    } catch (e) {
      console.error('[capacity/:coach/max]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/v2/capacity/reassign  { client_id, from_coach, to_coach }
  app.post('/api/v2/capacity/reassign', async (req, res) => {
    const { client_id, from_coach, to_coach } = req.body || {};
    if (!client_id || !to_coach) {
      return res.status(400).json({ error: 'client_id and to_coach required' });
    }
    try {
      const newCoach = to_coach === UNASSIGNED || to_coach === '' ? null : String(to_coach).trim();

      // Verify current coach matches (guardrail against stale UI overwrites)
      const { data: current, error: getErr } = await supabase
        .from('clients')
        .select('id, assigned_coach, full_name')
        .eq('id', client_id)
        .maybeSingle();
      if (getErr) throw getErr;
      if (!current) return res.status(404).json({ error: 'client not found' });

      const currentNorm = normCoach(current.assigned_coach);
      const fromNorm = normCoach(from_coach);
      if (from_coach !== undefined && from_coach !== null && fromNorm !== currentNorm) {
        return res.status(409).json({
          error: 'coach mismatch — refresh and retry',
          current: current.assigned_coach,
          expected: from_coach,
        });
      }

      const { error: updErr } = await supabase
        .from('clients')
        .update({ assigned_coach: newCoach, updated_at: new Date().toISOString() })
        .eq('id', client_id);
      if (updErr) throw updErr;

      res.json({ ok: true, client_id, full_name: current.full_name, from: current.assigned_coach, to: newCoach });
    } catch (e) {
      console.error('[capacity/reassign]', e);
      res.status(500).json({ error: e.message });
    }
  });
}
