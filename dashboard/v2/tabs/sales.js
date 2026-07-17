// Sales tab — booked/shown/closed funnel + per-closer breakdown + lead source
import { api, fmt, KPI, Card, EmptyState, StatusPill, escapeHtml, KPISkeleton, BarList } from '../app.js';

export async function renderSales(root, { days }) {
  root.innerHTML = KPISkeleton(4);

  let summary, byCloser;
  try {
    [summary, byCloser] = await Promise.all([
      api(`/api/v2/sales/summary?days=${days}`),
      api(`/api/v2/sales/by-closer?days=${days}`),
    ]);
  } catch (err) {
    root.innerHTML = renderError(err);
    return;
  }

  const showRate = summary.booked ? summary.shown / summary.booked : null;
  const closeRate = summary.shown ? summary.closed / summary.shown : null;

  root.innerHTML = `
    <div class="kpi-grid">
      ${KPI({
        label: 'Booked Calls',
        value: fmt.int(summary.booked),
        sub: `${summary.booked_15 || 0} × 15 · ${summary.booked_45 || 0} × 45`,
        spark: summary.spark_booked || [],
      })}
      ${KPI({
        label: 'Shown',
        value: fmt.int(summary.shown),
        sub: showRate != null ? `${fmt.pct(showRate)} show rate` : 'No shows yet.',
        spark: summary.spark_shown || [],
      })}
      ${KPI({
        label: 'Closed',
        value: fmt.int(summary.closed),
        sub: closeRate != null ? `${fmt.pct(closeRate)} close rate` : 'No closes yet.',
        spark: summary.spark_closed || [],
      })}
      ${KPI({
        label: 'Cash Collected',
        value: fmt.money(summary.cash_collected, { short: true }),
        sub: `${fmt.money(summary.cash_contracted, { short: true })} contracted · ${fmt.money(summary.acv)} ACV`,
        spark: summary.spark_cash || [],
      })}
    </div>

    <div class="section-header">
      <h2>Per Closer</h2>
      <span class="hint">Last ${days} days</span>
    </div>
    ${Card({ body: renderCloserTable(byCloser.closers || []) })}

    <div class="section-header">
      <h2>Lost reasons</h2>
      <span class="hint">Where deals died</span>
    </div>
    ${Card({ body: BarList((summary.lost_reasons || []).map(r => ({ label: r.reason, value: r.count })), { format: fmt.int }) })}

    <div class="section-header">
      <h2>Recent sales</h2>
      <span class="hint">Contracted &gt; 0 in window</span>
    </div>
    ${Card({ body: renderRecentSales(summary.recent_sales || []) })}
  `;
}

function renderCloserTable(closers) {
  if (!closers.length) return EmptyState({ title: 'No closer data.', message: 'Fill "Set By" or "Closed By" on the Booked Calls board.' });
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Closer</th>
          <th class="num">Booked</th>
          <th class="num">Shown</th>
          <th class="num">Closed</th>
          <th class="num">Close %</th>
          <th class="num">Cash</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${closers.map(c => {
          const rate = c.shown ? c.closed / c.shown : null;
          return `
            <tr>
              <td>${escapeHtml(c.closer || '—')}</td>
              <td class="num">${fmt.int(c.booked)}</td>
              <td class="num">${fmt.int(c.shown)}</td>
              <td class="num">${fmt.int(c.closed)}</td>
              <td class="num">${rate != null ? fmt.pct(rate) : '—'}</td>
              <td class="num">${fmt.money(c.cash_collected, { short: true })}</td>
              <td>${rateStatus(rate)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function rateStatus(rate) {
  if (rate == null) return '';
  if (rate >= 0.4) return StatusPill('green', 'strong');
  if (rate >= 0.3) return StatusPill('yellow', 'ok');
  return StatusPill('red', 'low');
}

function renderRecentSales(sales) {
  if (!sales.length) return EmptyState({ title: 'No sales in this window yet.' });
  return `
    <table class="table">
      <thead>
        <tr>
          <th>Client</th>
          <th>Program</th>
          <th class="num">Contracted</th>
          <th class="num">Collected</th>
          <th>Outcome</th>
          <th>Date</th>
        </tr>
      </thead>
      <tbody>
        ${sales.slice(0, 12).map(s => `
          <tr>
            <td>${escapeHtml(s.name)}</td>
            <td>${escapeHtml(s.program || '—')}</td>
            <td class="num">${fmt.money(s.contracted, { short: true })}</td>
            <td class="num">${fmt.money(s.collected, { short: true })}</td>
            <td><span class="pill grey">${escapeHtml(s.outcome || '—')}</span></td>
            <td>${fmt.date(s.d45 || s.d15)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function renderError(err) {
  return `
    <div class="card">
      <h3 style="color: var(--red);">Sales tab failed to load</h3>
      <p class="mono" style="font-size: 12px; color: var(--muted); margin-top: 8px;">${escapeHtml(err.message)}</p>
      <p style="margin-top: 12px; color: var(--muted); font-size: 13px;">Check that MONDAY_API_TOKEN + MONDAY_BOARD_ID are set in <code>.env</code>.</p>
    </div>
  `;
}
