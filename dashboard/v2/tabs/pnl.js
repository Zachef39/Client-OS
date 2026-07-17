// P&L tab — revenue (Stripe) + expenses (Supabase) + CSV import
import {
  api, fmt, KPI, Card, EmptyState, BarList, DualLineChart,
  KPISkeleton, escapeHtml, toast,
} from '../app.js';

const state = {
  period: 'mtd',
  categories: null,
};

export async function renderPnl(root, _opts) {
  // Reset when tab re-renders (range picker toggles fire re-render)
  root.innerHTML = shell(state.period);
  bindPeriod(root);
  await loadAll(root);
}

function shell(period) {
  const periods = [
    { key: 'mtd', label: 'MTD' },
    { key: 'last30', label: 'Last 30' },
    { key: 'ytd', label: 'YTD' },
  ];
  return `
    <div class="section-header" style="margin-top:0;">
      <div>
        <div class="page-sub mono" id="pnl-updated">Loading…</div>
      </div>
      <div style="display:flex;gap:6px;">
        ${periods.map(p => `
          <button class="btn ghost pnl-period ${p.key === period ? 'active' : ''}" data-period="${p.key}">${p.label}</button>
        `).join('')}
      </div>
    </div>

    <div id="pnl-kpis">${KPISkeleton(4)}</div>

    <div class="section-header">
      <h2>12-month revenue vs expenses</h2>
    </div>
    <div id="pnl-chart">${Card({ body: '<div class="skeleton" style="height:220px;width:100%;"></div>' })}</div>

    <div class="section-header">
      <h2>Expense breakdown</h2>
      <div style="display:flex;gap:8px;">
        <input type="file" id="pnl-csv-input" accept=".csv,text/csv" style="display:none;" />
        <button class="btn ghost" id="pnl-import-btn">↑ Import CSV</button>
      </div>
    </div>
    <div style="display:grid;grid-template-columns: 1fr 1.4fr; gap:16px;">
      <div id="pnl-categories">${Card({ title: 'By category', body: '<div class="skeleton" style="height:220px;"></div>' })}</div>
      <div id="pnl-rows">${Card({ title: 'Recent expenses', body: '<div class="skeleton" style="height:220px;"></div>' })}</div>
    </div>
  `;
}

function bindPeriod(root) {
  root.querySelectorAll('.pnl-period').forEach(btn => {
    btn.addEventListener('click', () => {
      state.period = btn.dataset.period;
      renderPnl(root, {});
    });
  });
}

async function loadAll(root) {
  const { period } = state;
  const [summary, expenses, monthly, catsResp] = await Promise.all([
    api(`/api/v2/pnl/summary?period=${period}`).catch(err => ({ _err: err.message })),
    api(`/api/v2/pnl/expenses?period=${period}&limit=100`).catch(err => ({ _err: err.message })),
    api(`/api/v2/pnl/monthly?months=12`).catch(err => ({ _err: err.message })),
    state.categories ? { categories: state.categories } : api(`/api/v2/pnl/categories`).catch(() => ({ categories: [] })),
  ]);
  state.categories = catsResp.categories || [];

  root.querySelector('#pnl-updated').textContent = summary._err
    ? `Failed to load summary — ${summary._err}`
    : `${periodLabel(period)} · updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;

  root.querySelector('#pnl-kpis').innerHTML = summary._err ? errorCard(summary._err) : renderKpis(summary);
  root.querySelector('#pnl-chart').innerHTML = monthly._err
    ? errorCard(monthly._err)
    : Card({ body: renderMonthly(monthly) });
  root.querySelector('#pnl-categories').innerHTML = expenses._err
    ? errorCard(expenses._err)
    : Card({ title: 'By category', meta: `${fmt.money(expenses.total)} total`, body: renderCategories(expenses.categories) });
  root.querySelector('#pnl-rows').innerHTML = expenses._err
    ? errorCard(expenses._err)
    : Card({ title: 'Recent expenses', meta: `${expenses.rows.length} rows`, body: renderRows(expenses.rows, state.categories, root) });

  wireCategoryEdits(root);
  wireImportButton(root);
}

function periodLabel(p) {
  return { mtd: 'Month-to-date', last30: 'Last 30 days', ytd: 'Year-to-date' }[p] || p;
}

function renderKpis(summary) {
  const netColor = summary.net >= 0 ? 'var(--green)' : 'var(--red)';
  const netSub = summary.net >= 0
    ? `${fmt.pct(summary.revenue > 0 ? summary.net / summary.revenue : 0)} margin`
    : 'Loss — spending > revenue';

  // Runway = expenses / (avg daily net burn) — only meaningful if net < 0
  // Simple version: cash_on_hand is unknown, so we show "avg monthly burn" instead
  const days = daysInPeriod(summary.window);
  const monthlyBurn = days > 0 ? (summary.expenses / days) * 30 : 0;
  const runwayLabel = monthlyBurn > 0 ? `${fmt.money(monthlyBurn, { short: true })}/mo` : '—';

  return `
    <div class="kpi-grid">
      ${KPI({
        label: `Revenue · ${periodLabel(state.period)}`,
        value: fmt.money(summary.revenue, { short: true }),
        sub: summary.revenue_count > 0
          ? `${summary.revenue_count} charges`
          : (summary.revenue_warning || 'No revenue synced for this period'),
        spark: summary.spark_revenue,
      })}
      ${KPI({
        label: 'Expenses',
        value: fmt.money(summary.expenses, { short: true }),
        sub: summary.expenses > 0 ? 'From imported CSV' : 'No CSV imported yet',
        spark: summary.spark_expenses,
      })}
      ${kpiWithColor({
        label: 'Net Profit',
        value: summary.net < 0
          ? `-${fmt.money(Math.abs(summary.net), { short: true })}`
          : fmt.money(summary.net, { short: true }),
        sub: netSub,
        color: netColor,
      })}
      ${KPI({
        label: 'Burn Rate',
        value: runwayLabel,
        sub: 'Extrapolated from period expenses',
        spark: null,
      })}
    </div>
  `;
}

// Local variant of KPI that lets us color the value (net profit uses green/red)
function kpiWithColor({ label, value, sub, color }) {
  return `
    <article class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value" style="color:${color};">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </article>
  `;
}

function renderMonthly(monthly) {
  const rows = monthly.rows || [];
  if (!rows.length || rows.every(r => r.revenue === 0 && r.expenses === 0)) {
    return EmptyState({ title: 'No monthly data yet.', message: 'Stripe revenue + imported expenses will populate this chart.' });
  }
  const shortMonth = (m) => {
    // "2026-05" → "May '26"
    const [y, mm] = m.split('-');
    const d = new Date(Number(y), Number(mm) - 1, 1);
    return d.toLocaleDateString('en-US', { month: 'short' }) + " '" + y.slice(2);
  };
  return DualLineChart([
    {
      name: 'Revenue',
      color: '#4a9d5f',
      values: rows.map(r => ({ x: shortMonth(r.month), y: r.revenue })),
    },
    {
      name: 'Expenses',
      color: '#c94a4a',
      values: rows.map(r => ({ x: shortMonth(r.month), y: r.expenses })),
    },
  ], { format: v => fmt.money(v, { short: true }) });
}

function renderCategories(categories) {
  if (!categories?.length) {
    return EmptyState({ title: 'No expenses yet.', message: 'Click Import CSV to categorize.' });
  }
  const top = categories.slice(0, 8);
  const restVal = categories.slice(8).reduce((s, c) => s + c.value, 0);
  const rows = restVal > 0 ? [...top, { label: 'Other categories', value: restVal }] : top;
  return BarList(rows, { format: v => fmt.money(v, { short: true }) });
}

function renderRows(rows, categories, _root) {
  if (!rows?.length) {
    return EmptyState({
      icon: '§',
      title: 'No expenses imported yet',
      message: 'Click Import CSV to get started.',
    });
  }
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Date</th>
          <th>Merchant</th>
          <th class="num">Amount</th>
          <th>Category</th>
          <th>Source</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="mono">${fmt.date(r.date)}</td>
            <td>${escapeHtml(r.merchant || '—')}</td>
            <td class="num">${fmt.money(r.amount)}</td>
            <td>
              <select class="pnl-cat-select" data-id="${r.id}" data-current="${escapeHtml(r.category || '')}" style="background:transparent;border:1px solid var(--line);padding:2px 6px;border-radius:6px;font-size:12px;color:var(--muted);">
                ${categories.map(c => `<option value="${c}" ${c === r.category ? 'selected' : ''}>${c}</option>`).join('')}
                ${!categories.includes(r.category) && r.category ? `<option value="${escapeHtml(r.category)}" selected>${escapeHtml(r.category)}</option>` : ''}
              </select>
            </td>
            <td class="mono" style="font-size:11px;color:var(--dim);" title="${escapeHtml(r.source_file || '')}">${escapeHtml((r.source_file || '').slice(0, 20))}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function wireCategoryEdits(root) {
  root.querySelectorAll('.pnl-cat-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.id;
      const newCat = sel.value;
      const prev = sel.dataset.current;
      sel.disabled = true;
      try {
        await api(`/api/v2/pnl/expenses/${id}/category`, {
          method: 'POST',
          body: { category: newCat },
        });
        sel.dataset.current = newCat;
        toast(`Category updated → ${newCat}`);
      } catch (err) {
        toast(`Update failed: ${err.message}`);
        sel.value = prev;
      } finally {
        sel.disabled = false;
      }
    });
  });
}

function wireImportButton(root) {
  const btn = root.querySelector('#pnl-import-btn');
  const input = root.querySelector('#pnl-csv-input');
  if (!btn || !input) return;

  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = 'Parsing…';
    try {
      const text = await file.text();
      const result = await api('/api/v2/pnl/import-csv', {
        method: 'POST',
        body: { filename: file.name, csv_text: text },
      });
      toast(`Imported ${result.imported} rows · ${result.categorized} via LLM · ${result.rule_matched} via rules`);
      input.value = '';
      renderPnl(root, {});
    } catch (err) {
      toast(`Import failed: ${err.message}`);
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

function daysInPeriod(window) {
  if (!window?.start || !window?.end) return 0;
  const ms = new Date(window.end) - new Date(window.start);
  return Math.max(1, Math.round(ms / 86400000) + 1);
}

function errorCard(msg) {
  return `
    <div class="card">
      <h3 style="color: var(--red);">Failed to load</h3>
      <p class="mono" style="font-size: 12px; color: var(--muted); margin-top: 8px;">${escapeHtml(msg)}</p>
    </div>
  `;
}
