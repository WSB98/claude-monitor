// "Activity pulse" as a layered signal graph, closer to a neural-net
// diagram than a single hub. Four columns, left to right: the Projects a
// turn came from, the Session/Subagent that actually ran it, the Model
// that resolved it, and the Token Type (input/output/cache) it produced.
// Columns and edges are rebuilt fresh every frame from whichever nodes are
// currently warm — this isn't a fixed topology, it's however much of the
// real pipeline happens to be active right now. Edge brightness and
// particle count both scale (log, since token counts span orders of
// magnitude) with each node's real throughput over the warm window
// (server-computed, see aggregate.js's recentTokens/Input/Output/Cache),
// so a heavier turn visibly pushes more signal through more of the graph.
// A session/subagent that's mid-turn — prompt or tool result submitted, no
// reply logged yet — shows up the instant it starts (aggregate.js's
// isThinking, sourced from parseLogs.js's collectPendingTurns) with a
// pulsing ring instead of waiting for its first billed token.
//
// Every dot — session/subagent nodes and the Project/Model/Token-type
// aggregator dots alike — is hoverable: hit targets are rebuilt each frame
// from that frame's actual drawn positions, so a tooltip always points at
// what's currently on screen even as the graph reflows.

import { formatTokens, formatCost, formatRelative, escapeHtml } from './format.js';

const MAX_NODES = 14;
const MAX_PROJECTS = 8;
const MAX_MODELS = 6;
const MAX_PARTICLES = 5;

const TOKEN_TYPES = [
  { key: 'input', col: '74,128,168' }, // --info
  { key: 'output', col: '98,176,125' }, // --ok
  { key: 'cache', col: '94,92,89' }, // --dust-600
];

const COLUMN_LABELS = ['PROJECTS', 'SESSIONS', 'MODELS', 'TOKENS'];

// Relative-to-this-frame log scale: whichever item is heaviest in its
// group gets the full effect, everything else scales down from there.
function volumeScale(v, max) {
  if (!v || !max) return 0;
  return Math.max(0, Math.min(1, Math.log10(v + 1) / Math.log10(max + 1)));
}

function colorFor(model) {
  if (!model) return '168,164,156';
  if (/opus/i.test(model)) return '232,184,76'; // mythic
  if (/sonnet/i.test(model)) return '41,182,246'; // epic
  if (/haiku/i.test(model)) return '98,176,125'; // ok
  if (/fable|mythos/i.test(model)) return '196,154,56'; // warn
  return '168,164,156'; // dust-400
}

export function createNetworkViz(canvas) {
  const ctx = canvas.getContext('2d');
  let nodes = [];
  let liveMs = 30_000;
  let warmMs = 5 * 60_000;
  let raf = null;

  // Populated fresh at the end of every draw() call: {x, y, r, title, lines}
  // in CSS-pixel canvas-local coordinates. Hit-tested against the mouse on
  // each frame, so it's always in sync with what's actually on screen.
  let hitTargets = [];
  let hoverPt = null; // {x, y} canvas-local, or null when the pointer's elsewhere
  let tooltipEl = null;
  let tooltipKey = null;

  function ensureTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'viz-tooltip';
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function hideTooltip() {
    if (tooltipEl) tooltipEl.style.display = 'none';
    tooltipKey = null;
    canvas.style.cursor = '';
  }

  function findHit(pt) {
    if (!pt) return null;
    let best = null;
    let bestDist = Infinity;
    for (const t of hitTargets) {
      const dx = pt.x - t.x;
      const dy = pt.y - t.y;
      const dist = Math.hypot(dx, dy);
      if (dist <= t.r && dist < bestDist) {
        best = t;
        bestDist = dist;
      }
    }
    return best;
  }

  function updateTooltip() {
    const hit = findHit(hoverPt);
    if (!hit) {
      hideTooltip();
      return;
    }
    const key = hit.title + '\n' + hit.lines.join('\n');
    const tip = ensureTooltip();
    if (key !== tooltipKey) {
      tip.innerHTML =
        `<div class="viz-tooltip-title">${escapeHtml(hit.title)}</div>` + hit.lines.map((l) => `<div>${escapeHtml(l)}</div>`).join('');
      tooltipKey = key;
    }
    const rect = canvas.getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = rect.left + hit.x + 12 + 'px';
    tip.style.top = rect.top + hit.y - 10 + 'px';
    canvas.style.cursor = 'pointer';
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    hoverPt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function onMouseLeave() {
    hoverPt = null;
    hideTooltip();
  }
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseleave', onMouseLeave);

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  window.addEventListener('resize', resize);
  resize();

  function update(rawNodes, liveWindowMs, warmWindowMs) {
    liveMs = liveWindowMs ?? liveMs;
    warmMs = warmWindowMs ?? warmMs;
    // Stable sort by nodeId so a spoke keeps the same slot across polls as
    // long as the active set doesn't change — avoids visual jitter.
    nodes = [...rawNodes].sort((a, b) => a.nodeId.localeCompare(b.nodeId)).slice(0, MAX_NODES);
  }

  // Evenly stack a column's items top-to-bottom within the drawable band.
  function stack(keys, x, h, marginY) {
    const n = keys.length || 1;
    const step = (h - marginY * 2) / n;
    const pos = new Map();
    keys.forEach((k, i) => pos.set(k, { x, y: marginY + step * (i + 0.5) }));
    return pos;
  }

  function drawEdge(a, b, col, alpha, dashed) {
    ctx.strokeStyle = `rgba(${col}, ${alpha})`;
    ctx.lineWidth = 1;
    ctx.setLineDash(dashed ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawParticles(a, b, col, count, t, seed, cycleMs) {
    for (let p = 0; p < count; p++) {
      const phase = p / count;
      const progress = (((t + seed * 180) / cycleMs + phase) % 1 + 1) % 1;
      const r = 1.4 + 1 * (count > 1 ? 1 - Math.abs(0.5 - progress) : 0.5);
      ctx.fillStyle = `rgba(${col}, 0.9)`;
      ctx.beginPath();
      ctx.arc(a.x + (b.x - a.x) * progress, a.y + (b.y - a.y) * progress, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Expanding, fading "radar ping" — a session/subagent mid-turn with no
  // reply yet has no real volume to show, so instead of a volume-scaled
  // glow it gets a continuous processing cue for as long as it's pending.
  function drawThinkingRing(pos, t, seed) {
    const cycleMs = 1400;
    const phase = (((t + seed * 240) / cycleMs) % 1 + 1) % 1;
    ctx.strokeStyle = `rgba(240,236,227,${(1 - phase) * 0.5})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 4 + phase * 10, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawNode(pos, r, col, glow) {
    if (glow > 0) {
      ctx.strokeStyle = `rgba(${col}, ${glow})`;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = `rgba(${col}, ${0.35 + glow * 0.55})`;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawIdle(colX, h, marginY, t) {
    const breathe = Math.sin(t / 1500) * 0.5 + 0.5;
    [0, 1, 2].forEach((c) => {
      ctx.fillStyle = `rgba(168,164,156,${0.1 + breathe * 0.08})`;
      ctx.beginPath();
      ctx.arc(colX[c], h / 2, 3 + breathe, 0, Math.PI * 2);
      ctx.fill();
    });
    const tokenPos = stack(TOKEN_TYPES.map((tt) => tt.key), colX[3], h, marginY);
    TOKEN_TYPES.forEach((tt) => {
      const pos = tokenPos.get(tt.key);
      ctx.fillStyle = `rgba(${tt.col},${0.12 + breathe * 0.1})`;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, 3 + breathe, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  function nodeTitle(n) {
    if (n.isSubagent) return n.agentLabel || n.agentType || 'subagent';
    return n.project || 'session';
  }

  function nodeLines(n) {
    const lines = [];
    lines.push(n.isSubagent ? `${n.project || 'unknown project'} · subagent` : 'main session');
    lines.push(n.model || 'model unknown');
    lines.push(n.isThinking ? `thinking since ${formatRelative(n.thinkingSince)}` : `last event ${formatRelative(n.lastEventAt)}`);
    lines.push(`${formatTokens(n.tokens)} tok / ${formatCost(n.costUsd)} (5m window)`);
    if (n.tokens) lines.push(`in ${formatTokens(n.input)} · out ${formatTokens(n.output)} · cache ${formatTokens(n.cache)}`);
    return lines;
  }

  function draw(t) {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w <= 0 || h <= 0) return;
    ctx.clearRect(0, 0, w, h);

    const frameHitTargets = [];

    const marginY = Math.max(26, h * 0.16);
    const colX = [w * 0.08, w * 0.36, w * 0.64, w * 0.92];

    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(168,164,156,0.4)';
    COLUMN_LABELS.forEach((label, i) => ctx.fillText(label, colX[i], 12));

    const active = nodes.filter((n) => n.msAgo <= warmMs);
    if (!active.length) {
      drawIdle(colX, h, marginY, t);
      hitTargets = frameHitTargets;
      updateTooltip();
      return;
    }
    const anyLive = active.some((n) => n.msAgo <= liveMs);

    // Aggregate real throughput per project / model / token-type across
    // whatever's active this frame — these numbers drive how bright each
    // aggregator node glows, same log-relative-to-loudest scale as edges,
    // and double as the numbers shown in that node's hover tooltip.
    const projTok = new Map();
    const projCost = new Map();
    const projCount = new Map();
    const modelTok = new Map();
    const modelCost = new Map();
    const modelCount = new Map();
    const typeTok = { input: 0, output: 0, cache: 0 };
    for (const n of active) {
      projTok.set(n.project, (projTok.get(n.project) || 0) + (n.tokens || 0));
      projCost.set(n.project, (projCost.get(n.project) || 0) + (n.costUsd || 0));
      projCount.set(n.project, (projCount.get(n.project) || 0) + 1);
      modelTok.set(n.model, (modelTok.get(n.model) || 0) + (n.tokens || 0));
      modelCost.set(n.model, (modelCost.get(n.model) || 0) + (n.costUsd || 0));
      modelCount.set(n.model, (modelCount.get(n.model) || 0) + 1);
      typeTok.input += n.input || 0;
      typeTok.output += n.output || 0;
      typeTok.cache += n.cache || 0;
    }

    const projects = [...projTok.keys()].sort((a, b) => (a || '').localeCompare(b || '')).slice(0, MAX_PROJECTS);
    const models = [...modelTok.keys()].sort((a, b) => (a || '').localeCompare(b || '')).slice(0, MAX_MODELS);

    const projectPos = stack(projects, colX[0], h, marginY);
    const nodePos = stack(active.map((n) => n.nodeId), colX[1], h, marginY);
    const modelPos = stack(models, colX[2], h, marginY);
    const tokenPos = stack(TOKEN_TYPES.map((tt) => tt.key), colX[3], h, marginY);

    const maxProjTok = Math.max(0, ...projects.map((p) => projTok.get(p) || 0));
    const maxModelTok = Math.max(0, ...models.map((m) => modelTok.get(m) || 0));
    const maxNodeTok = Math.max(0, ...active.map((n) => n.tokens || 0));
    const maxTypeTok = Math.max(typeTok.input, typeTok.output, typeTok.cache);
    const typeTotalTok = typeTok.input + typeTok.output + typeTok.cache;

    active.forEach((n, i) => {
      const from = projectPos.get(n.project);
      const mid = nodePos.get(n.nodeId);
      const to = modelPos.get(n.model);
      if (!from || !mid || !to) return;

      const col = colorFor(n.model);
      // A pending turn (prompt or tool result submitted, no reply logged
      // yet) counts as live for the whole time it's pending, not just its
      // first 30s — that's what makes a fresh prompt start moving right
      // away instead of waiting for its first token-bearing reply.
      const isLive = n.msAgo <= liveMs || n.isThinking;
      const recency = Math.max(0, 1 - n.msAgo / warmMs);
      const vol = volumeScale(n.tokens, maxNodeTok);
      const edgeAlpha = 0.05 + recency * 0.12 + vol * 0.2;

      drawEdge(from, mid, col, edgeAlpha, n.isSubagent);
      drawEdge(mid, to, col, edgeAlpha, n.isSubagent);

      if (isLive) {
        const count = 1 + Math.round(vol * (MAX_PARTICLES - 1));
        drawParticles(from, mid, col, count, t, i, 1100);
        drawParticles(mid, to, col, count, t, i + 0.5, 1100);

        for (const tt of TOKEN_TYPES) {
          const val = n[tt.key] || 0;
          if (!val) continue;
          const sink = tokenPos.get(tt.key);
          const share = volumeScale(val, maxNodeTok);
          const sCount = 1 + Math.round(share * (MAX_PARTICLES - 2));
          drawEdge(mid, sink, tt.col, 0.04 + share * 0.16, false);
          drawParticles(mid, sink, tt.col, sCount, t, i + tt.key.length, 900);
        }
      }

      if (n.isThinking) drawThinkingRing(mid, t, i);

      const r = (n.isSubagent ? 2.2 : 3) + recency * 2.2;
      drawNode(mid, r, col, isLive ? 0.3 + vol * 0.35 : 0);
      frameHitTargets.push({ x: mid.x, y: mid.y, r: Math.max(9, r + 5), title: nodeTitle(n), lines: nodeLines(n) });
    });

    // Aggregator nodes breathe with their total inflow this frame.
    projects.forEach((p) => {
      const vol = volumeScale(projTok.get(p), maxProjTok);
      const pos = projectPos.get(p);
      const r = 3.5 + vol * 2.5;
      drawNode(pos, r, '240,236,227', anyLive ? 0.2 + vol * 0.4 : 0);
      frameHitTargets.push({
        x: pos.x,
        y: pos.y,
        r: Math.max(9, r + 5),
        title: p || 'unknown project',
        lines: [`${projCount.get(p) || 0} active node${(projCount.get(p) || 0) === 1 ? '' : 's'}`, `${formatTokens(projTok.get(p) || 0)} tok / ${formatCost(projCost.get(p) || 0)} (5m window)`],
      });
    });
    models.forEach((m) => {
      const vol = volumeScale(modelTok.get(m), maxModelTok);
      const pos = modelPos.get(m);
      const r = 3.5 + vol * 2.5;
      drawNode(pos, r, colorFor(m), anyLive ? 0.2 + vol * 0.4 : 0);
      frameHitTargets.push({
        x: pos.x,
        y: pos.y,
        r: Math.max(9, r + 5),
        title: m || 'unknown model',
        lines: [`${modelCount.get(m) || 0} active node${(modelCount.get(m) || 0) === 1 ? '' : 's'}`, `${formatTokens(modelTok.get(m) || 0)} tok / ${formatCost(modelCost.get(m) || 0)} (5m window)`],
      });
    });
    TOKEN_TYPES.forEach((tt) => {
      const vol = volumeScale(typeTok[tt.key], maxTypeTok);
      const pos = tokenPos.get(tt.key);
      const r = 3.5 + vol * 2.5;
      drawNode(pos, r, tt.col, anyLive ? 0.2 + vol * 0.4 : 0);
      const share = typeTotalTok ? Math.round((typeTok[tt.key] / typeTotalTok) * 100) : 0;
      frameHitTargets.push({
        x: pos.x,
        y: pos.y,
        r: Math.max(9, r + 5),
        title: tt.key[0].toUpperCase() + tt.key.slice(1),
        lines: [`${formatTokens(typeTok[tt.key])} tok (5m window)`, `${share}% of active throughput`],
      });
    });

    hitTargets = frameHitTargets;
    updateTooltip();
  }

  function loop(t) {
    draw(t);
    raf = requestAnimationFrame(loop);
  }
  raf = requestAnimationFrame(loop);

  return {
    update,
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      if (tooltipEl) tooltipEl.remove();
    },
  };
}
