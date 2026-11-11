import { createNetworkViz } from './networkViz.js';
import { formatTokens, formatCost, formatRelative, escapeHtml } from './format.js';
import { animateNumber } from './animate.js';

const POLL_MS = 5000;
const STALE_MS = 15000;

const PERIOD_LABELS = { today: 'Today', week: '7 Days', month: '30 Days', year: '1 Year' };

const el = (id) => document.getElementById(id);

// Builds the footer's data-provenance sentence — tracking-since date, plus
// (when Claude Code's own transcript cleanup has already deleted part of
// the history) the recovered and estimated tiers that make up the rest of
// the all-time total.
function buildSinceNote(data) {
  if (!data.firstEventAt) return '';
  let note = ` · tracking since ${new Date(data.firstEventAt).toLocaleDateString()}`;
  const ds = data.dataSources;
  const t = data.totals;
  const parts = [];
  const rec = ds?.reconciliation;
  if (ds?.liveSince) {
    let exact = `exact since ${new Date(ds.liveSince).toLocaleDateString()}`;
    if (rec?.reportedCostUsd > 0) exact += `, incl. ${formatCost(rec.reportedCostUsd)} transcripts missed that Claude Code's own cost records show`;
    parts.push(exact);
  }
  if (t.recoveredCostUsd > 0) parts.push(`${formatCost(t.recoveredCostUsd)} recovered from Claude Code's records for ${ds.recoveredTurns} prompts whose transcripts are gone`);
  const pe = ds?.promptEstimate;
  if (ds?.gapTurns && pe) {
    let est = `~${formatCost(pe.costUsd)} estimated for ${ds.gapTurns} prompts with no surviving data`;
    if (pe.range) est += ` (plausible ${formatCost(pe.range.low)}–${formatCost(pe.range.high)})`;
    if (pe.model) est += `, modeled on your own ${pe.model.basisSessions} sessions by prompt position, project and period`;
    parts.push(est);
  }
  if (rec?.modeledCostUsd > 0) parts.push(`~${formatCost(rec.modeledCostUsd)} modeled for logged responses missing their final usage`);
  if (parts.length) note += ` (${parts.join('; ')})`;
  if (t.unpricedTokens > 0) {
    note += ` · ${formatTokens(t.unpricedTokens)} tok un-priced, no rate for ${t.unpricedModels.join(', ')} (cost totals under-count by that amount)`;
  }
  if (t.approxPricedModels?.length) {
    note += ` · priced at nearest known family rate: ${t.approxPricedModels.join(', ')}`;
  }
  return note;
}

// Tooltip for the all-time hero cards — the visible number is the
// live+recovered+estimated combined total; hovering breaks out the tiers.
function costBreakdownTitle(totals) {
  return `live ${formatCost(totals.liveCostUsd)} + recovered ${formatCost(totals.recoveredCostUsd)} + ~estimated ${formatCost(totals.estimatedCostUsd)}`;
}

function modelFamily(model) {
  if (!model) return 'other';
  if (/fable|mythos/i.test(model)) return 'fable';
  if (/opus/i.test(model)) return 'opus';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/haiku/i.test(model)) return 'haiku';
  return 'other';
}

function tickClock() {
  el('clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// ── Chart ────────────────────────────────────────────────────────────

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Canvas can't read CSS variables, so the chart pulls the same tokens the
// legend swatches use. Recovered/estimated are tiers, not token types: they
// reuse the neutral "project" ink as faded / hatched fills, the same fill
// styles the bar lists use for those tiers.
function chartPalette() {
  return {
    input: cssVar('--tok-input'),
    output: cssVar('--tok-output'),
    cache: cssVar('--tok-cache'),
    tier: cssVar('--project-bar'),
    recoveredOpacity: Number(cssVar('--tier-recovered-opacity')) || 0.55,
    estimatedOpacity: Number(cssVar('--tier-estimated-opacity')) || 0.45,
  };
}

function hatchPattern(ctx, color) {
  const c = document.createElement('canvas');
  c.width = 6;
  c.height = 6;
  const g = c.getContext('2d');
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-1, 7);
  g.lineTo(7, -1);
  g.stroke();
  return ctx.createPattern(c, 'repeat');
}

let chartBars = []; // [{x, w, point}] from the last draw, for hover hit-testing

function drawChart(points) {
  const canvas = el('chart');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(rect.width, 200);
  const h = 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const pal = chartPalette();

  const padLeft = 8;
  const padRight = 8;
  const padTop = 10;
  const padBottom = 22;
  const plotW = w - padLeft - padRight;
  const plotH = h - padTop - padBottom;

  const totals = points.map((d) => d.input + d.output + d.cache + (d.recovered || 0) + (d.estimated || 0));
  const max = Math.max(1, ...totals);

  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = padTop + (plotH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(w - padRight, y);
    ctx.stroke();
  }

  const n = points.length;
  const gap = 6;
  const barW = Math.max(4, (plotW - gap * (n - 1)) / n);
  const labelStride = n > 12 ? 2 : 1;
  const hatch = hatchPattern(ctx, pal.tier);
  chartBars = [];

  points.forEach((d, i) => {
    const x = padLeft + i * (barW + gap);
    chartBars.push({ x, w: barW, point: d });
    let y = padTop + plotH;
    const segs = [
      [d.cache, pal.cache, 1],
      [d.input, pal.input, 1],
      [d.output, pal.output, 1],
      [d.recovered || 0, pal.tier, pal.recoveredOpacity],
      [d.estimated || 0, hatch, pal.estimatedOpacity],
    ];
    for (const [val, fill, alpha] of segs) {
      const segH = (val / max) * plotH;
      if (segH <= 0) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = fill;
      // 1px surface gap between stacked segments once they're tall enough to show it
      ctx.fillRect(x, y - segH, barW, segH > 3 ? segH - 1 : segH);
      ctx.globalAlpha = 1;
      y -= segH;
    }
    if (i % labelStride === 0) {
      ctx.fillStyle = cssVar('--dust-600');
      ctx.font = '10px "Share Tech Mono", ui-monospace, "Cascadia Code", "Segoe UI Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Monaco, "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x + barW / 2, h - 6);
    }
  });
}

// Per-bar hover: the whole column (not just the painted part) is the hit
// target, so near-empty days are still inspectable.
function setupChartTooltip() {
  const canvas = el('chart');
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  document.body.appendChild(tip);
  const row = (swatchStyle, label, tokens, cost) =>
    `<div><span class="tip-sw" style="${swatchStyle}"></span>${label} ${formatTokens(tokens)} tok${cost != null ? ` · ${formatCost(cost)}` : ''}</div>`;
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left;
    const bar = chartBars.find((b) => mx >= b.x - 3 && mx <= b.x + b.w + 3);
    if (!bar) {
      tip.style.display = 'none';
      return;
    }
    const d = bar.point;
    const pal = chartPalette();
    let html = `<div class="tip-title">${escapeHtml(d.key)} · ${formatCost(d.costUsd)}</div>`;
    if (d.input + d.output + d.cache > 0) {
      html += row(`background:${pal.output}`, 'output', d.output, null);
      html += row(`background:${pal.input}`, 'input', d.input, null);
      html += row(`background:${pal.cache}`, 'cache', d.cache, null);
      html += `<div style="color:var(--dust-500)">exact cost ${formatCost(d.liveCostUsd)}</div>`;
    }
    if (d.recovered > 0) html += row(`background:${pal.tier};opacity:${pal.recoveredOpacity}`, 'recovered', d.recovered, d.recoveredCostUsd);
    if (d.estimated > 0) html += row(`background:repeating-linear-gradient(45deg, ${pal.tier} 0 2px, transparent 2px 4px)`, '~estimated', d.estimated, d.estimatedCostUsd);
    tip.innerHTML = html;
    tip.style.display = 'block';
    const tw = tip.offsetWidth;
    tip.style.left = Math.min(window.innerWidth - tw - 8, e.clientX + 14) + 'px';
    tip.style.top = e.clientY + 14 + 'px';
  });
  canvas.addEventListener('mouseleave', () => {
    tip.style.display = 'none';
  });
}
setupChartTooltip();

// ── Bar lists ────────────────────────────────────────────────────────

// Every cost list (By Project, By Model, All Projects) draws the same way:
// one bar per row, split into tier segments — solid for exact live spend,
// faded for recovered, faded + hatched for ~estimated — in the row's own
// color (its model family's hue for models, neutral ink for projects).
// Rows are keyed by name and reused across polls (rather than torn down and
// rebuilt every 5s) so widths can transition and values can count up.
function renderBarList(containerId, rows, { nameKey, colorFor = () => 'var(--project-bar)', titleFor = null, emptyNote = 'no data yet' }) {
  const container = el(containerId);
  if (!rows.length) {
    container.innerHTML = `<div class="empty-note">${emptyNote}</div>`;
    return;
  }
  if (container.querySelector('.empty-note')) container.innerHTML = '';

  const max = Math.max(...rows.map((r) => r.costUsd || 0), 0.0001);
  const seen = new Set();
  rows.forEach((row, i) => {
    const key = String(row[nameKey]);
    seen.add(key);
    let div = container.querySelector(`:scope > [data-key="${CSS.escape(key)}"]`);
    if (!div) {
      div = document.createElement('div');
      div.className = 'bar-row';
      div.dataset.key = key;
      div.innerHTML = `
        <span class="name"></span>
        <span class="bar-track">
          <span class="bar-fill seg-live" style="left:0%;width:0%"></span>
          <span class="bar-fill seg-recovered" style="left:0%;width:0%"></span>
          <span class="bar-fill seg-estimated" style="left:0%;width:0%"></span>
        </span>
        <span class="value"></span>
      `;
    }
    if (container.children[i] !== div) container.insertBefore(div, container.children[i] || null);
    div.classList.toggle('is-other', Boolean(row.isOther));
    div.style.setProperty('--bar-color', colorFor(row));

    const total = row.costUsd || 0;
    const live = row.liveCostUsd ?? total;
    const recovered = row.recoveredCostUsd || 0;
    const estimated = row.estimatedCostUsd || 0;
    const totalPct = Math.max(2, (total / max) * 100);
    const livePct = total > 0 ? (live / total) * totalPct : totalPct;
    const recoveredPct = total > 0 ? (recovered / total) * totalPct : 0;
    const estimatedPct = Math.max(0, totalPct - livePct - recoveredPct);
    const approx = recovered > 0 || estimated > 0;

    const nameEl = div.querySelector('.name');
    nameEl.textContent = row[nameKey];
    nameEl.title = titleFor
      ? titleFor(row)
      : `${row[nameKey]} · ${formatCost(total)}` + (approx ? ` (live ${formatCost(live)}, recovered ${formatCost(recovered)}, ~estimated ${formatCost(estimated)})` : '');

    div.querySelector('.seg-live').style.width = livePct + '%';
    const rec = div.querySelector('.seg-recovered');
    rec.style.left = livePct + '%';
    rec.style.width = recoveredPct + '%';
    const est = div.querySelector('.seg-estimated');
    est.style.left = livePct + recoveredPct + '%';
    est.style.width = estimatedPct + '%';

    animateNumber(div.querySelector('.value'), total, (v) => (approx ? '~' : '') + formatCost(v));
  });

  [...container.children].forEach((child) => {
    if (child.dataset && !seen.has(child.dataset.key)) child.remove();
  });
}

const modelColor = (row) => (row.isOther ? 'var(--model-other)' : `var(--model-${modelFamily(row.model)})`);

// Every project Claude Code has a record of, regardless of whether its own
// transcripts still exist — exact live cost where they do, recovered or
// ~estimated otherwise (see server/merge.js).
function renderProjectHistoryList(rows) {
  renderBarList('allProjectsHistory', rows.map((r) => ({ ...r, costUsd: r.totalCostUsd })), {
    nameKey: 'project',
    emptyNote: 'no prompt history found',
    titleFor: (row) => {
      const range = row.firstSeen ? `${new Date(row.firstSeen).toLocaleDateString()} → ${new Date(row.lastSeen).toLocaleDateString()}` : 'no prompt-history entries';
      return `${row.project} · ${row.turns} prompts · ${range} · live ${formatCost(row.liveCostUsd)}, recovered ${formatCost(row.recoveredCostUsd)}, ~estimated ${formatCost(row.estimatedCostUsd)}`;
    },
  });
}

// ── Live feed ────────────────────────────────────────────────────────

let lastTopTimestamp = null;

function renderFeed(recent) {
  const container = el('feed');
  container.innerHTML = '';
  if (!recent.length) {
    container.innerHTML = '<div class="empty-note">no activity recorded yet</div>';
    return;
  }
  recent.forEach((r, i) => {
    const time = new Date(r.timestamp).toLocaleTimeString([], { hour12: false });
    const family = modelFamily(r.model);
    const row = document.createElement('div');
    row.className = 'feed-row';
    if (i === 0 && lastTopTimestamp && r.timestamp !== lastTopTimestamp) row.classList.add('fresh');
    row.innerHTML = `
      <span class="time">${time}</span>
      <span class="project">${escapeHtml(r.project)}</span>
      <span class="chip ${family}">${family}</span>
      <span class="tokens">${formatTokens(r.tokens)} tok</span>
      <span class="cost">${formatCost(r.costUsd)}</span>
    `;
    container.appendChild(row);
  });
  lastTopTimestamp = recent[0].timestamp;
}

// ── Period / chart granularity switches ─────────────────────────────

let selectedPeriod = 'today';
let selectedGranularity = 'daily';
let latestData = null;

function renderPeriodStats(data) {
  const p = data.periods[selectedPeriod];
  const label = PERIOD_LABELS[selectedPeriod];
  el('labelTokens').textContent = `Tokens — ${label}`;
  el('labelCost').textContent = `Est. Cost — ${label}`;
  el('labelTurns').textContent = `Turns — ${label}`;
  el('labelByProject').textContent = `By Project — ${label}`;
  el('labelByModel').textContent = `By Model — ${label}`;
  renderBarList('byProject', p.byProject || [], { nameKey: 'project' });
  renderBarList('byModel', p.byModel || [], { nameKey: 'model', colorFor: modelColor });
  // A period that reaches back past the surviving transcripts includes
  // recovered/estimated spend — marked "~" like the all-time totals.
  const periodApprox = p.recoveredCostUsd > 0 || p.estimatedCostUsd > 0;
  animateNumber(el('statTokensPeriod'), p.tokens, (v) => (periodApprox ? '~' : '') + formatTokens(v));
  animateNumber(el('statCostPeriod'), p.costUsd, (v) => (periodApprox ? '~' : '') + formatCost(v));
  const periodTitle = periodApprox ? costBreakdownTitle(p) : '';
  el('statTokensPeriod').title = periodTitle;
  el('statCostPeriod').title = periodTitle;
  // Turns = billed API responses, counted only where transcripts survive.
  animateNumber(el('statTurnsPeriod'), p.turns, (v) => String(Math.round(v)));
  el('statTurnsPeriod').title = 'billed API responses in surviving transcripts';
  const hasEstimate = data.totals.recoveredCostUsd > 0 || data.totals.estimatedCostUsd > 0;
  animateNumber(el('statTokensAllTime'), data.totals.tokens, (v) => (hasEstimate ? '~' : '') + formatTokens(v) + ' all-time');
  animateNumber(el('statCostAllTime'), data.totals.costUsd, (v) => (hasEstimate ? '~' : '') + formatCost(v) + ' all-time');
  const title = hasEstimate ? costBreakdownTitle(data.totals) : '';
  el('statTokensAllTime').title = title;
  el('statCostAllTime').title = title;
  animateNumber(el('statSessionsAllTime'), data.totals.sessions, (v) => Math.round(v) + ' sessions all-time');
}

el('periodSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('.period-btn');
  if (!btn) return;
  selectedPeriod = btn.dataset.period;
  [...el('periodSwitch').children].forEach((b) => b.classList.toggle('active', b === btn));
  if (latestData) renderPeriodStats(latestData);
});

el('chartSwitch').addEventListener('click', (e) => {
  const btn = e.target.closest('.period-btn');
  if (!btn) return;
  selectedGranularity = btn.dataset.gran;
  [...el('chartSwitch').children].forEach((b) => b.classList.toggle('active', b === btn));
  if (latestData) drawChart(latestData.charts[selectedGranularity]);
});

// ── Network pulse ────────────────────────────────────────────────────

const network = createNetworkViz(el('network'));

// ── Poll loop ────────────────────────────────────────────────────────

let lastGoodFetchAt = 0;

function setConn(ok) {
  const dot = el('connDot');
  const label = el('connLabel');
  const fresh = ok && Date.now() - lastGoodFetchAt < STALE_MS;
  dot.className = 'dot ' + (fresh ? 'live' : 'stale');
  label.textContent = fresh ? 'live' : 'stale';
}

async function poll() {
  try {
    const res = await fetch('/api/usage', { cache: 'no-store' });
    const data = await res.json();
    lastGoodFetchAt = Date.now();
    latestData = data;

    if (!data.logRootExists) {
      el('footerNote').textContent = 'no ~/.claude/projects directory found on this machine';
    } else {
      const historyCount = data.allProjectsHistory.length;
      const projectNote = `${data.scannedProjects} project${data.scannedProjects === 1 ? '' : 's'} on disk · ${data.allProjectsHistory.filter((r) => r.liveCostUsd > 0).length} with live transcripts`;
      const historyNote = historyCount ? ` · ${historyCount} in full history` : '';
      el('footerNote').textContent = `claude-monitor · ${projectNote}${historyNote}${buildSinceNote(data)}`;
    }

    renderPeriodStats(data);
    el('statLastActivity').textContent = formatRelative(data.lastEventAt);
    el('statLastProject').textContent = data.recent[0] ? data.recent[0].project : '--';

    drawChart(data.charts[selectedGranularity]);
    renderProjectHistoryList(data.allProjectsHistory);
    renderFeed(data.recent);

    network.update(data.network.nodes, data.network.liveWindowMs, data.network.warmWindowMs);
    const live = data.network.nodes.filter((n) => n.msAgo <= data.network.liveWindowMs || n.isThinking);
    const liveSubagents = live.filter((n) => n.isSubagent).length;
    const liveMain = live.length - liveSubagents;
    const liveVolume = live.reduce((sum, n) => sum + (n.tokens || 0), 0);
    el('networkHint').textContent = live.length
      ? `${live.length} active` +
        (liveSubagents ? ` (${liveMain} session, ${liveSubagents} subagent${liveSubagents === 1 ? '' : 's'})` : '') +
        (liveVolume ? ` · ${formatTokens(liveVolume)} tok/5min` : '')
      : 'idle';

    setConn(true);
  } catch (err) {
    setConn(false);
  }
}

poll();
setInterval(poll, POLL_MS);
setInterval(() => setConn(true), 3000); // keeps the dot honest between polls
