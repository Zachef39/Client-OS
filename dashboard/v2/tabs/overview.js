// Overview tab — daily CEO cockpit.
// Data model: /api/v2/overview/kpis (WoW logic) + /api/v2/booked-calls/* (real closers/setters).
// Sections: KPIs → Sales snapshot → Per-Closer → Per-Setter → Lost Reasons → Recent Sales.
import {
  api, fmt, Card, EmptyState, StatusPill, Sparkline,
  escapeHtml, KPISkeleton, getRangeDays,
} from '../app.js';

const UNASSIGNED = '(unassigned)';

export async function renderOverview(root) {
  // Boot skeleton
  root.innerHTML = `
    ${KPISkeleton(4)}
    <div class="row" style="margin-top: var(--s-5);">
      <section class="card"><div class="skeleton" style="height: 140px; width: 100%;"></div></section>
      <section class="card"><div class="skeleton" style="height: 140px; width: 100%;"></div></section>
      <section class="card"><div class="skeleton" style="height: 140px; width: 100%;"></div></section>
      <section class="card"><div class="skeleton" style="height: 140px; width: 100%;"></div></section>
    </div>
  `;

  const days = getRangeDays();

  // Fire every endpoint in parallel — each fails independently.
  const [kpisR, bcSumR, bcCloserR, bcSetterR, bcLostR, salesR] = await Promise.allSettled([
    api('/api/v2/overview/kpis'),
    api(`/api/v2/booked-calls/summary?days=${days}`),
    api(`/api/v2/booked-calls/by-closer?days=${days}`),
    api(`/api/v2/booked-calls/by-setter?days=${days}`),
    api(`/api/v2/booked-calls/lost-reasons?days=${days}`),
    api(`/api/v2/sales/summary?days=${days}`),
  ]);

  const kpis = pick(kpisR);
  const bcSum = pick(bcSumR);
  const bcCloser = pick(bcCloserR);
  const bcSetter = pick(bcSetterR);
  const bcLost = pick(bcLostR);
  const sales = pick(salesR);

  // Sync time — newest of the freshness-carrying endpoints
  const syncedAt = [kpis?.synced_at, bcSum?.window?.end].filter(Boolean).sort().pop();

  root.innerHTML = `
    ${renderKpiRow(kpis, bcSum)}
    ${renderSnapshotRow(bcSum, kpis)}
    ${renderCloserTable(bcCloser)}
    ${renderSetterTable(bcSetter)}
    ${renderLostReasons(bcLost)}
    ${renderRecentSales(sales)}
    ${renderSyncFooter(syncedAt)}
  `;
}

function pick(r) { return r.status === 'fulfilled' ? r.value : null; }

// ─── Row 1: KPI cards ──────────────────────────────────────
function renderKpiRow(kpis, bcSum) {
  if (!kpis) return renderInlineError('KPIs failed to load.');
  const { mtd, clients, resigns } = kpis;

  // Card 1 — MTD Cash Collected (WoW delta chip + spark from bcSum)
  const cashDelta = deltaChip(mtd?.cash_delta_wow, { format: fmt.pct });
  const collectedCard = `
    <article class="kpi">
      <div class="kpi-label">MTD Cash Collected</div>
      <div class="kpi-value">${fmt.money(mtd?.cash_collected, { short: true })}</div>
      <div class="kpi-sub">${cashDelta}<span>vs prior 7d</span></div>
      ${Sparkline(kpis?.ads?.spark_cash || [])}
    </article>
  `;

  // Card 2 — MTD Cash Contracted (new)
  const collectedForRatio = mtd?.cash_collected || 0;
  const contracted = mtd?.cash_contracted || 0;
  const outstanding = Math.max(0, contracted - collectedForRatio);
  const contractedCard = `
    <article class="kpi">
      <div class="kpi-label">MTD Cash Contracted</div>
      <div class="kpi-value">${fmt.money(contracted, { short: true })}</div>
      <div class="kpi-sub">
        <span class="pill mauve">${fmt.money(outstanding, { short: true })} outstanding</span>
      </div>
      <div class="spark"></div>
    </article>
  `;

  // Card 3 — Active Clients
  const newChip = clients?.new_this_month > 0
    ? `<span class="pill pos">+${clients.new_this_month} new</span>`
    : `<span class="pill neu">+0 new this month</span>`;
  const clientsCard = `
    <article class="kpi">
      <div class="kpi-label">Active Clients</div>
      <div class="kpi-value">${fmt.int(clients?.active)}</div>
      <div class="kpi-sub">${newChip}</div>
      <div class="spark"></div>
    </article>
  `;

  // Card 4 — Upcoming Resigns (accent red if critical_7d > 0)
  const critical7 = resigns?.critical_7d || 0;
  const accent = critical7 > 0 ? ' accent-red' : '';
  const resignSub = critical7 > 0
    ? `<span class="pill red">${critical7} ≤ 7d</span><span>${resigns?.total_30d || 0} within 30d</span>`
    : `<span class="pill neu">${resigns?.total_30d || 0} within 30d</span>`;
  const resignsCard = `
    <article class="kpi${accent}">
      <div class="kpi-label">Upcoming Resigns</div>
      <div class="kpi-value">${fmt.int(resigns?.total_30d || 0)}</div>
      <div class="kpi-sub">${resignSub}</div>
      <div class="spark"></div>
    </article>
  `;

  return `
    <div class="kpi-grid">
      ${collectedCard}
      ${contractedCard}
      ${clientsCard}
      ${resignsCard}
    </div>
  `;
}

// ─── Row 2: Sales snapshot (Booked / Shown / Closed / Close Rate) ─────
function renderSnapshotRow(bcSum, kpis) {
  if (!bcSum?.totals) return renderInlineError('Sales snapshot failed to load.');
  const t = bcSum.totals;

  // Close-rate pill color
  const cr = t.close_rate || 0;
  const crCls = cr >= 0.20 ? 'green' : cr >= 0.10 ? 'yellow' : 'red';
  const crLabel = fmt.pct(cr, 1);

  // Booked WoW — reuse the cash_delta_wow chip for now (Booked is same 30d window;
  //   real WoW would need a separate endpoint). Keep neutral to avoid misleading Zach.
  const bookedCard = `
    <article class="kpi">
      <div class="kpi-label">Booked · 30d</div>
      <div class="kpi-value">${fmt.int(t.booked)}</div>
      <div class="kpi-sub"><span>Monday + GHL, deduped</span></div>
      ${Sparkline(bcSum.spark_booked || [])}
    </article>
  `;

  const shownPct = t.booked > 0 ? t.shown / t.booked : 0;
  const shownPill = shownPct >= 0.75 ? 'green' : shownPct >= 0.6 ? 'yellow' : 'red';
  const shownCard = `
    <article class="kpi">
      <div class="kpi-label">Shown · 30d</div>
      <div class="kpi-value">${fmt.int(t.shown)}</div>
      <div class="kpi-sub"><span class="pill ${shownPill}">${fmt.pct(shownPct, 0)} of booked</span></div>
      ${Sparkline(bcSum.spark_shown || [])}
    </article>
  `;

  const closedPct = t.shown > 0 ? t.closed / t.shown : 0;
  const closedPill = closedPct >= 0.20 ? 'green' : closedPct >= 0.10 ? 'yellow' : 'red';
  const closedCard = `
    <article class="kpi">
      <div class="kpi-label">Closed · 30d</div>
      <div class="kpi-value">${fmt.int(t.closed)}</div>
      <div class="kpi-sub"><span class="pill ${closedPill}">${fmt.pct(closedPct, 0)} of shown</span></div>
      ${Sparkline(bcSum.spark_closed || [])}
    </article>
  `;

  const closeRateCard = `
    <article class="kpi">
      <div class="kpi-label">Close Rate · 30d</div>
      <div class="kpi-value">${crLabel}</div>
      <div class="kpi-sub"><span class="pill ${crCls}">${cr >= 0.20 ? 'healthy' : cr >= 0.10 ? 'watch' : 'below target'}</span></div>
      <div class="spark"></div>
    </article>
  `;

  return `
    <div class="section-header" style="margin-top: var(--s-5);">
      <h2>Sales Snapshot</h2>
      <span class="hint">${bcSum.window.start} → ${bcSum.window.end}</span>
    </div>
    <div class="kpi-grid">
      ${bookedCard}
      ${shownCard}
      ${closedCard}
      ${closeRateCard}
    </div>
  `;
}

// ─── Row 3: Per-Closer table ───────────────────────────────
function renderCloserTable(bcCloser) {
  const rows = (bcCloser?.closers || []).filter(c => c.closer !== UNASSIGNED);
  const body = rows.length === 0
    ? EmptyState({ title: 'No closer data yet.', message: 'Assign the "45 Call" person on Monday to see the breakdown.' })
    : `
      <table class="table">
        <thead>
          <tr>
            <th>Closer</th>
            <th class="num">Booked</th>
            <th class="num">Shown</th>
            <th class="num">Closed</th>
            <th class="num">Close Rate</th>
            <th class="num">Cash Collected</th>
            <th class="num">Cash Contracted</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const cr = r.close_rate;
            const crCls = cr == null ? 'grey' : cr >= 0.20 ? 'green' : cr >= 0.10 ? 'yellow' : 'red';
            const crLabel = cr == null ? '—' : fmt.pct(cr, 0);
            return `
              <tr>
                <td>${escapeHtml(r.closer)}</td>
                <td class="num">${fmt.int(r.booked)}</td>
                <td class="num">${fmt.int(r.shown)}</td>
                <td class="num">${fmt.int(r.closed)}</td>
                <td class="num">${StatusPill(crCls, crLabel)}</td>
                <td class="num">${fmt.money(r.cash_collected, { short: true })}</td>
                <td class="num">${fmt.money(r.cash_contracted, { short: true })}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

  return `
    <div class="row">
      ${Card({ title: 'Per-Closer · 30d', meta: 'Real closers only', body })}
    </div>
  `;
}

// ─── Row 4: Per-Setter table ───────────────────────────────
function renderSetterTable(bcSetter) {
  const rows = (bcSetter?.setters || []).filter(s => s.setter !== UNASSIGNED);
  const body = rows.length === 0
    ? EmptyState({ title: 'No setter data yet.', message: 'Assign the "DMer" person on Monday to see the breakdown.' })
    : `
      <table class="table">
        <thead>
          <tr>
            <th>Setter</th>
            <th class="num">Booked Calls</th>
            <th class="num">Closed Calls</th>
            <th class="num">Booked → Closed</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(r => {
            const rate = r.booked > 0 ? r.closed / r.booked : 0;
            const rateCls = rate >= 0.15 ? 'green' : rate >= 0.07 ? 'yellow' : 'red';
            const rateLabel = r.booked > 0 ? fmt.pct(rate, 0) : '—';
            return `
              <tr>
                <td>${escapeHtml(r.setter)}</td>
                <td class="num">${fmt.int(r.booked)}</td>
                <td class="num">${fmt.int(r.closed)}</td>
                <td class="num">${StatusPill(rateCls, rateLabel)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

  return `
    <div class="row">
      ${Card({ title: 'Per-Setter · 30d', meta: 'DM booking engine', body })}
    </div>
  `;
}

// ─── Row 5: Lost Reasons ───────────────────────────────────
function renderLostReasons(bcLost) {
  const reasons = (bcLost?.reasons || []).slice(0, 8);
  const body = reasons.length === 0
    ? EmptyState({ title: 'No lost reasons yet.', message: 'Fill the "Lost Reason" column on Monday to surface signal here.' })
    : renderLostBars(reasons);

  return `
    <div class="row">
      ${Card({ title: 'Lost Reasons · 30d', meta: 'Top 8 why-we-lost', body })}
    </div>
  `;
}

function renderLostBars(reasons) {
  const max = Math.max(...reasons.map(r => r.count), 1);
  return `
    <div class="barlist">
      ${reasons.map(r => {
        const pct = Math.max(4, Math.min(100, (r.count / max) * 100));
        return `
          <div class="barlist-row">
            <div class="barlist-label" title="${escapeHtml(r.reason)}">${escapeHtml(r.reason)}</div>
            <div class="barlist-track"><div class="barlist-fill" style="width: ${pct}%;"></div></div>
            <div class="barlist-value">${fmt.int(r.count)}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ─── Row 6: Recent Sales table ─────────────────────────────
function renderRecentSales(sales) {
  const rows = (sales?.recent_sales || []).slice(0, 10);
  const body = rows.length === 0
    ? EmptyState({ title: 'No sales yet in this window.', message: 'When Monday logs a sale, it will show up here.' })
    : `
      <table class="table">
        <thead>
          <tr>
            <th>Client</th>
            <th>Program</th>
            <th>Outcome</th>
            <th class="num">Contracted</th>
            <th class="num">Collected</th>
            <th class="num">Date</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(s => {
            const date = s.d45 || s.d15 || '';
            return `
              <tr>
                <td>${escapeHtml(s.name)}</td>
                <td>${escapeHtml(s.program || '—')}</td>
                <td>${escapeHtml(s.outcome || '—')}</td>
                <td class="num">${fmt.money(s.contracted, { short: true })}</td>
                <td class="num">${fmt.money(s.collected, { short: true })}</td>
                <td class="num">${fmt.date(date)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

  return `
    <div class="row">
      ${Card({ title: 'Recent Sales', meta: 'Last 10 closed in the window', body })}
    </div>
  `;
}

// ─── Helpers ───────────────────────────────────────────────
function deltaChip(delta, { invert = false, format = fmt.pct } = {}) {
  if (!delta) return '';
  const { pct, dir } = delta;
  if (dir === 'flat' && (pct == null || Math.abs(pct) < 0.005)) {
    return `<span class="pill neu">—</span>`;
  }
  const isGood = invert ? (dir === 'down') : (dir === 'up');
  const cls = isGood ? 'pos' : 'neg';
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '·';
  const label = pct == null ? 'new' : format(Math.abs(pct));
  return `<span class="pill ${cls}">${arrow} ${label}</span>`;
}

function renderInlineError(msg) {
  return `
    <div class="card" style="border-color: var(--red-tint);">
      <p style="color: var(--red); font-size: var(--f-sm); margin: 0;">${escapeHtml(msg)}</p>
    </div>
  `;
}

function renderSyncFooter(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `
    <div class="sync-footer">
      <span class="dot"></span>
      <span>Data synced ${timeStr}</span>
    </div>
  `;
}
