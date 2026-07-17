// Team KPI — Setters (DM section) + Closers (Closer section).
// Data flows:
//   - /api/v2/team/setters  ← Monday EOD-DMs + Booked Calls setter attribution
//   - /api/v2/team/closers  ← Booked Calls closer attribution
//   - /api/v2/team/eod-dms/latest  ← per-setter daily sparklines
//   - /api/v2/team/latest-eod       ← "not logged today" nudge callout
import {
  api, fmt, KPI, Card, EmptyState, StatusPill,
  escapeHtml, KPISkeleton, Sparkline,
} from '../app.js';

// ─── Entry ───
export async function renderTeam(root, { days }) {
  root.innerHTML = KPISkeleton(4);

  let setters, closers, dailyDms, latestEod;
  try {
    [setters, closers, dailyDms, latestEod] = await Promise.all([
      api(`/api/v2/team/setters?days=${days}`),
      api(`/api/v2/team/closers?days=${days}`),
      api(`/api/v2/team/eod-dms/latest?days=${Math.min(days, 30)}`),
      api(`/api/v2/team/latest-eod`),
    ]);
  } catch (err) {
    root.innerHTML = renderError(err);
    return;
  }

  const totalDms = setters.totals?.dms_sent || 0;
  const totalCalls = setters.totals?.calls_booked || 0;
  const closerTotals = closers.totals || {};
  const adSpend = setters.totals?.ad_spend || 0;
  const costPerCall = totalCalls > 0 ? adSpend / totalCalls : null;

  // Sparklines: team-wide per-day calls booked from EOD board
  const dailyBookedSpark = buildTeamDailySpark(dailyDms.setters || {}, days);

  root.innerHTML = `
    <div class="kpi-grid">
      ${KPI({
        label: `Calls Booked (${days}d)`,
        value: fmt.int(totalCalls),
        sub: `${(setters.setters || []).length} active setters`,
        spark: dailyBookedSpark,
      })}
      ${KPI({
        label: `DMs Sent (${days}d)`,
        value: totalDms > 0 ? fmt.int(totalDms) : '—',
        sub: totalDms > 0
          ? `${fmt.int(totalDms / totalCalls || 0)} per booked call`
          : 'Monday EOD board tracks calls only.',
      })}
      ${KPI({
        label: 'Team Close Rate',
        value: closerTotals.close_rate != null ? fmt.pct(closerTotals.close_rate, 1) : '—',
        sub: `${fmt.int(closerTotals.closed)} closed of ${fmt.int(closerTotals.shown)} shown`,
      })}
      ${KPI({
        label: 'Cost / Booked Call',
        value: costPerCall != null ? fmt.money(costPerCall) : '—',
        sub: `${fmt.money(adSpend, { short: true })} ad spend`,
      })}
    </div>

    <div class="section-header">
      <h2>Setters</h2>
      <span class="hint">DM volume + booked-call attribution · last ${days}d</span>
    </div>
    ${Card({ body: renderSetterTable(setters.setters || [], dailyDms.setters || {}) })}

    <div class="section-header">
      <h2>Closers</h2>
      <span class="hint">Calls taken, shown, closed · last ${days}d</span>
    </div>
    ${Card({ body: renderCloserTable(closers.closers || []) })}

    ${renderNotLoggedCallout(latestEod.people || [])}
  `;
}

// ─── Team-wide daily calls_booked spark ───
function buildTeamDailySpark(settersDaily, days) {
  const dates = [];
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - (Math.min(days, 30) - 1));
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  const totals = new Map(dates.map(d => [d, 0]));
  for (const rows of Object.values(settersDaily || {})) {
    for (const r of rows) {
      if (totals.has(r.date)) totals.set(r.date, totals.get(r.date) + (r.calls_booked || 0));
    }
  }
  return dates.map(d => totals.get(d) || 0);
}

// ─── Setter table ───
function renderSetterTable(setters, dailyMap) {
  if (!setters.length) {
    return EmptyState({
      icon: '◇',
      title: 'No setter activity in this window.',
      message: 'Check the Monday EOD-DMs board (id 9743873934) for missing logs.',
    });
  }

  return `
    <table class="table">
      <thead>
        <tr>
          <th>Setter</th>
          <th class="num">DMs Sent</th>
          <th class="num">Calls Booked</th>
          <th class="num">DM→Call%</th>
          <th class="num">Close Rate</th>
          <th class="num">$ / Call</th>
          <th>30d</th>
        </tr>
      </thead>
      <tbody>
        ${setters.map(s => {
          const spark = (dailyMap[s.setter] || []).map(r => r.calls_booked || 0);
          const dmPct = s.dm_to_call_pct;
          return `
            <tr>
              <td><strong>${escapeHtml(s.setter)}</strong></td>
              <td class="num">${s.dms_sent != null ? fmt.int(s.dms_sent) : '—'}</td>
              <td class="num">${fmt.int(s.calls_booked)}</td>
              <td class="num">${dmPct != null ? Math.round(dmPct).toLocaleString() : '—'} ${dmToCallPill(dmPct)}</td>
              <td class="num">${s.close_rate != null ? fmt.pct(s.close_rate, 1) : '—'}</td>
              <td class="num">${s.cost_per_booked_call != null ? fmt.money(s.cost_per_booked_call) : '—'}</td>
              <td style="width: 140px;">${spark.length >= 2 ? Sparkline(spark, { width: 140, height: 32 }) : '<span style="color: var(--dim); font-size: 11px;">—</span>'}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function dmToCallPill(v) {
  if (v == null) return '';
  if (v < 100) return StatusPill('green', 'good');
  if (v <= 200) return StatusPill('yellow', 'watch');
  return StatusPill('red', 'high');
}

// ─── Closer table ───
function renderCloserTable(closers) {
  if (!closers.length) {
    return EmptyState({
      icon: '◇',
      title: 'No closer activity in this window.',
      message: 'Confirm the "45 Call" person column is filled on the Booked Calls board.',
    });
  }

  return `
    <table class="table">
      <thead>
        <tr>
          <th>Closer</th>
          <th class="num">Calls Taken</th>
          <th class="num">Shown</th>
          <th class="num">Closed</th>
          <th class="num">Close Rate</th>
          <th class="num">Cash Collected</th>
          <th class="num">Cash Contracted</th>
        </tr>
      </thead>
      <tbody>
        ${closers.map(c => `
          <tr>
            <td><strong>${escapeHtml(c.closer)}</strong></td>
            <td class="num">${fmt.int(c.calls_taken)}</td>
            <td class="num">${fmt.int(c.shown)}</td>
            <td class="num">${fmt.int(c.closed)}</td>
            <td class="num">${c.close_rate != null ? fmt.pct(c.close_rate, 1) : '—'} ${closeRatePill(c.close_rate)}</td>
            <td class="num">${fmt.money(c.cash_collected, { short: true })}</td>
            <td class="num">${fmt.money(c.cash_contracted, { short: true })}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;
}

function closeRatePill(rate) {
  if (rate == null) return '';
  if (rate > 0.2) return StatusPill('green', 'strong');
  if (rate >= 0.1) return StatusPill('yellow', 'ok');
  return StatusPill('red', 'low');
}

// ─── Not-logged callout (bottom nudge) ───
function renderNotLoggedCallout(people) {
  // Only show ACTIVE setters that haven't logged today.
  const missing = people.filter(p =>
    !p.logged_today && (p.role === 'setter' || p.role === 'closer')
  );
  if (!missing.length) return '';

  const rows = missing.map(p => {
    const when = p.last_date
      ? `last EOD: ${fmt.date(p.last_date)}`
      : 'never logged';
    return `
      <li>
        <span class="who">${escapeHtml(p.va_name)}
          <span class="pill grey" style="margin-left: 8px;">${escapeHtml(p.role || 'setter')}</span>
        </span>
        <span class="when">${when}</span>
      </li>
    `;
  }).join('');

  return `
    <div class="callout-pink" style="margin-top: var(--s-5);">
      <h3>Missing today's EOD · ${missing.length}</h3>
      <ul>${rows}</ul>
    </div>
  `;
}

// ─── Error ───
function renderError(err) {
  return `
    <div class="card">
      <h3 style="color: var(--red);">Team KPI failed to load</h3>
      <p class="mono" style="font-size: 12px; color: var(--muted); margin-top: 8px;">${escapeHtml(err.message)}</p>
      <p style="margin-top: 12px; color: var(--muted); font-size: 13px;">
        Verify MONDAY_API_TOKEN is set. Check that the EOD-DMs board (9743873934)
        and Booked Calls board (18372257888) are reachable.
      </p>
    </div>
  `;
}
