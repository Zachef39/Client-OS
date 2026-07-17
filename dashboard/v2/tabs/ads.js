// Ads tab — CPA-first view. Zach makes scale/cut decisions here.
// Data model:
//   Ad spend + per-campaign         → /api/v2/ads/summary?days=N
//   Daily spend series              → /api/v2/ads/daily?days=N
//   Ad-attributed booked/cash/close → /api/v2/booked-calls/from-ads?days=N
// Layout: 4 hero KPIs (spend, booked/ads, cost/booked, CPA) → Cash-from-Ads
// twin cards → per-campaign table → daily spend line chart.

import {
  api, fmt, KPI, Card, EmptyState, StatusPill, escapeHtml,
  KPISkeleton, LineChart, Sparkline, toast,
} from '../app.js';

export async function renderAds(root, { days }) {
  root.innerHTML = KPISkeleton(4);

  const [adsR, dailyR, adCallsR] = await Promise.allSettled([
    api(`/api/v2/ads/summary?days=${days}`),
    api(`/api/v2/ads/daily?days=${days}`),
    api(`/api/v2/booked-calls/from-ads?days=${days}`),
  ]);

  const ads = pick(adsR);
  const daily = pick(dailyR);
  const adCalls = pick(adCallsR);

  if (!ads && !adCalls) {
    root.innerHTML = renderError(adsR.reason?.message || adCallsR.reason?.message);
    return;
  }

  root.innerHTML = `
    ${renderTopBar(days)}
    ${renderHeroKpis({ ads, daily, adCalls })}
    ${renderCashRow({ ads, daily, adCalls })}
    ${renderCampaignSection({ ads, adCalls, days })}
    ${renderSpendChart({ daily, days })}
    ${renderAttributionFooter(adCalls)}
  `;

  wireSyncButton(root, days);
}

function pick(r) { return r.status === 'fulfilled' ? r.value : null; }

// ─── Top bar ─────────────────────────────────────────────
function renderTopBar(days) {
  return `
    <div class="section-header" style="margin-top:0;">
      <div>
        <div class="page-sub mono">Last ${days} days · CPA is spend ÷ closed clients from ads.</div>
      </div>
      <div><button class="btn ghost" id="sync-ads-btn">↻ Sync Meta now</button></div>
    </div>
  `;
}

// ─── Row 1: Hero KPIs ────────────────────────────────────
function renderHeroKpis({ ads, daily, adCalls }) {
  const spend = ads?.totals?.spend ?? 0;
  const booked = adCalls?.totals?.booked ?? 0;
  const closed = adCalls?.totals?.closed ?? 0;
  const cpbc = booked > 0 ? spend / booked : null;
  const cpa = closed > 0 ? spend / closed : null;

  const spendSpark = daily?.spend_series || [];
  const bookedSpark = adCalls?.daily?.booked || [];

  return `
    <div class="kpi-grid">
      ${KPI({
        label: `Total Ad Spend · ${daysLabel(ads)}`,
        value: fmt.money(spend, { short: true }),
        sub: subForSpend(ads),
        spark: spendSpark,
      })}
      ${KPI({
        label: 'Booked Calls from Ads',
        value: fmt.int(booked),
        sub: booked > 0
          ? `${fmt.int(adCalls?.totals?.shown || 0)} shown · ${fmt.int(closed)} closed`
          : 'No ads-attributed calls yet.',
        spark: bookedSpark,
      })}
      ${kpiTinted({
        label: 'Cost per Booked Call',
        value: cpbc != null ? fmt.money(cpbc) : '—',
        sub: cpbcHint(cpbc),
        color: cpbcColor(cpbc),
      })}
      ${kpiTinted({
        label: 'Cost per Acquisition (CPA)',
        value: cpa != null ? fmt.money(cpa) : '—',
        sub: cpa != null ? cpaHint(cpa) : 'Zero closed from ads yet.',
        color: cpaColor(cpa),
      })}
    </div>
  `;
}

// Local KPI variant that colors the value (green/yellow/red thresholds)
function kpiTinted({ label, value, sub, color }) {
  return `
    <article class="kpi">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value" style="color:${color};">${value ?? '—'}</div>
      <div class="kpi-sub">${sub}</div>
    </article>
  `;
}

function cpbcColor(v) {
  if (v == null) return 'var(--fg)';
  if (v < 50) return 'var(--green)';
  if (v <= 100) return 'var(--yellow)';
  return 'var(--red)';
}
function cpbcHint(v) {
  if (v == null) return 'No booked calls from ads.';
  if (v < 50) return 'Under $50 · strong.';
  if (v <= 100) return '$50–$100 · watch.';
  return 'Over $100 · trim spend or fix funnel.';
}

function cpaColor(v) {
  if (v == null) return 'var(--fg)';
  if (v < 500) return 'var(--green)';
  if (v <= 1000) return 'var(--yellow)';
  return 'var(--red)';
}
function cpaHint(v) {
  if (v < 500) return 'Under $500 · scale.';
  if (v <= 1000) return '$500–$1k · hold.';
  return 'Over $1k · cut or rework.';
}

function subForSpend(ads) {
  if (!ads?.totals) return 'No spend data.';
  const { messages, cpm, cpl } = ads.totals;
  const parts = [];
  if (messages) parts.push(`${fmt.int(messages)} msgs`);
  if (cpl != null) parts.push(`${fmt.money(cpl)} CPL`);
  if (cpm != null) parts.push(`${fmt.money(cpm)} CPM`);
  return parts.length ? parts.join(' · ') : 'Spend recorded, no engagement yet.';
}

function daysLabel(ads) {
  if (!ads?.window?.days) return '';
  return `${ads.window.days}d`;
}

// ─── Row 2: Cash from Ads (two cards) ─────────────────────
function renderCashRow({ ads, daily, adCalls }) {
  const collected = adCalls?.totals?.cash_collected ?? 0;
  const contracted = adCalls?.totals?.cash_contracted ?? 0;
  const spend = ads?.totals?.spend ?? 0;

  const collectedSpark = adCalls?.daily?.collected || [];
  const contractedSpark = adCalls?.daily?.contracted || [];

  const roasCollected = spend > 0 && collected > 0 ? collected / spend : null;
  const roasContracted = spend > 0 && contracted > 0 ? contracted / spend : null;

  return `
    <div class="section-header">
      <h2>Cash from Ads</h2>
      <span class="hint">Ad-attributed booked calls only.</span>
    </div>
    <div class="row">
      ${cashCard({
        title: 'Collected from Ads',
        amount: collected,
        spark: collectedSpark,
        roas: roasCollected,
        roasLabel: 'ROAS (collected)',
      })}
      ${cashCard({
        title: 'Contracted from Ads',
        amount: contracted,
        spark: contractedSpark,
        roas: roasContracted,
        roasLabel: 'ROAS (contracted)',
      })}
    </div>
  `;
}

function cashCard({ title, amount, spark, roas, roasLabel }) {
  const roasPill = roas != null
    ? StatusPill(roasStatusKey(roas), `${roasLabel} ${fmt.ratio(roas)}`)
    : '';
  return `
    <section class="card">
      <div class="card-title">
        <div><h3>${title}</h3></div>
        <div>${roasPill}</div>
      </div>
      <div style="font-size: 34px; font-weight: 500; color: var(--fg); margin: 8px 0 4px;">
        ${fmt.money(amount, { short: true })}
      </div>
      ${Sparkline(spark, { width: 360, height: 54 })}
    </section>
  `;
}

// ─── Row 3: Per-Campaign table ───────────────────────────
function renderCampaignSection({ ads, adCalls, days }) {
  const campaigns = ads?.campaigns || [];
  return `
    <div class="section-header">
      <h2>Per Campaign · Last ${days}d</h2>
      <span class="hint">Sorted by spend</span>
    </div>
    ${Card({ body: renderCampaignTable(campaigns, adCalls, ads) })}
  `;
}

function renderCampaignTable(campaigns, adCalls, ads) {
  if (!campaigns.length) {
    return EmptyState({
      icon: '◈',
      title: 'No ads spend last 30d',
      message: 'Click "Sync Meta now" or wait for the daily cron.',
    });
  }

  // ad_metrics per-campaign counts (booked_calls/closed/cash_collected) rarely populate
  // because Meta doesn't hand back a client-close signal. When those columns are zero
  // we approximate: allocate ad-attributed booked/closed/cash from Monday proportional
  // to each campaign's spend. Rough — but better than shipping zeros.
  const totalSpend = ads?.totals?.spend || 0;
  const totalBookedFromAds = adCalls?.totals?.booked || 0;
  const totalClosedFromAds = adCalls?.totals?.closed || 0;
  const totalCollectedFromAds = adCalls?.totals?.cash_collected || 0;
  const totalContractedFromAds = adCalls?.totals?.cash_contracted || 0;
  const anyMetaClosed = campaigns.some(c => (c.closed || 0) > 0);

  return `
    <table class="table">
      <thead>
        <tr>
          <th>Campaign</th>
          <th class="num">Spend</th>
          <th class="num">Booked</th>
          <th class="num">Closed</th>
          <th class="num">CPA</th>
          <th class="num">ROAS (Coll.)</th>
          <th class="num">ROAS (Contr.)</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${campaigns.map(c => {
          const share = totalSpend > 0 ? c.spend / totalSpend : 0;
          const booked = anyMetaClosed
            ? (c.booked_calls || 0)
            : Math.round(totalBookedFromAds * share);
          const closed = anyMetaClosed
            ? (c.closed || 0)
            : totalClosedFromAds * share;
          const collected = anyMetaClosed
            ? (c.cash_collected || 0)
            : totalCollectedFromAds * share;
          const contracted = anyMetaClosed
            ? (c.cash_contracted || 0)
            : totalContractedFromAds * share;

          const cpa = closed > 0 ? c.spend / closed : null;
          const roasColl = c.spend > 0 && collected > 0 ? collected / c.spend : null;
          const roasContr = c.spend > 0 && contracted > 0 ? contracted / c.spend : null;

          const closedDisplay = anyMetaClosed ? fmt.int(closed) : (closed > 0 ? closed.toFixed(1) : '0');

          return `
            <tr>
              <td title="${escapeHtml(c.campaign_name || '—')}">${escapeHtml(shortName(c.campaign_name))}</td>
              <td class="num">${fmt.money(c.spend, { short: true })}</td>
              <td class="num">${fmt.int(booked)}</td>
              <td class="num">${closedDisplay}</td>
              <td class="num" style="color:${cpaColor(cpa)};">${cpa != null ? fmt.money(cpa) : '—'}</td>
              <td class="num">${roasColl != null ? fmt.ratio(roasColl) : '—'}</td>
              <td class="num">${roasContr != null ? fmt.ratio(roasContr) : '—'}</td>
              <td>${roasStatusPill(roasColl)}</td>
            </tr>
          `;
        }).join('')}
      </tbody>
    </table>
  `;
}

function shortName(name) {
  if (!name) return '—';
  return name.length > 60 ? name.slice(0, 57) + '…' : name;
}

function roasStatusKey(roas) {
  if (roas == null) return 'neutral';
  if (roas >= 3) return 'green';
  if (roas >= 1.5) return 'yellow';
  return 'red';
}

function roasStatusPill(roas) {
  if (roas == null) return '';
  if (roas >= 3) return StatusPill('green', 'strong');
  if (roas >= 1.5) return StatusPill('yellow', 'ok');
  return StatusPill('red', 'weak');
}

// ─── Row 4: Daily spend chart ────────────────────────────
function renderSpendChart({ daily, days }) {
  const rows = daily?.rows || [];
  const points = rows.map(r => ({ x: shortDate(r.date), y: r.spend || 0 }));
  return `
    <div class="section-header">
      <h2>Daily Spend</h2>
      <span class="hint">${days}-day trend</span>
    </div>
    ${Card({ body: points.length >= 2
      ? LineChart(points, { format: v => fmt.money(v, { short: true }) })
      : EmptyState({ title: 'No ads spend last 30d', message: 'Waiting on daily sync.' }) })}
  `;
}

// ─── Attribution note ────────────────────────────────────
function renderAttributionFooter(adCalls) {
  if (!adCalls?.attribution_note) return '';
  return `
    <p class="mono" style="color: var(--dim); font-size: 12px; margin-top: 12px; text-align: right;">
      ad attribution rough — ${escapeHtml(adCalls.attribution_note)}
    </p>
  `;
}

// ─── Sync button ─────────────────────────────────────────
function wireSyncButton(root, days) {
  const btn = document.getElementById('sync-ads-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Syncing…';
    try {
      const r = await api('/api/v2/ads/sync', { method: 'POST', body: { days: 3 } });
      toast(`Synced ${r.rows || 0} campaign-days`);
      renderAds(root, { days });
    } catch (err) {
      toast(`Sync failed: ${err.message}`);
      btn.disabled = false;
      btn.textContent = '↻ Sync Meta now';
    }
  });
}

function shortDate(s) {
  if (!s) return '';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
}

function renderError(msg) {
  return `
    <div class="card">
      <h3 style="color: var(--red);">Ads tab failed to load</h3>
      <p class="mono" style="font-size: 12px; color: var(--muted); margin-top: 8px;">${escapeHtml(msg || 'unknown error')}</p>
      <p style="margin-top: 12px; color: var(--muted); font-size: 13px;">
        Verify META_ADS_TOKEN + META_AD_ACCOUNT_ID + MONDAY_API_TOKEN are set.
      </p>
    </div>
  `;
}
