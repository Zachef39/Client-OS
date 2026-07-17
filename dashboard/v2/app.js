// Faerber Client OS v2 — tab router + primitives
// Vanilla ES modules, no framework.
import { renderOverview } from './tabs/overview.js';
import { renderSales } from './tabs/sales.js';
import { renderAds } from './tabs/ads.js';
import { renderTeam } from './tabs/team.js';
import { renderClients } from './tabs/clients.js';
import { renderCapacity } from './tabs/capacity.js';
import { renderPnl } from './tabs/pnl.js';
import { renderCompanyKpi } from './tabs/company-kpi.js';

// ─── State ───
function daysForPeriod(period) {
  const now = new Date();
  switch (period) {
    case 'mtd': return now.getDate(); // day-of-month = MTD length
    case '7d':  return 7;
    case '30d': return 30;
    case '90d': return 90;
    case 'ytd': {
      const jan1 = new Date(now.getFullYear(), 0, 1);
      return Math.ceil((now - jan1) / 86400000) + 1;
    }
    default: return 30;
  }
}

const state = {
  tab: 'overview',
  period: localStorage.getItem('v2_period') || 'mtd',
  get days() { return daysForPeriod(this.period); },
};

const TAB_META = {
  overview: { title: 'Overview', sub: 'Cash, ROAS, active clients, upcoming resigns.', render: renderOverview },
  sales:    { title: 'Sales',    sub: 'Booked / shown / closed funnel, per-closer breakdown.', render: renderSales },
  ads:      { title: 'Ads',      sub: 'Meta spend, ROAS, cost per booked call, per-campaign.', render: renderAds },
  team:     { title: 'Team KPI', sub: 'Setters + Closers · rolling window from Monday EOD + Booked Calls.', render: renderTeam },
  clients:  { title: 'Clients',  sub: 'Active roster, program countdown, extension tracker.', render: renderClients },
  capacity: { title: 'Coach Capacity', sub: 'Coach load vs 15-client cap. (Phase 4 build.)', render: renderCapacity },
  pnl:      { title: 'P&L',      sub: 'Expenses, categorized spend, MTD profit. (Phase 5 build.)', render: renderPnl },
  'company-kpi': { title: 'Company KPI', sub: 'Monthly performance · marketing, funnel, cash.', render: renderCompanyKpi },
};

// ─── API helpers ───
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

export function getRangeDays() {
  return state.days;
}

// ─── Formatters ───
export const fmt = {
  money(v, opts = {}) {
    if (v == null || Number.isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (opts.short && abs >= 1000) {
      if (abs >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
      return `$${(v / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
    }
    return `$${Math.round(v).toLocaleString()}`;
  },
  int(v) {
    if (v == null || Number.isNaN(v)) return '—';
    return Math.round(v).toLocaleString();
  },
  pct(v, digits = 0) {
    if (v == null || Number.isNaN(v)) return '—';
    return `${(v * 100).toFixed(digits)}%`;
  },
  ratio(v, digits = 2) {
    if (v == null || Number.isNaN(v)) return '—';
    return `${v.toFixed(digits)}x`;
  },
  date(s) {
    if (!s) return '—';
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  },
};

// ─── Primitives (return HTML strings) ───

export function Card({ title, meta = '', body = '', actions = '' } = {}) {
  return `
    <section class="card">
      ${(title || meta || actions) ? `
        <div class="card-title">
          <div>
            ${title ? `<h3>${title}</h3>` : ''}
            ${meta ? `<div class="meta">${meta}</div>` : ''}
          </div>
          <div>${actions}</div>
        </div>` : ''}
      ${body}
    </section>
  `;
}

export function KPI({ label, value, sub = '', spark = null } = {}) {
  return `
    <article class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value">${value ?? '—'}</div>
      <div class="kpi-sub">${sub}</div>
      ${spark ? Sparkline(spark) : ''}
    </article>
  `;
}

/**
 * Sparkline — inline SVG line + area.
 * @param {number[]} values
 */
export function Sparkline(values, { width = 220, height = 42 } = {}) {
  const clean = (values || []).filter(v => v != null && !Number.isNaN(v));
  if (clean.length < 2) return `<div class="spark"></div>`;
  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const range = max - min || 1;
  const pad = 2;
  const w = width - pad * 2;
  const h = height - pad * 2;
  const step = w / (clean.length - 1);
  const pts = clean.map((v, i) => {
    const x = pad + i * step;
    const y = pad + h - ((v - min) / range) * h;
    return [x, y];
  });
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
  const last = pts[pts.length - 1];
  return `
    <svg class="spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <path class="area" d="${areaPath}"></path>
      <path class="line" d="${linePath}"></path>
      <circle class="last" cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5"></circle>
    </svg>
  `;
}

export function StatusPill(status, label) {
  const map = { green: 'green', yellow: 'yellow', red: 'red', ok: 'green', warn: 'yellow', bad: 'red', mauve: 'mauve', neutral: 'grey' };
  const cls = map[status] || 'grey';
  return `<span class="pill ${cls}">${label ?? status}</span>`;
}

/**
 * Horizontal progress bar. pct is 0-100+, values >100 render as capped fill w/ overflow tick.
 * variant = 'green' | 'yellow' | 'red' | 'mauve' | 'grey'
 */
export function ProgressBar({ pct, variant = 'mauve', label = null } = {}) {
  if (pct == null || Number.isNaN(pct)) {
    return `<div class="progress-bar empty">—</div>`;
  }
  const capped = Math.max(0, Math.min(100, pct));
  const over = pct > 100;
  const displayLabel = label ?? `${Math.round(pct)}%`;
  return `
    <div class="progress-bar ${variant} ${over ? 'over' : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-fill" style="width: ${capped}%"></div>
      <span class="progress-label">${displayLabel}</span>
    </div>
  `;
}

export function EmptyState({ icon = '◔', title = 'No data yet', message = '' } = {}) {
  return `
    <div class="empty">
      <div style="font-size: 28px; margin-bottom: 8px; color: var(--dim);">${icon}</div>
      <h3>${title}</h3>
      ${message ? `<p>${message}</p>` : ''}
    </div>
  `;
}

export function BarList(rows, { max = null, format = fmt.int } = {}) {
  if (!rows?.length) return EmptyState({ title: 'Nothing to show yet.' });
  const maxVal = max ?? Math.max(...rows.map(r => r.value || 0), 1);
  return `
    <div class="barlist">
      ${rows.map(r => {
        const pct = Math.max(2, Math.min(100, (r.value / maxVal) * 100));
        return `
          <div class="barlist-row">
            <div class="barlist-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</div>
            <div class="barlist-track"><div class="barlist-fill" style="width: ${pct}%"></div></div>
            <div class="barlist-value">${format(r.value)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

/**
 * Full-size line chart SVG. values = [{ x: 'label', y: number }, ...]
 */
export function LineChart(values, { height = 220, format = fmt.money } = {}) {
  const clean = (values || []).filter(v => v && !Number.isNaN(v.y));
  if (clean.length < 2) return EmptyState({ title: 'Not enough data for a chart.' });
  const width = 900;
  const padL = 44, padR = 12, padT = 12, padB = 30;
  const w = width - padL - padR;
  const h = height - padT - padB;
  const ys = clean.map(d => d.y);
  const min = 0;
  const max = Math.max(...ys) * 1.1 || 1;
  const step = w / (clean.length - 1);
  const pts = clean.map((d, i) => {
    const x = padL + i * step;
    const y = padT + h - ((d.y - min) / (max - min)) * h;
    return [x, y, d];
  });
  const linePath = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L${pts[pts.length - 1][0].toFixed(1)},${padT + h} L${pts[0][0].toFixed(1)},${padT + h} Z`;

  // 4 horizontal grid lines
  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const y = padT + (h / gridCount) * i;
    const val = max - ((max - min) / gridCount) * i;
    return `
      <line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + w}" y2="${y.toFixed(1)}" />
      <text class="chart-axis" x="${padL - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${format(val)}</text>
    `;
  }).join('');

  // X axis labels (max 6)
  const xTicks = Math.min(6, clean.length);
  const xStep = Math.max(1, Math.floor(clean.length / xTicks));
  const xAxis = pts.filter((_, i) => i % xStep === 0 || i === pts.length - 1).map(p => `
    <text class="chart-axis" x="${p[0].toFixed(1)}" y="${(padT + h + 18).toFixed(1)}" text-anchor="middle">${escapeHtml(p[2].x)}</text>
  `).join('');

  return `
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="chart-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--mauve)" stop-opacity="0.5" />
          <stop offset="100%" stop-color="var(--mauve)" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${gridLines}
      <path class="chart-area" d="${areaPath}" />
      <path class="chart-line" d="${linePath}" />
      ${xAxis}
    </svg>
  `;
}

/**
 * Two-series line chart. series = [
 *   { name, color, values: [{ x, y }] },
 *   { name, color, values: [{ x, y }] },
 * ]
 * X labels come from series[0].values[i].x.
 */
export function DualLineChart(series, { height = 260, format = fmt.money } = {}) {
  if (!series?.length || series[0].values.length < 2) {
    return EmptyState({ title: 'Not enough data for a chart.' });
  }
  const width = 900;
  const padL = 52, padR = 12, padT = 18, padB = 44;
  const w = width - padL - padR;
  const h = height - padT - padB;

  const xs = series[0].values.map(d => d.x);
  const allY = series.flatMap(s => s.values.map(d => d.y || 0));
  const min = 0;
  const max = Math.max(...allY, 1) * 1.1;
  const step = w / Math.max(1, xs.length - 1);

  const gridCount = 4;
  const gridLines = Array.from({ length: gridCount + 1 }, (_, i) => {
    const y = padT + (h / gridCount) * i;
    const val = max - ((max - min) / gridCount) * i;
    return `
      <line class="chart-grid" x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + w}" y2="${y.toFixed(1)}" />
      <text class="chart-axis" x="${padL - 8}" y="${(y + 3).toFixed(1)}" text-anchor="end">${format(val)}</text>
    `;
  }).join('');

  const paths = series.map(s => {
    const pts = s.values.map((d, i) => {
      const x = padL + i * step;
      const y = padT + h - ((d.y - min) / (max - min)) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    const last = s.values.length - 1;
    const lx = padL + last * step;
    const ly = padT + h - ((s.values[last].y - min) / (max - min)) * h;
    return `
      <path d="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="${s.color}" />
    `;
  }).join('');

  const xTicks = Math.min(12, xs.length);
  const xStep = Math.max(1, Math.floor(xs.length / xTicks));
  const xAxis = xs.map((x, i) => (i % xStep === 0 || i === xs.length - 1)
    ? `<text class="chart-axis" x="${(padL + i * step).toFixed(1)}" y="${(padT + h + 18).toFixed(1)}" text-anchor="middle">${escapeHtml(x)}</text>`
    : '').join('');

  const legend = series.map(s => `
    <span style="display:inline-flex;align-items:center;gap:6px;margin-right:14px;font-size:12px;color:var(--muted);">
      <span style="display:inline-block;width:14px;height:2px;background:${s.color};border-radius:2px;"></span>${escapeHtml(s.name)}
    </span>
  `).join('');

  return `
    <div style="margin-bottom:8px;">${legend}</div>
    <svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      ${gridLines}
      ${paths}
      ${xAxis}
    </svg>
  `;
}

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Loading skeleton for KPI hero
export function KPISkeleton(count = 4) {
  return `
    <div class="kpi-grid">
      ${Array.from({ length: count }).map(() => `
        <div class="kpi">
          <div class="skeleton" style="height: 12px; width: 40%;"></div>
          <div class="skeleton" style="height: 34px; width: 65%;"></div>
          <div class="skeleton" style="height: 42px; width: 100%;"></div>
        </div>
      `).join('')}
    </div>
  `;
}

export function toast(message, ms = 2600) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

// ─── Router ───
function activateTab(tab) {
  if (!TAB_META[tab]) tab = 'overview';
  state.tab = tab;

  // Nav highlight
  document.querySelectorAll('.nav-item').forEach(el => {
    const on = el.dataset.tab === tab;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', String(on));
  });

  // Header
  const meta = TAB_META[tab];
  document.getElementById('page-title').textContent = meta.title;
  document.getElementById('page-sub').textContent = meta.sub;

  // Render
  const root = document.getElementById('tab-root');
  root.innerHTML = KPISkeleton(4);
  // async render — swap on ready
  Promise.resolve()
    .then(() => meta.render(root, { days: state.days }))
    .catch(err => {
      console.error(`[tab:${tab}] render failed`, err);
      root.innerHTML = `
        <div class="card">
          <h3 style="color: var(--red);">Failed to load tab</h3>
          <p class="mono" style="font-size: 12px; color: var(--muted); margin-top: 8px;">${escapeHtml(err.message)}</p>
        </div>
      `;
    });

  // URL hash for shareability
  history.replaceState(null, '', `#${tab}`);
}

function bindNav() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => activateTab(el.dataset.tab));
  });

  // Range picker (MTD / 7d / 30d / 90d / YTD)
  document.querySelectorAll('.range-btn').forEach(el => {
    el.addEventListener('click', () => {
      const period = el.dataset.period;
      state.period = period;
      localStorage.setItem('v2_period', period);
      document.querySelectorAll('.range-btn').forEach(b => b.classList.toggle('active', b === el));
      activateTab(state.tab);
    });
    // Restore active state from persisted period
    if (el.dataset.period === state.period) {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
    }
  });

  // Refresh
  document.getElementById('refresh-btn')?.addEventListener('click', () => activateTab(state.tab));
}

async function checkHealth() {
  const el = document.getElementById('nav-status');
  const txt = document.getElementById('nav-status-text');
  try {
    const r = await api('/api/health');
    el.classList.add('ok');
    txt.textContent = `Connected · ${new Date(r.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  } catch (e) {
    el.classList.add('err');
    txt.textContent = 'Server offline';
  }
}

// ─── Boot ───
window.addEventListener('DOMContentLoaded', () => {
  bindNav();
  // Normalize sub-routes: `#team/eod` → activate `team` tab (sub-route handled inside tab).
  const rawHash = location.hash.replace('#', '').replace(/^\//, '');
  const [primary] = rawHash.split('/');
  activateTab(primary && TAB_META[primary] ? primary : 'overview');
  // Restore full hash so tabs can read their sub-route (activateTab clobbers it in URL).
  if (rawHash.includes('/')) history.replaceState(null, '', `#${rawHash}`);
  checkHealth();
  setInterval(checkHealth, 60_000);
});
