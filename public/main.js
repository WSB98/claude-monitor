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
  if (ds?.recoveredRange) {
    note += ` (live since ${new Date(ds.liveSince).toLocaleDateString()}, ${formatCost(data.totals.recoveredCostUsd)} recovered`;
    note += ds.gapTurns ? `, ~${formatCost(data.totals.estimatedCostUsd)} estimated from ${ds.gapTurns} untracked turns)` : ')';
  }
  if (data.totals.unpricedTokens > 0) {
    note += ` · ${formatTokens(data.totals.unpricedTokens)} tok un-priced, no rate for ${data.totals.unpricedModels.join(', ')} (cost totals under-count by that amount)`;
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
  if (/opus/i.test(model)) return 'opus';
  if (/sonnet/i.test(model)) return 'sonnet';
  if (/haiku/i.test(model)) return 'haiku';
  if (/fable|mythos/i.test(model)) return 'fable';
  return 'other';
}

function tickClock() {
  el('clock').textContent = new Date().toLocaleTimeString([], { hour12: false });
}
setInterval(tickClock, 1000);
tickClock();

// ── Chart ────────────────────────────────────────────────────────────

const chartColors = { input: '#4a80a8', output: '#62b07d', cache: '#5e5c59', recovered: '#9b78d4', estimated: 'rgba(155,120,212,0.4)' };

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

  points.forEach((d, i) => {
    const x = padLeft + i * (barW + gap);
    let y = padTop + plotH;
    const segs = [
      [d.input, chartColors.input],
      [d.output, chartColors.output],
      [d.cache, chartColors.cache],
      [d.recovered || 0, chartColors.recovered],
      [d.estimated || 0, chartColors.estimated],
    ];
    for (const [val, color] of segs) {
      const segH = (val / max) * plotH;
      if (segH <= 0) continue;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - segH, barW, segH);
      y -= segH;
    }
    if (i % labelStride === 0) {
      ctx.fillStyle = '#5e5c59';
      ctx.font = '10px "Share Tech Mono", ui-monospace, "Cascadia Code", "Segoe UI Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Monaco, "Courier New", monospace';
      ctx.textAlign = 'center';
      ctx.fillText(d.label, x + barW / 2, h - 6);
    }
  });
}

// ── Bar lists ────────────────────────────────────────────────────────

// Rows are keyed by name and reused across polls (rather than torn down and
// rebuilt every 5s) so the bar-fill width can transition smoothly and the
// cost value can count up instead of just snapping to the new number.
function renderBarList(containerId, rows, nameKey) {
  const container = el(containerId);
  if (!rows.length) {
    container.innerHTML = '<div class="empty-note">no data yet</div>';
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
        <span class="name" title="${escapeHtml(row[nameKey])}">${escapeHtml(row[nameKey])}</span>
        <span class="bar-track"><span class="bar-fill" style="width:0%"></span></span>
        <span class="value"></span>
      `;
    }
    if (container.children[i] !== div) container.insertBefore(div, container.children[i] || null);

    const pct = Math.max(2, ((row.costUsd || 0) / max) * 100);
    div.querySelector('.bar-fill').style.width = pct + '%';
    animateNumber(div.querySelector('.value'), row.costUsd || 0, formatCost);
  });

  [...container.children].forEach((child) => {
    if (child.dataset && !seen.has(child.dataset.key)) child.remove();
  });
}

// Turn-count breakdown from history.jsonl — every project ever touched,
// regardless of whether its own transcripts still exist. Distinct data
// (and distinct color, matching the chart's "recovered" segments) from the
// cost-based By Project list above, which only reflects live-tracked spend.
// Each bar is itself a stacked breakdown — solid cyan for exact live cost,
// solid purple for a project's share of the recovered pool, translucent
// purple for the extrapolated estimate — same color language as the chart.
function renderProjectHistoryList(rows) {
  const container = el('allProjectsHistory');
  if (!rows.length) {
    container.innerHTML = '<div class="empty-note">no prompt history found</div>';
    return;
  }
  if (container.querySelector('.empty-note')) container.innerHTML = '';

  const max = Math.max(...rows.map((r) => r.totalCostUsd || 0), 0.0001);
  const seen = new Set();
  rows.forEach((row, i) => {
    const key = String(row.project);
    seen.add(key);
    let div = container.querySelector(`:scope > [data-key="${CSS.escape(key)}"]`);
    if (!div) {
      div = document.createElement('div');
      div.className = 'bar-row';
      div.dataset.key = key;
      div.innerHTML = `
        <span class="name"></span>
        <span class="bar-track">
          <span class="bar-fill seg-live" style="left:0%;width:0%;background:var(--epic)"></span>
          <span class="bar-fill seg-recovered" style="left:0%;width:0%;background:#9b78d4"></span>
          <span class="bar-fill bar-fill-estimated seg-estimated" style="left:0%;width:0%"></span>
        </span>
        <span class="value"></span>
      `;
    }
    if (container.children[i] !== div) container.insertBefore(div, container.children[i] || null);

    const total = row.totalCostUsd || 0;
    const totalPct = Math.max(2, (total / max) * 100);
    const livePct = total > 0 ? (row.liveCostUsd / total) * totalPct : 0;
    const recoveredPct = total > 0 ? (row.recoveredCostUsd / total) * totalPct : 0;
    const estimatedPct = Math.max(0, totalPct - livePct - recoveredPct);
    const isEstimated = row.recoveredCostUsd > 0 || row.estimatedCostUsd > 0;
    const range = row.firstSeen ? `${new Date(row.firstSeen).toLocaleDateString()} → ${new Date(row.lastSeen).toLocaleDateString()}` : 'no prompt-history entries';
    const breakdown = `live ${formatCost(row.liveCostUsd)}, recovered ${formatCost(row.recoveredCostUsd)}, ~estimated ${formatCost(row.estimatedCostUsd)}`;

    const nameEl = div.querySelector('.name');
    nameEl.textContent = row.project;
    nameEl.title = `${row.project} · ${row.turns} turns · ${range} · ${breakdown}`;

    div.querySelector('.seg-live').style.width = livePct + '%';
    const recoveredSeg = div.querySelector('.seg-recovered');
    recoveredSeg.style.left = livePct + '%';
    recoveredSeg.style.width = recoveredPct + '%';
    const estimatedSeg = div.querySelector('.seg-estimated');
    estimatedSeg.style.left = livePct + recoveredPct + '%';
    estimatedSeg.style.width = estimatedPct + '%';

    animateNumber(div.querySelector('.value'), total, (v) => (isEstimated ? '~' : '') + formatCost(v));
  });

  [...container.children].forEach((child) => {
    if (child.dataset && !seen.has(child.dataset.key)) child.remove();
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
  renderBarList('byProject', p.byProject || [], 'project');
  renderBarList('byModel', p.byModel || [], 'model');
  animateNumber(el('statTokensPeriod'), p.tokens, formatTokens);
  animateNumber(el('statCostPeriod'), p.costUsd, formatCost);
  animateNumber(el('statTurnsPeriod'), p.turns, (v) => String(Math.round(v)));
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
      const projectNote = `${data.scannedProjects} project${data.scannedProjects === 1 ? '' : 's'} on disk · ${data.byProject.length} with live transcripts`;
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
