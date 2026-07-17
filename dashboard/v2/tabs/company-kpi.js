// Company KPI — Zach's monthly business dashboard.
// Cross-year matrix modeled after his KPI board: 3 blocks (Marketing/Funnel,
// Efficiency, Cash) × JAN-DEC columns × YTD total column.
import {
  api, fmt, KPI, Card, EmptyState,
  KPISkeleton, escapeHtml,
} from '../app.js';

const MONTH_LABELS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const YEAR_OPTIONS = [2025, 2026, 2027];

// Local UI state — persists across re-renders of this tab.
const state = {
  year: new Date().getFullYear(),
};

// ─── Row spec — declarative table build ───
// format keys: money | int | pct | pct1 | ratio | rocket
// tone lets us color the value cells (green / red / neutral thresholds).
const ROW_BLOCKS = [
  {
    title: 'Marketing + Funnel',
    rows: [
      { key: 'spend',            label: 'Marketing Spend',   format: 'money' },
      { key: 'leads',            label: 'New Leads',         format: 'int', sub: 'Form + Organic' },
      { key: 'calls_15_booked',  label: '15s Booked',        format: 'int' },
      { key: 'calls_15_shown',   label: '15s Shown',         format: 'int' },
      { key: 'calls_45_booked',  label: '45s Booked',        format: 'int' },
      { key: 'calls_45_shown',   label: '45s Shown',         format: 'int' },
      { key: 'sales',            label: 'Total Sales',       format: 'int', emph: true },
    ],
  },
  {
    title: 'Efficiency',
    rows: [
      { key: 'cost_per_lead', label: 'Cost per Lead', format: 'money' },
      { key: 'cost_per_45',   label: 'Cost per 45',   format: 'money' },
      { key: 'cost_per_sale', label: 'Cost per Sale', format: 'money', tone: 'cost_per_sale' },
      { key: 'lead_to_sale',  label: 'Lead → Sale %', format: 'pct' },
      { key: 'show_rate',     label: 'Show Rate %',   format: 'pct' },
      { key: 'close_rate',    label: 'Close Rate %',  format: 'pct', tone: 'close_rate' },
    ],
  },
  {
    title: 'Cash',
    rows: [
      { key: 'cash_collected',     label: 'Cash Collected',        format: 'money', emph: true },
      { key: 'cash_contracted',    label: 'Cash Contracted',       format: 'money' },
      { key: 'total_deal_value',   label: 'Total Deal Value',      format: 'money' },
      { key: 'rocket_collected',   label: 'Rocket Total Collected', format: 'rocket', note: 'External · from finance system' },
      { key: 'profit_after_ads',   label: 'After Ad Spend Profits', format: 'money' },
      { key: 'pct_cash_collected', label: '% Cash Collected',       format: 'pct' },
      { key: 'roas_collected',     label: 'ROAS Collected',         format: 'ratio', tone: 'roas_collected' },
      { key: 'roas_contracted',    label: 'ROAS Contracted',        format: 'ratio' },
    ],
  },
];

// ─── Entry ───
export async function renderCompanyKpi(root, _opts) {
  root.innerHTML = shell(state.year);
  bindYearPicker(root);

  const target = root.querySelector('#ckpi-body');
  target.innerHTML = KPISkeleton(3);

  let data;
  try {
    data = await api(`/api/v2/company-kpi?year=${state.year}`);
  } catch (err) {
    target.innerHTML = renderError(err);
    return;
  }
  target.innerHTML = renderBody(data);
}

function shell(year) {
  return `
    <div class="section-header" style="margin-top:0;">
      <div class="page-sub mono" id="ckpi-updated">Monthly performance · ${year}</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <label style="font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--dim);">Year</label>
        <select id="ckpi-year" style="font:inherit;padding:6px 10px;border:1px solid var(--line);background:var(--cream);border-radius:8px;color:var(--ink);">
          ${YEAR_OPTIONS.map(y => `<option value="${y}" ${y === year ? 'selected' : ''}>${y}</option>`).join('')}
        </select>
      </div>
    </div>
    <div id="ckpi-body"></div>
  `;
}

function bindYearPicker(root) {
  root.querySelector('#ckpi-year')?.addEventListener('change', (e) => {
    state.year = Number(e.target.value);
    renderCompanyKpi(root, {});
  });
}

function renderBody(data) {
  const { months, ytd, current_month_idx: currentIdx } = data;
  const visibleMonths = MONTH_LABELS.slice(0, currentIdx + 1);

  return `
    ${Card({ body: renderTable(months, ytd, visibleMonths) })}
    ${renderFooter(months)}
    <div class="section-header"><h2>Year-to-Date</h2></div>
    ${renderYtdKpis(ytd)}
  `;
}

function renderTable(months, ytd, visibleMonths) {
  const monthCount = visibleMonths.length;
  const header = `
    <thead>
      <tr>
        <th class="ckpi-metric-th">Metric</th>
        ${visibleMonths.map((m, i) => `<th class="num ${i === monthCount - 1 ? 'ckpi-current' : ''}">${m}</th>`).join('')}
        <th class="num ckpi-ytd">YTD</th>
      </tr>
    </thead>
  `;

  const bodyRows = ROW_BLOCKS.map((block, blockIdx) => {
    const rows = block.rows.map(row => renderRow(row, months, ytd, monthCount)).join('');
    const separator = blockIdx > 0
      ? `<tr class="ckpi-block-sep"><td colspan="${monthCount + 2}"><span class="ckpi-block-label">${escapeHtml(block.title)}</span></td></tr>`
      : `<tr class="ckpi-block-sep ckpi-first-block"><td colspan="${monthCount + 2}"><span class="ckpi-block-label">${escapeHtml(block.title)}</span></td></tr>`;
    return `${separator}${rows}`;
  }).join('');

  return `
    <div class="ckpi-scroll">
      <table class="table ckpi-table">
        ${header}
        <tbody>${bodyRows}</tbody>
      </table>
    </div>
  `;
}

function renderRow(row, months, ytd, monthCount) {
  const rowClass = [
    row.emph ? 'ckpi-row-emph' : '',
    row.format === 'rocket' ? 'ckpi-row-rocket' : '',
  ].filter(Boolean).join(' ');

  const cells = months.slice(0, monthCount).map((m, i) => {
    const val = row.format === 'rocket' ? null : m[row.key];
    const isCurrent = i === monthCount - 1;
    const tone = toneClass(row.tone, val);
    return `<td class="num ${isCurrent ? 'ckpi-current' : ''} ${tone}">${formatCell(val, row.format)}</td>`;
  }).join('');

  const ytdVal = row.format === 'rocket' ? null : ytd[row.key];
  const ytdTone = toneClass(row.tone, ytdVal);
  const ytdCell = `<td class="num ckpi-ytd ${ytdTone}">${formatCell(ytdVal, row.format)}</td>`;

  const noteHtml = row.note ? `<span class="ckpi-note">${escapeHtml(row.note)}</span>` : '';
  const subHtml = row.sub ? `<span class="ckpi-sub">${escapeHtml(row.sub)}</span>` : '';

  return `
    <tr class="${rowClass}">
      <td class="ckpi-metric">
        <span class="ckpi-metric-label">${escapeHtml(row.label)}</span>
        ${subHtml}${noteHtml}
      </td>
      ${cells}
      ${ytdCell}
    </tr>
  `;
}

function formatCell(val, format) {
  if (format === 'rocket') return '—';
  if (val == null || Number.isNaN(val)) return '<span class="ckpi-dash">—</span>';
  if (val === 0 && format !== 'pct' && format !== 'ratio') return '<span class="ckpi-dash">—</span>';
  switch (format) {
    case 'money': return escapeHtml(fmt.money(val));
    case 'int':   return escapeHtml(fmt.int(val));
    case 'pct':   return escapeHtml(fmt.pct(val));
    case 'pct1':  return escapeHtml(fmt.pct(val, 1));
    case 'ratio': return escapeHtml(fmt.ratio(val));
    default:      return escapeHtml(String(val));
  }
}

// tone thresholds match spec: cost-per-sale, close-rate, roas-collected
function toneClass(tone, val) {
  if (val == null || Number.isNaN(val)) return '';
  switch (tone) {
    case 'cost_per_sale':
      if (val > 500) return 'ckpi-bad';
      if (val < 300 && val > 0) return 'ckpi-good';
      return '';
    case 'close_rate':
      if (val > 0.20) return 'ckpi-good';
      if (val < 0.10) return 'ckpi-bad';
      return '';
    case 'roas_collected':
      if (val > 2) return 'ckpi-good';
      if (val < 1) return 'ckpi-bad';
      return '';
    default: return '';
  }
}

function renderFooter(months) {
  const anySpend = months.some(m => m.spend > 0);
  const notes = [];
  if (!anySpend) {
    notes.push('No Meta ad spend synced yet — populate `ad_metrics` via `POST /api/v2/ads/sync` to fill CPL / CPS / ROAS.');
  }
  notes.push('15s vs 45s split uses Zach\'s biweekly rule: a call counts as 15 only when date_15 is present and date_45 is empty.');
  notes.push('Rocket Total Collected is a placeholder — Zach\'s finance system feeds later.');
  return `
    <div class="ckpi-footnote">
      ${notes.map(n => `<div>• ${escapeHtml(n)}</div>`).join('')}
    </div>
  `;
}

function renderYtdKpis(ytd) {
  return `
    <div class="kpi-grid">
      ${KPI({
        label: 'YTD Cash Collected',
        value: fmt.money(ytd.cash_collected, { short: true }),
        sub: `${fmt.money(ytd.cash_contracted, { short: true })} contracted`,
      })}
      ${KPI({
        label: 'YTD New Leads',
        value: fmt.int(ytd.leads),
        sub: `${fmt.int(ytd.sales)} sales · ${ytd.lead_to_sale != null ? fmt.pct(ytd.lead_to_sale, 1) : '—'} lead → sale`,
      })}
      ${KPI({
        label: 'YTD Close Rate',
        value: ytd.close_rate != null ? fmt.pct(ytd.close_rate, 1) : '—',
        sub: `${fmt.int(ytd.sales)} closed of ${fmt.int(ytd.calls_15_shown + ytd.calls_45_shown)} shown`,
      })}
    </div>
  `;
}

function renderError(err) {
  return `
    <div class="card">
      <h3 style="color:var(--red);">Failed to load Company KPI</h3>
      <p class="mono" style="font-size:12px;color:var(--muted);margin-top:8px;">${escapeHtml(err.message)}</p>
    </div>
  `;
}

// Inject scoped table styles once (avoid touching styles.css for a tab-scoped need).
(function ensureStyles() {
  if (document.getElementById('ckpi-styles')) return;
  const s = document.createElement('style');
  s.id = 'ckpi-styles';
  s.textContent = `
    .ckpi-scroll { overflow-x: auto; margin: 0 -14px; padding: 0 14px; }
    .ckpi-table { min-width: 900px; }
    .ckpi-table th, .ckpi-table td { padding: 8px 12px; }
    .ckpi-table thead th { background: var(--cream-2); position: sticky; top: 0; z-index: 2; }
    .ckpi-table th.ckpi-metric-th, .ckpi-table td.ckpi-metric {
      position: sticky; left: 0; z-index: 3;
      background: var(--cream); border-right: 1px solid var(--line);
      min-width: 200px;
    }
    .ckpi-table thead th.ckpi-metric-th { background: var(--cream-2); z-index: 4; }
    .ckpi-metric-label { color: var(--ink); font-weight: 500; display: block; font-size: 13px; }
    .ckpi-sub { color: var(--dim); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; display: block; margin-top: 2px; }
    .ckpi-note { color: var(--dim); font-size: 10px; font-style: italic; display: block; margin-top: 2px; }
    .ckpi-current { background: rgba(193, 139, 157, 0.05); }
    .ckpi-ytd { background: var(--cream-2); font-weight: 600; color: var(--ink); border-left: 2px solid var(--mauve); }
    .ckpi-block-sep td {
      background: var(--cream-2);
      padding: 12px 14px 6px !important;
      border-bottom: 1px solid var(--line-2);
      border-top: 1px solid var(--line-2);
    }
    .ckpi-block-sep.ckpi-first-block td { border-top: 0; }
    .ckpi-block-label {
      font-size: 10px; text-transform: uppercase; letter-spacing: 0.12em;
      color: var(--mauve-2); font-weight: 600;
    }
    .ckpi-row-emph td { font-weight: 600; }
    .ckpi-row-emph .ckpi-metric-label { color: var(--ink); }
    .ckpi-row-rocket td { background: var(--mauve-tint); }
    .ckpi-row-rocket td.ckpi-metric { background: var(--mauve-tint); border-right-color: var(--mauve); }
    .ckpi-dash { color: var(--dim); }
    .ckpi-good { color: var(--green); }
    .ckpi-bad  { color: var(--red); }
    .ckpi-footnote {
      margin-top: 10px; padding: 12px 14px;
      background: var(--cream-2); border-radius: 8px;
      font-size: 11px; color: var(--muted); line-height: 1.6;
    }
  `;
  document.head.appendChild(s);
})();
