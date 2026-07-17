// Coach Capacity tab — Phase 4
// Live headcount vs max, per-coach drill-down, reassignment, unassigned queue.
import { api, fmt, KPI, Card, Sparkline, StatusPill, EmptyState, escapeHtml, KPISkeleton, toast } from '../app.js';

const UNASSIGNED = '(unassigned)';

// ─── state ───
let selectedCoach = null;
let cachedSummary = null;

// ─── entrypoint ───
export async function renderCapacity(root) {
  root.innerHTML = KPISkeleton(3);

  let summary;
  try {
    summary = await api('/api/v2/capacity/summary');
  } catch (err) {
    root.innerHTML = renderError(err);
    return;
  }
  cachedSummary = summary;

  const assignedCoaches = summary.coaches.filter(c => c.coach_name !== UNASSIGNED);
  if (assignedCoaches.length && (!selectedCoach || !summary.coaches.find(c => c.coach_name === selectedCoach))) {
    selectedCoach = assignedCoaches[0].coach_name;
  }

  root.innerHTML = `
    <div class="kpi-grid" data-capacity-kpis>
      ${KPI({
        label: 'Active Coaches',
        value: fmt.int(summary.totals.total_coaches),
        sub: summary.totals.total_coaches > 0
          ? `${summary.totals.total_coaches} coach${summary.totals.total_coaches === 1 ? '' : 'es'} carrying load`
          : 'No coach assignments yet.',
      })}
      ${warnKPI({
        label: 'Coaches at 80%+',
        value: summary.totals.coaches_at_80,
        tone: summary.totals.coaches_at_80 > 0 ? 'yellow' : 'ok',
        sub: summary.totals.coaches_at_80 > 0 ? 'Nearing cap — plan next hire.' : 'Everyone has room.',
      })}
      ${warnKPI({
        label: 'Coaches at 100%+',
        value: summary.totals.coaches_at_100,
        tone: summary.totals.coaches_at_100 > 0 ? 'red' : 'ok',
        sub: summary.totals.coaches_at_100 > 0 ? 'Hire signal — overloaded now.' : 'No one over cap.',
      })}
    </div>

    <div class="row wide" data-capacity-body>
      <div data-capacity-bars>
        ${Card({
          title: 'Coach load',
          meta: 'Fill bars vs max · click to drill down',
          body: renderCoachBars(assignedCoaches),
        })}
      </div>
      <div data-capacity-drill>
        ${Card({
          title: selectedCoach ? `${selectedCoach}'s roster` : 'Select a coach',
          meta: selectedCoach ? 'Loading…' : 'Drill down',
          body: selectedCoach ? renderDrillLoading() : EmptyState({ title: 'No coach selected.', message: 'Click a coach card to see their clients and load trend.' }),
        })}
      </div>
    </div>

    <div data-capacity-unassigned>
      ${renderUnassignedCard(summary.totals.unassigned_clients)}
    </div>
  `;

  bindCoachBars(root);
  if (selectedCoach) refreshDrilldown(root);
  if (summary.totals.unassigned_clients > 0) loadUnassigned(root, summary);
}

// ─── KPI variants ───
function warnKPI({ label, value, tone, sub }) {
  const color = tone === 'red' ? 'var(--red)' : tone === 'yellow' ? 'var(--yellow)' : 'var(--ink)';
  return `
    <article class="kpi">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="kpi-value" style="color: ${color};">${fmt.int(value)}</div>
      <div class="kpi-sub">${escapeHtml(sub)}</div>
    </article>
  `;
}

// ─── coach bars ───
function renderCoachBars(coaches) {
  if (!coaches.length) {
    return EmptyState({
      icon: '◔',
      title: 'No coach assignments yet.',
      message: 'Fill `assigned_coach` on the clients table to populate. 61 clients are currently unassigned (see below).',
    });
  }
  return `
    <div class="coach-bars">
      ${coaches.map(c => coachRow(c)).join('')}
    </div>
    <style>
      .coach-bars { display: flex; flex-direction: column; gap: 12px; }
      .coach-row {
        display: grid; grid-template-columns: 1fr auto; gap: 6px;
        padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-md);
        background: var(--cream); cursor: pointer; transition: all var(--dur-fast) var(--ease);
      }
      .coach-row:hover { border-color: var(--line-2); background: var(--cream-2); }
      .coach-row.selected { border-color: var(--mauve); background: var(--mauve-tint); box-shadow: var(--shadow-1); }
      .coach-row-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .coach-row-name { font-weight: 600; color: var(--ink); font-size: var(--f-md); }
      .coach-row-count { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px; color: var(--muted); }
      .coach-row-count .pct { color: var(--mauve-2); font-weight: 600; margin-left: 6px; }
      .coach-row-actions { display: flex; align-items: center; gap: 8px; }
      .coach-fill-track { height: 8px; background: var(--cream-3); border-radius: 999px; overflow: hidden; }
      .coach-fill-bar { height: 100%; border-radius: 999px; transition: width var(--dur-med) var(--ease); }
      .coach-edit-btn {
        background: transparent; border: 0; color: var(--dim); cursor: pointer;
        font-size: 13px; padding: 2px 6px; border-radius: 4px;
      }
      .coach-edit-btn:hover { background: var(--cream-3); color: var(--ink); }
      .coach-max-input {
        width: 54px; padding: 2px 6px; font-size: 12px;
        border: 1px solid var(--mauve); border-radius: 4px;
        background: white; font-family: 'JetBrains Mono', ui-monospace, monospace;
      }
    </style>
  `;
}

function coachRow(c) {
  const pct = Math.max(3, Math.min(100, c.pct_full));
  const color = c.pct_full >= 100 ? 'var(--red)' : c.pct_full >= 80 ? 'var(--yellow)' : 'var(--green)';
  const isSelected = c.coach_name === selectedCoach ? 'selected' : '';
  return `
    <div class="coach-row ${isSelected}" data-coach="${escapeHtml(c.coach_name)}">
      <div>
        <div class="coach-row-head">
          <div class="coach-row-name">${escapeHtml(c.coach_name)}</div>
          <div class="coach-row-count" data-count-for="${escapeHtml(c.coach_name)}">
            ${c.active_clients} / <span data-max>${c.max_capacity}</span>
            <span class="pct">${c.pct_full}%</span>
          </div>
        </div>
        <div class="coach-fill-track" style="margin-top: 8px;">
          <div class="coach-fill-bar" style="width: ${pct}%; background: ${color};"></div>
        </div>
      </div>
      <div class="coach-row-actions">
        <button class="coach-edit-btn" data-edit-max="${escapeHtml(c.coach_name)}" title="Edit max capacity">✎</button>
      </div>
    </div>
  `;
}

function bindCoachBars(root) {
  root.querySelectorAll('.coach-row').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('.coach-edit-btn') || e.target.closest('.coach-max-input')) return;
      const coach = row.dataset.coach;
      selectedCoach = coach;
      root.querySelectorAll('.coach-row').forEach(r => r.classList.toggle('selected', r.dataset.coach === coach));
      refreshDrilldown(root);
    });
  });

  root.querySelectorAll('[data-edit-max]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const coach = btn.dataset.editMax;
      openMaxEditor(root, coach);
    });
  });
}

function openMaxEditor(root, coach) {
  const countEl = root.querySelector(`[data-count-for="${cssEscape(coach)}"]`);
  if (!countEl) return;
  const currentMax = Number(countEl.querySelector('[data-max]')?.textContent || 15);
  countEl.innerHTML = `
    <input type="number" class="coach-max-input" value="${currentMax}" min="1" max="500" />
  `;
  const input = countEl.querySelector('input');
  input.focus();
  input.select();

  const commit = async () => {
    const newMax = Number(input.value);
    if (!Number.isFinite(newMax) || newMax < 1 || newMax > 500) {
      toast('Max must be 1-500');
      renderCapacity(root.closest('#tab-root') || root);
      return;
    }
    try {
      await api(`/api/v2/capacity/${encodeURIComponent(coach)}/max`, {
        method: 'POST',
        body: { max_capacity: newMax },
      });
      toast(`${coach}: max = ${newMax}`);
      renderCapacity(root.closest('#tab-root') || root);
    } catch (err) {
      toast(`Failed: ${err.message}`);
      renderCapacity(root.closest('#tab-root') || root);
    }
  };

  input.addEventListener('blur', commit, { once: true });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') { renderCapacity(root.closest('#tab-root') || root); }
  });
}

// ─── drilldown ───
function renderDrillLoading() {
  return `<div class="skeleton" style="height: 240px; border-radius: var(--r-md);"></div>`;
}

async function refreshDrilldown(root) {
  const container = root.querySelector('[data-capacity-drill]');
  if (!container || !selectedCoach) return;

  container.innerHTML = Card({
    title: `${selectedCoach}'s roster`,
    meta: 'Loading…',
    body: renderDrillLoading(),
  });

  try {
    const [clientsRes, trendRes] = await Promise.all([
      api(`/api/v2/capacity/${encodeURIComponent(selectedCoach)}/clients`),
      api(`/api/v2/capacity/${encodeURIComponent(selectedCoach)}/load-trend?days=90`),
    ]);

    const trendValues = (trendRes.buckets || []).map(b => b.count);
    const otherCoaches = (cachedSummary?.coaches || [])
      .filter(c => c.coach_name !== UNASSIGNED && c.coach_name !== selectedCoach)
      .map(c => c.coach_name);

    container.innerHTML = Card({
      title: `${escapeHtml(selectedCoach)}'s roster`,
      meta: `${clientsRes.count} active · ${trendRes.days}d trend`,
      body: `
        <div style="margin-bottom: 14px;">
          ${Sparkline(trendValues, { width: 320, height: 48 })}
          <div style="font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px;">
            Weekly active count · last ${trendRes.days}d
          </div>
        </div>
        ${renderDrillTable(clientsRes.clients, selectedCoach, otherCoaches)}
      `,
    });

    bindReassign(container, selectedCoach);
  } catch (err) {
    container.innerHTML = Card({
      title: `${selectedCoach}'s roster`,
      body: `<div style="color: var(--red); font-size: 12px;">${escapeHtml(err.message)}</div>`,
    });
  }
}

function renderDrillTable(clients, fromCoach, otherCoaches) {
  if (!clients.length) {
    return EmptyState({ icon: '◔', title: 'No active clients on this coach.', message: 'Reassign from unassigned queue below.' });
  }
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Client</th>
          <th>Tier</th>
          <th class="num">Last check-in</th>
          <th>Reassign</th>
        </tr>
      </thead>
      <tbody>
        ${clients.map(c => `
          <tr>
            <td>${escapeHtml(c.full_name)}</td>
            <td>${StatusPill(tierColor(c.tier), c.tier)}</td>
            <td class="num">${fmt.date(c.last_checkin_date)}</td>
            <td>
              <select class="reassign-select" data-client-id="${c.id}" data-from="${escapeHtml(fromCoach)}">
                <option value="">— keep —</option>
                ${otherCoaches.map(oc => `<option value="${escapeHtml(oc)}">→ ${escapeHtml(oc)}</option>`).join('')}
                <option value="${UNASSIGNED}">→ (unassigned)</option>
              </select>
            </td>
          </tr>
        `).join('')}
      </tbody>
    </table>
    <style>
      .reassign-select {
        padding: 3px 6px; font-size: 12px; border: 1px solid var(--line);
        border-radius: 4px; background: var(--cream); color: var(--muted);
        font-family: inherit;
      }
      .reassign-select:hover { border-color: var(--mauve); }
    </style>
  `;
}

function bindReassign(container, fromCoach) {
  container.querySelectorAll('.reassign-select').forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const target = e.currentTarget;
      const to = target.value;
      const clientId = target.dataset.clientId;
      const from = target.dataset.from;
      if (!to) return;

      target.disabled = true;
      try {
        const res = await api('/api/v2/capacity/reassign', {
          method: 'POST',
          body: { client_id: clientId, from_coach: from, to_coach: to },
        });
        toast(`Moved ${res.full_name} → ${to === UNASSIGNED ? 'unassigned' : to}`);
        renderCapacity(container.closest('#tab-root') || container);
      } catch (err) {
        toast(`Failed: ${err.message}`);
        target.disabled = false;
        target.value = '';
      }
    });
  });
}

// ─── unassigned ───
function renderUnassignedCard(count) {
  return Card({
    title: 'Unassigned clients',
    meta: count > 0 ? `${count} need a coach — fill first` : 'All clients have a coach',
    body: count > 0
      ? `<div data-unassigned-list><div class="skeleton" style="height: 160px; border-radius: var(--r-md);"></div></div>`
      : EmptyState({ icon: '◉', title: 'Everyone is assigned.', message: 'New clients get triaged here automatically.' }),
  });
}

async function loadUnassigned(root, summary) {
  const container = root.querySelector('[data-unassigned-list]');
  if (!container) return;

  try {
    const res = await api(`/api/v2/capacity/${encodeURIComponent(UNASSIGNED)}/clients`);
    const coaches = (summary.coaches || [])
      .filter(c => c.coach_name !== UNASSIGNED)
      .map(c => c.coach_name);

    if (!res.clients.length) {
      container.innerHTML = EmptyState({ title: 'No unassigned clients.' });
      return;
    }

    container.innerHTML = `
      <div style="max-height: 480px; overflow-y: auto;">
        <table class="table">
          <thead>
            <tr>
              <th>Client</th>
              <th class="num">Started</th>
              <th class="num">Last check-in</th>
              <th>Assign to…</th>
            </tr>
          </thead>
          <tbody>
            ${res.clients.map(c => `
              <tr>
                <td>${escapeHtml(c.full_name)}</td>
                <td class="num">${fmt.date(c.start_date)}</td>
                <td class="num">${fmt.date(c.last_checkin_date)}</td>
                <td>
                  <select class="reassign-select" data-client-id="${c.id}" data-from="${UNASSIGNED}">
                    <option value="">— pick coach —</option>
                    ${coaches.map(oc => `<option value="${escapeHtml(oc)}">${escapeHtml(oc)}</option>`).join('')}
                  </select>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    bindReassign(container, UNASSIGNED);
  } catch (err) {
    container.innerHTML = `<div style="color: var(--red); font-size: 12px;">${escapeHtml(err.message)}</div>`;
  }
}

// ─── utils ───
function tierColor(tier) {
  if (tier === 'critical') return 'red';
  if (tier === 'urgent') return 'yellow';
  if (tier === 'watch') return 'yellow';
  if (tier === 'ok') return 'green';
  if (tier === 'green') return 'green';
  if (tier === 'yellow') return 'yellow';
  if (tier === 'red') return 'red';
  return 'grey';
}

function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&');
}

function renderError(err) {
  return `
    <div class="card">
      <h3 style="color: var(--red);">Capacity tab failed to load</h3>
      <p class="mono" style="font-size: 12px; color: var(--muted); margin-top: 8px;">${escapeHtml(err.message)}</p>
    </div>
  `;
}
