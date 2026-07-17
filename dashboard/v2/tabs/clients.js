// Clients tab — leads with GOAL PROGRESS. 5 status buckets + weight chart drawer.
import { api, fmt, Card, StatusPill, EmptyState, KPISkeleton, ProgressBar, escapeHtml, toast } from '../app.js';

const state = {
  progressStatus: 'all', // all | crushing | on_track | slipping | struggling | new_no_data
  search: '',
  sortKey: 'pct_to_goal',  // pct_to_goal | pounds_lost | weeks | struggling_first | name
  sortDir: 'desc',
  selectedId: null,
  rows: [],
  coaches: [],
  buckets: null,
  activeTotal: 0,
  detailCache: new Map(),    // id → detail
  progressCache: new Map(),   // id → weekly points
  syncing: false,
  syncingCoach: false,
};

const STATUS_META = {
  crushing:    { label: 'Crushing It', pill: 'green',  icon: '🚀', tone: 'green'  },
  on_track:    { label: 'On Track',    pill: 'green',  icon: '✓',  tone: 'green'  },
  slipping:    { label: 'Slipping',    pill: 'yellow', icon: '⚠',  tone: 'yellow' },
  struggling:  { label: 'Struggling',  pill: 'red',    icon: '🚨', tone: 'red'    },
  new_no_data: { label: 'New / No Data', pill: 'grey', icon: '◔',  tone: 'grey'   },
};

const BUCKET_ORDER = ['crushing', 'on_track', 'slipping', 'struggling', 'new_no_data'];

export async function renderClients(root) {
  root.innerHTML = KPISkeleton(5);
  try {
    const data = await api('/api/v2/clients?limit=500');
    state.rows = data.rows || [];
    state.coaches = data.coaches || [];
    state.buckets = data.buckets || null;
    state.activeTotal = data.active_total || (data.rows || []).length;
  } catch (err) {
    root.innerHTML = renderError(err);
    return;
  }
  paint(root);
}

function paint(root) {
  const visible = applyFilters(state.rows);
  const selected = state.selectedId ? state.rows.find(r => r.id === state.selectedId) : null;

  root.innerHTML = `
    ${renderStatusBuckets(state.buckets, state.activeTotal)}
    ${filterBar()}

    <div class="clients-layout ${selected ? 'with-drawer' : ''}">
      <div>
        ${Card({
          title: `Roster · ${visible.length} shown`,
          meta: `${state.activeTotal} active · sorted by ${sortLabel(state.sortKey)}`,
          body: renderTable(visible),
        })}
      </div>
      ${selected ? `<aside class="drawer" id="drawer">${renderDrawer(selected)}</aside>` : ''}
    </div>
  `;

  bindInteractions(root);
  if (selected) {
    hydrateDrawer(selected.id);
    hydrateProgressChart(selected.id);
  }
}

function renderStatusBuckets(buckets, total) {
  if (!buckets) return '';
  const cards = BUCKET_ORDER.map(key => {
    const meta = STATUS_META[key];
    const count = buckets[key] ?? 0;
    const active = state.progressStatus === key ? 'active' : '';
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <button type="button" class="status-bucket ${key} ${active}" data-status-filter="${key}" aria-label="Filter to ${meta.label}">
        <div class="bucket-label"><span class="bucket-icon">${meta.icon}</span> ${meta.label}</div>
        <div class="bucket-value">${fmt.int(count)}</div>
        <div class="bucket-sub">${pct}% of active</div>
      </button>
    `;
  }).join('');
  return `<div class="status-bucket-grid">${cards}</div>`;
}

const SORT_OPTIONS = [
  ['pct_to_goal',      '% to Goal · high → low'],
  ['pounds_lost',      'Pounds Lost · high → low'],
  ['weeks',            'Weeks in Program · high → low'],
  ['struggling_first', 'Struggling first'],
  ['name',             'Name · A → Z'],
  ['last_checkin',     'Last Check-in · stale first'],
];

function filterBar() {
  const clearVisible = state.search || state.progressStatus !== 'all';
  const activeStatusChip = state.progressStatus !== 'all'
    ? `<span class="filter-chip">
         Filtered: ${STATUS_META[state.progressStatus].icon} ${escapeHtml(STATUS_META[state.progressStatus].label)}
         <button type="button" class="filter-chip-x" id="chip-clear-status" aria-label="Clear status filter">×</button>
       </span>`
    : '';
  return `
    <div class="filter-bar">
      <label class="search">
        <span class="glyph">⌕</span>
        <input id="q-search" type="search" placeholder="Search clients…" value="${escapeHtml(state.search)}" />
      </label>
      <select id="q-status" aria-label="Filter by status">
        <option value="all">All statuses</option>
        ${BUCKET_ORDER.map(k => `
          <option value="${k}" ${k === state.progressStatus ? 'selected' : ''}>${STATUS_META[k].label}</option>
        `).join('')}
      </select>
      <select id="q-sort" aria-label="Sort by">
        ${SORT_OPTIONS.map(([k, l]) => `<option value="${k}" ${k === state.sortKey ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      ${activeStatusChip}
      <button class="btn ghost" id="btn-clear" ${clearVisible ? '' : 'style="visibility:hidden"'}>Clear</button>
      <button class="btn mauve" id="btn-sync" ${state.syncing ? 'disabled' : ''}>
        ${state.syncing ? '↻ Syncing…' : '↻ Programmed To'}
      </button>
      <button class="btn ghost" id="btn-sync-coach" ${state.syncingCoach ? 'disabled' : ''}>
        ${state.syncingCoach ? '↻ Syncing…' : '↻ Coach + Program'}
      </button>
    </div>
  `;
}

function sortLabel(key) {
  const m = { pct_to_goal: '% to goal', pounds_lost: 'pounds lost', weeks: 'weeks in program', struggling_first: 'struggling first', name: 'name', last_checkin: 'last check-in' };
  return m[key] || key;
}

function applyFilters(rows) {
  let out = rows.slice();
  if (state.progressStatus !== 'all') {
    out = out.filter(r => r.progress_status === state.progressStatus);
  }
  const q = state.search.trim().toLowerCase();
  if (q) {
    out = out.filter(r => (r.name || '').toLowerCase().includes(q));
  }
  out.sort(sorter(state.sortKey, state.sortDir));
  return out;
}

function sorter(key) {
  const rank = { struggling: 0, slipping: 1, on_track: 2, crushing: 3, new_no_data: 4 };
  const nl = (a, b, dir = -1) => {
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    return dir * (a - b);
  };
  return (a, b) => {
    switch (key) {
      case 'name':             return (a.name || '').localeCompare(b.name || '');
      case 'pounds_lost':      return nl(a.pounds_lost, b.pounds_lost);
      case 'weeks':            return nl(a.weeks_in_program, b.weeks_in_program);
      case 'last_checkin':     return nl(a.days_since_checkin, b.days_since_checkin);
      case 'struggling_first': {
        const d = rank[a.progress_status] - rank[b.progress_status];
        return d !== 0 ? d : nl(a.pct_to_goal, b.pct_to_goal);
      }
      case 'pct_to_goal':
      default:                 return nl(a.pct_to_goal, b.pct_to_goal);
    }
  };
}

function renderTable(rows) {
  if (!rows.length) {
    const hasNoProgressData = state.rows.every(r => r.starting_weight == null || r.goal_weight == null);
    return EmptyState({
      title: 'No clients match those filters.',
      message: hasNoProgressData
        ? 'No progress data yet. Sync check-ins to start.'
        : 'Try clearing filters.',
    });
  }
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Client</th>
          <th>Start → Current → Goal</th>
          <th class="num">Lost</th>
          <th style="min-width: 160px;">% to Goal</th>
          <th>Status</th>
          <th class="num">Last Check-in</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => renderRow(r)).join('')}
      </tbody>
    </table>
  `;
}

function renderRow(r) {
  const status = STATUS_META[r.progress_status] || STATUS_META.new_no_data;
  const lostCell = r.pounds_lost != null
    ? `<strong>${r.pounds_lost > 0 ? '−' : '+'}${Math.abs(r.pounds_lost).toFixed(1)}</strong>`
    : '<span style="color:var(--dim);">—</span>';
  const progressCell = r.pct_to_goal != null
    ? ProgressBar({ pct: r.pct_to_goal, variant: status.tone })
    : `<span class="wt-none">Add goal weight</span>`;
  const checkinCell = r.last_checkin_date
    ? `${fmt.date(r.last_checkin_date)} <span style="color:var(--dim);">· ${r.days_since_checkin}d</span>`
    : '<span style="color:var(--dim);">—</span>';
  // Status pill = click-to-filter toggle. Wrapped in a button so keyboard + click
  // don't collide with the row-click drawer handler (stopPropagation in binder).
  const statusActive = state.progressStatus === r.progress_status ? 'is-active' : '';
  const statusCell = `
    <button type="button"
            class="status-pill-btn ${statusActive}"
            data-status-pill="${r.progress_status}"
            aria-label="Filter roster to ${status.label}">
      ${StatusPill(status.pill, status.label)}
    </button>
  `;

  return `
    <tr class="row-click ${state.selectedId === r.id ? 'selected' : ''}" data-id="${r.id}">
      <td><strong>${escapeHtml(r.name)}</strong></td>
      <td>${renderWeightTriple(r)}</td>
      <td class="num">${lostCell}</td>
      <td>${progressCell}</td>
      <td>${statusCell}</td>
      <td class="num">${checkinCell}</td>
    </tr>
  `;
}

function renderWeightTriple(r) {
  if (r.starting_weight == null && r.goal_weight == null) {
    return `<span class="wt-none">No weights on file</span>`;
  }
  const n = v => v != null ? `${Math.round(v * 10) / 10}` : '—';
  return `<span class="wt-triple"><span>${n(r.starting_weight)}</span><span class="wt-arrow">→</span><span class="wt-cur">${n(r.current_weight)}</span><span class="wt-arrow">→</span><span class="wt-goal">${n(r.goal_weight)}</span></span>`;
}

// ─── Drawer ─────────────────────────────────────────────────────

function renderDrawer(row) {
  const cached = state.detailCache.get(row.id);
  const status = STATUS_META[row.progress_status] || STATUS_META.new_no_data;
  return `
    <div class="drawer-header">
      <div>
        <h3>${escapeHtml(row.name)}</h3>
        <div class="meta" style="color:var(--dim); font-size:var(--f-xs); text-transform:uppercase; letter-spacing:0.08em; margin-top:4px;">
          ${StatusPill(status.pill, status.label)}
        </div>
      </div>
      <button class="close-x" data-close-drawer aria-label="Close">×</button>
    </div>

    ${renderGoalSnapshot(row, status)}

    <div class="drawer-section">
      <h4>Weight · last 12 weeks</h4>
      <div id="drawer-chart-slot">${renderChartSkeleton()}</div>
    </div>

    ${renderStrugglingBlock(row)}

    <div id="drawer-detail-slot">
      ${cached ? renderDrawerDetail(cached, row) : renderDrawerSkeleton()}
    </div>
  `;
}

function renderGoalSnapshot(row, status) {
  const bits = [];
  if (row.pounds_lost != null && row.pounds_lost !== 0) {
    const dir = row.pounds_lost > 0 ? 'Down' : 'Up';
    bits.push(`${dir} ${Math.abs(row.pounds_lost).toFixed(1)} lb`);
  }
  if (row.pct_to_goal != null) {
    bits.push(`${row.pct_to_goal}% to goal`);
  }
  if (row.weeks_in_program != null) {
    bits.push(`${row.weeks_in_program}w in program`);
  }
  const headline = bits.length ? bits.join(' · ') : 'Not enough data yet';
  return `
    <div class="goal-snapshot">
      <div class="headline">${escapeHtml(headline)}</div>
      ${row.goal ? `<div class="goal-text">"${escapeHtml(row.goal.slice(0, 180))}${(row.goal || '').length > 180 ? '…' : ''}"</div>` : ''}
      <div class="status-reason ${row.progress_status === 'struggling' ? 'struggling' : ''}">
        ${escapeHtml(row.status_reason || '')}
      </div>
    </div>
  `;
}

function renderStrugglingBlock(row) {
  if (row.progress_status !== 'struggling' || !row.churn_risk_tier) return '';
  return `<div class="drawer-section">
    <h4>Churn risk</h4>
    <div>Tier: <strong>${escapeHtml(row.churn_risk_tier)}</strong></div>
  </div>`;
}

function renderChartSkeleton() {
  return `<div class="weight-chart-wrap"><div class="skeleton" style="height: 180px;"></div></div>`;
}

function renderDrawerSkeleton() {
  return `
    <div class="drawer-section">
      <h4>Program</h4>
      <div class="skeleton" style="height: 14px; width: 80%; margin-bottom: 8px;"></div>
      <div class="skeleton" style="height: 14px; width: 60%;"></div>
    </div>
    <div class="drawer-section">
      <h4>Recent notes</h4>
      <div class="skeleton" style="height: 50px;"></div>
    </div>
  `;
}

function renderDrawerDetail(detail, row) {
  const { profile, recent_notes = [], open_todos = [] } = detail;
  const macros = (profile.daily_calorie_target || profile.daily_protein_target_g)
    ? `${profile.daily_calorie_target || '—'} cal · ${profile.daily_protein_target_g ? profile.daily_protein_target_g + 'g P' : '—'}`
    : '—';
  const listItem = (head, sub, body) => `
    <div class="item">
      <div class="head"><span>${head}</span><span>${sub}</span></div>
      <div class="body">${body}</div>
    </div>`;
  const empty = msg => `<div style="color:var(--dim); font-size: var(--f-sm);">${msg}</div>`;
  return `
    <div class="drawer-section">
      <h4>Contact</h4>
      <dl class="drawer-meta">
        <dt>Phone</dt><dd>${profile.phone ? escapeHtml(profile.phone) : '—'}</dd>
        <dt>Email</dt><dd>${profile.email ? escapeHtml(profile.email) : '—'}</dd>
        <dt>Instagram</dt><dd>${profile.instagram_handle ? '@' + escapeHtml(profile.instagram_handle) : '—'}</dd>
        <dt>Location</dt><dd>${profile.location ? escapeHtml(profile.location) : '—'} · Age ${profile.age || '—'}</dd>
      </dl>
    </div>

    <div class="drawer-section">
      <h4>Program</h4>
      <dl class="drawer-meta">
        <dt>Phase / term</dt><dd>${profile.program_dropdown || profile.program_term ? escapeHtml(profile.program_dropdown || profile.program_term) : '—'}</dd>
        <dt>Start date</dt><dd>${profile.start_date ? fmt.date(profile.start_date) : '—'}</dd>
        <dt>Weekly workouts</dt><dd>${profile.weekly_target_workouts || '—'}</dd>
        <dt>Cal / Protein</dt><dd>${macros}</dd>
      </dl>
      <div class="secondary-metric">
        <span>Programmed to · ${row.programmed_to ? fmt.date(row.programmed_to) : '—'}</span>
        <strong>${daysLabel(row.days_until_resign)}</strong>
      </div>
    </div>

    <div class="drawer-section">
      <h4>Open to-dos · ${open_todos.length}</h4>
      ${open_todos.length
        ? `<div class="drawer-list">${open_todos.slice(0, 6).map(t =>
            listItem(escapeHtml(t.category || 'other'), t.status === 'snoozed' ? 'snoozed' : 'open', escapeHtml(t.note || ''))
          ).join('')}</div>`
        : empty('Nothing pending.')}
    </div>

    <div class="drawer-section">
      <h4>Recent notes · last ${recent_notes.length}</h4>
      ${recent_notes.length
        ? `<div class="drawer-list">${recent_notes.slice(0, 3).map(n => listItem(
            escapeHtml(n.note_type || 'note') + (n.pinned ? ' · pinned' : ''),
            fmt.date(n.created_at),
            escapeHtml((n.body || '').slice(0, 240)) + ((n.body || '').length > 240 ? '…' : '')
          )).join('')}</div>`
        : empty('No notes yet.')}
    </div>
  `;
}

function daysLabel(d) {
  if (d == null) return '<span style="color:var(--dim);">—</span>';
  if (d < 0) return `${d}d overdue`;
  if (d === 0) return `Today`;
  return `${d}d`;
}

// ─── Weight chart SVG ───────────────────────────────────────────

function renderWeightChart(data) {
  const { points, starting_weight, goal_weight } = data;
  if (!points || !points.length) {
    return `<div class="weight-chart-wrap"><div style="color:var(--dim); font-size:var(--f-sm); padding: 40px; text-align:center;">No check-ins in the last 12 weeks.</div></div>`;
  }
  const W = 400, H = 180, padL = 36, padR = 12, padT = 12, padB = 24;
  const w = W - padL - padR, h = H - padT - padB;

  const allY = [...points.map(p => p.weight), starting_weight, goal_weight].filter(v => v != null);
  const yMin = Math.floor(Math.min(...allY) - 2);
  const yMax = Math.ceil(Math.max(...allY) + 2);
  const yRange = Math.max(1, yMax - yMin);
  const yPos = v => padT + h - ((v - yMin) / yRange) * h;
  const xPos = i => points.length === 1 ? padL + w / 2 : padL + (i / (points.length - 1)) * w;

  const linePts = points.map((p, i) => [xPos(i), yPos(p.weight)]);
  const linePath = linePts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const areaPath = linePts.length >= 2
    ? `${linePath} L${linePts[linePts.length - 1][0].toFixed(1)},${padT + h} L${linePts[0][0].toFixed(1)},${padT + h} Z`
    : '';

  const refLine = (v, cls) => v == null ? '' :
    `<line class="${cls}" x1="${padL}" y1="${yPos(v).toFixed(1)}" x2="${padL + w}" y2="${yPos(v).toFixed(1)}" />
     <text class="wchart-axis" x="${padL + w - 2}" y="${(yPos(v) - 3).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`;

  const yAxis = Array.from({ length: 4 }, (_, i) => {
    const val = yMax - (yRange / 3) * i;
    const y = padT + (h / 3) * i;
    return `<text class="wchart-axis" x="${padL - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end">${Math.round(val)}</text>
            <line class="wchart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + w}" y2="${y.toFixed(1)}" />`;
  }).join('');

  const dots = linePts.map((p, i) => {
    const isLast = i === linePts.length - 1;
    return `<circle class="${isLast ? 'wchart-dot-last' : 'wchart-dot'}" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${isLast ? 4 : 2.4}" />`;
  }).join('');

  return `
    <div class="weight-chart-wrap">
      <svg class="weight-chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${yAxis}
        ${refLine(starting_weight, 'wchart-ref-start')}
        ${refLine(goal_weight, 'wchart-ref-goal')}
        ${areaPath ? `<path class="wchart-area" d="${areaPath}" />` : ''}
        <path class="wchart-line" d="${linePath}" />
        ${dots}
        <text class="wchart-axis" x="${padL}" y="${H - 6}" text-anchor="start">${fmt.date(points[0].date)}</text>
        <text class="wchart-axis" x="${padL + w}" y="${H - 6}" text-anchor="end">${fmt.date(points[points.length - 1].date)}</text>
      </svg>
      <div class="weight-chart-legend">
        <span><span class="swatch line"></span>Weight</span>
        <span><span class="swatch start"></span>Start (${starting_weight != null ? Math.round(starting_weight) : '—'})</span>
        <span><span class="swatch goal"></span>Goal (${goal_weight != null ? Math.round(goal_weight) : '—'})</span>
      </div>
    </div>
  `;
}

// ─── Data hydration ─────────────────────────────────────────────

async function hydrateDrawer(id) {
  if (state.detailCache.has(id)) return;
  try {
    const detail = await api(`/api/v2/clients/${id}/detail`);
    state.detailCache.set(id, detail);
    if (state.selectedId !== id) return;
    const slot = document.getElementById('drawer-detail-slot');
    if (slot) {
      const row = state.rows.find(r => r.id === id);
      slot.innerHTML = renderDrawerDetail(detail, row || {});
    }
  } catch (err) {
    console.error('[clients:detail]', err);
    const slot = document.getElementById('drawer-detail-slot');
    if (slot) slot.innerHTML = `<div class="drawer-section" style="color:var(--red);">Failed to load detail: ${escapeHtml(err.message)}</div>`;
  }
}

async function hydrateProgressChart(id) {
  const slot = document.getElementById('drawer-chart-slot');
  if (!slot) return;
  if (state.progressCache.has(id)) {
    slot.innerHTML = renderWeightChart(state.progressCache.get(id));
    return;
  }
  try {
    const data = await api(`/api/v2/clients/${id}/progress?weeks=12`);
    state.progressCache.set(id, data);
    if (state.selectedId !== id) return;
    const again = document.getElementById('drawer-chart-slot');
    if (again) again.innerHTML = renderWeightChart(data);
  } catch (err) {
    console.error('[clients:progress]', err);
    if (slot) slot.innerHTML = `<div class="weight-chart-wrap" style="color:var(--red); font-size:var(--f-sm);">Chart failed: ${escapeHtml(err.message)}</div>`;
  }
}

// ─── Interactions ───────────────────────────────────────────────

function bindInteractions(root) {
  root.querySelectorAll('tr.row-click').forEach(tr => {
    tr.addEventListener('click', () => {
      const id = tr.dataset.id;
      state.selectedId = state.selectedId === id ? null : id;
      paint(root);
    });
  });

  // Status bucket cards (top KPI row) → filter roster to that status. Toggle off on same-click.
  root.querySelectorAll('[data-status-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.statusFilter;
      state.progressStatus = state.progressStatus === key ? 'all' : key;
      state.selectedId = null; // reset drawer — the visible row set will change
      paint(root);
    });
  });

  // In-row status pill → same click-to-filter toggle. stopPropagation so we don't
  // also open the drawer for that row.
  root.querySelectorAll('[data-status-pill]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = btn.dataset.statusPill;
      state.progressStatus = state.progressStatus === key ? 'all' : key;
      state.selectedId = null;
      paint(root);
    });
  });

  // Chip [×] → clear status filter only.
  root.querySelector('#chip-clear-status')?.addEventListener('click', () => {
    state.progressStatus = 'all';
    paint(root);
  });

  const closeBtn = root.querySelector('[data-close-drawer]');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    state.selectedId = null;
    paint(root);
  });

  const searchEl = root.querySelector('#q-search');
  if (searchEl) {
    let t;
    searchEl.addEventListener('input', e => {
      clearTimeout(t);
      const v = e.target.value;
      t = setTimeout(() => {
        state.search = v;
        paint(root);
        const again = document.getElementById('q-search');
        if (again) {
          again.focus();
          again.setSelectionRange(v.length, v.length);
        }
      }, 200);
    });
  }

  root.querySelector('#q-status')?.addEventListener('change', e => {
    state.progressStatus = e.target.value;
    paint(root);
  });
  root.querySelector('#q-sort')?.addEventListener('change', e => {
    state.sortKey = e.target.value;
    paint(root);
  });

  root.querySelector('#btn-clear')?.addEventListener('click', () => {
    state.search = '';
    state.progressStatus = 'all';
    paint(root);
  });

  root.querySelector('#btn-sync')?.addEventListener('click', () =>
    runSync(root, 'sync-programmed-to', 'syncing', 'Programmed To')
  );
  root.querySelector('#btn-sync-coach')?.addEventListener('click', () =>
    runSync(root, 'sync-assigned-coach', 'syncingCoach', 'Coach + Program')
  );
}

async function runSync(root, endpointSlug, stateKey, label) {
  if (state[stateKey]) return;
  state[stateKey] = true;
  paint(root);
  toast(`Syncing ${label} · Monday → Supabase…`);
  try {
    const result = await api(`/api/v2/clients/${endpointSlug}`, { method: 'POST' });
    if (!result.ok) throw new Error(result.log_tail || 'sync failed');
    toast(`${label} synced · ${result.updated ?? '?'} updated`);
    const data = await api('/api/v2/clients?limit=500');
    state.rows = data.rows || [];
    state.coaches = data.coaches || [];
    state.buckets = data.buckets || null;
    state.activeTotal = data.active_total || state.rows.length;
    state.detailCache.clear();
    state.progressCache.clear();
  } catch (err) {
    toast(`${label} sync failed: ${err.message}`);
    console.error(`[clients:${endpointSlug}]`, err);
  } finally {
    state[stateKey] = false;
    paint(root);
  }
}

function renderError(err) {
  return `
    <div class="card">
      <h3 style="color: var(--red);">Clients tab failed to load</h3>
      <p class="mono" style="font-size: 12px; color: var(--muted); margin-top: 8px;">${escapeHtml(err.message)}</p>
      <p style="margin-top: 12px; color: var(--muted); font-size: 13px;">
        Check the server is running and the <code>client_countdown</code> view + <code>weekly_checkins</code> table exist.
      </p>
    </div>
  `;
}
