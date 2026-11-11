import { usageBreakdown, cacheSplit } from './usage.js';
import { costForUsage, resolveModel } from './pricing.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_DAYS = 14;
const HISTORY_WEEKS = 12;
const HISTORY_MONTHS = 12;
const TOP_N = 20;
const RECENT_N = 25;

// "Currently happening" per the ask: a turn that landed in the last 30s.
// WARM is how long a session keeps a fading spot in the pulse view after
// that, so it doesn't just blink out.
export const LIVE_WINDOW_MS = 30 * 1000;
export const WARM_WINDOW_MS = 5 * 60 * 1000;

// A session/subagent stuck on an open "user" turn (see parseLogs.js's
// pendingTurns) with no reply for longer than this is treated as abandoned
// rather than still thinking, so a crashed or walked-away-from session
// doesn't light up the pulse forever.
const THINKING_TIMEOUT_MS = 10 * 60 * 1000;

export const TIERS = ['live', 'recovered', 'estimated'];

// ── Local calendar helpers ──────────────────────────────────────────────
// This server only ever runs on the same machine as the browser viewing it,
// so the server's local timezone is the viewer's: "Today" and every day /
// month bucket follow the local calendar rather than UTC (which would put
// an evening's work in the US onto the next day).

const pad2 = (n) => String(n).padStart(2, '0');

export function localDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function localMonthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ── Rollup ──────────────────────────────────────────────────────────────
// Every view of spend — all-time totals, the period cards, the By Project /
// By Model panels, all three charts, and the full-history project list —
// is computed from one stream of entries, so they all reconcile exactly.
// An entry is one slice of spend in one tier:
//  - live: one billed API response, exact, from a transcript on disk.
//  - recovered: Claude Code's own stats-cache.json totals for days whose
//    transcripts are gone (see merge.js).
//  - estimated: prompts from history.jsonl whose transcripts are gone and
//    that no recovered total covers, priced at a measured average rate.

function emptyTok() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
}

function tokSum(t) {
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}

function emptyBucket() {
  // liveTok: the exact (live-tier) part of this bucket, by token type.
  const b = { ...emptyTok(), costUsd: 0, turns: 0, liveTok: emptyTok() };
  for (const t of TIERS) b[t] = { tokens: 0, costUsd: 0 };
  return b;
}

function addToBucket(b, e) {
  b.input += e.tok.input;
  b.output += e.tok.output;
  b.cacheWrite += e.tok.cacheWrite;
  b.cacheRead += e.tok.cacheRead;
  b.costUsd += e.costUsd;
  b.turns += e.turns;
  b[e.tier].tokens += tokSum(e.tok);
  b[e.tier].costUsd += e.costUsd;
  if (e.tier === 'live') addTok(b.liveTok, e.tok);
}

function bump(map, key, e) {
  let b = map.get(key);
  if (!b) map.set(key, (b = emptyBucket()));
  addToBucket(b, e);
}

export function createRollup(now = Date.now()) {
  const periodStarts = {
    today: startOfLocalDay(now),
    week: now - 7 * DAY_MS,
    month: now - 30 * DAY_MS,
    year: now - 365 * DAY_MS,
  };
  const periods = {};
  for (const k of Object.keys(periodStarts)) periods[k] = { bucket: emptyBucket(), byProject: new Map(), byModel: new Map() };
  return {
    now,
    periodStarts,
    totals: emptyBucket(),
    periods,
    byDay: new Map(),
    byWeekIdx: new Map(),
    byMonth: new Map(),
    byProject: new Map(),
    byModel: new Map(),
  };
}

// entry: { ms, project, model, tier, tok: {input, output, cacheWrite, cacheRead}, costUsd, turns }
export function addEntry(r, e) {
  addToBucket(r.totals, e);
  for (const [k, start] of Object.entries(r.periodStarts)) {
    if (e.ms >= start) {
      const p = r.periods[k];
      addToBucket(p.bucket, e);
      bump(p.byProject, e.project, e);
      bump(p.byModel, e.model, e);
    }
  }
  bump(r.byDay, localDayKey(e.ms), e);
  bump(r.byMonth, localMonthKey(e.ms), e);
  const weekIdx = Math.max(0, Math.floor((r.now - e.ms) / (7 * DAY_MS)));
  if (weekIdx < HISTORY_WEEKS) bump(r.byWeekIdx, weekIdx, e);
  bump(r.byProject, e.project, e);
  bump(r.byModel, e.model, e);
}

function publicBucket(b) {
  return {
    input: b.input,
    output: b.output,
    cacheWrite: b.cacheWrite,
    cacheRead: b.cacheRead,
    tokens: tokSum(b),
    costUsd: b.costUsd,
    turns: b.turns,
    liveTokens: b.live.tokens,
    liveCostUsd: b.live.costUsd,
    recoveredTokens: b.recovered.tokens,
    recoveredCostUsd: b.recovered.costUsd,
    estimatedTokens: b.estimated.tokens,
    estimatedCostUsd: b.estimated.costUsd,
  };
}

// The stacked chart splits exact (live) tokens by type, and shows each
// non-exact tier as its own segment rather than implying a precise
// input/output/cache split for it.
function chartPoint(b, label, key) {
  return {
    key,
    label,
    input: b?.liveTok.input || 0,
    output: b?.liveTok.output || 0,
    cache: (b?.liveTok.cacheWrite || 0) + (b?.liveTok.cacheRead || 0),
    recovered: b?.recovered.tokens || 0,
    estimated: b?.estimated.tokens || 0,
    costUsd: b?.costUsd || 0,
    liveCostUsd: b?.live.costUsd || 0,
    recoveredCostUsd: b?.recovered.costUsd || 0,
    estimatedCostUsd: b?.estimated.costUsd || 0,
  };
}

// Top rows by cost. Anything past the limit is folded into one "+N more"
// row (isOther) rather than dropped, so a list always sums to its total.
function rankedList(map, keyName, limit = TOP_N) {
  const rows = [...map.entries()]
    .map(([key, b]) => ({
      [keyName]: key,
      tokens: tokSum(b),
      costUsd: b.costUsd,
      turns: b.turns,
      liveCostUsd: b.live.costUsd,
      recoveredCostUsd: b.recovered.costUsd,
      estimatedCostUsd: b.estimated.costUsd,
    }))
    .sort((a, b) => b.costUsd - a.costUsd);
  if (rows.length <= limit) return rows;
  const top = rows.slice(0, limit - 1);
  const rest = rows.slice(limit - 1);
  const other = { [keyName]: `+${rest.length} more`, isOther: true, tokens: 0, costUsd: 0, turns: 0, liveCostUsd: 0, recoveredCostUsd: 0, estimatedCostUsd: 0 };
  for (const r of rest) for (const k of ['tokens', 'costUsd', 'turns', 'liveCostUsd', 'recoveredCostUsd', 'estimatedCostUsd']) other[k] += r[k];
  return [...top, other];
}

export function finalizeRollup(r) {
  const { now } = r;

  const dailyChart = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i); // calendar arithmetic, so DST days don't skip or repeat
    const key = localDayKey(d.getTime());
    dailyChart.push(chartPoint(r.byDay.get(key), key.slice(5).replace('-', '/'), key));
  }

  const weeklyChart = [];
  for (let idx = HISTORY_WEEKS - 1; idx >= 0; idx--) {
    const key = localDayKey(now - (idx + 1) * 7 * DAY_MS + 1);
    weeklyChart.push(chartPoint(r.byWeekIdx.get(idx), key.slice(5).replace('-', '/'), key));
  }

  const monthlyChart = [];
  const base = new Date(now);
  for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    const key = localMonthKey(d.getTime());
    monthlyChart.push(chartPoint(r.byMonth.get(key), d.toLocaleString('en-US', { month: 'short' }), key));
  }

  const periods = {};
  for (const [k, p] of Object.entries(r.periods)) {
    periods[k] = { ...publicBucket(p.bucket), byProject: rankedList(p.byProject, 'project'), byModel: rankedList(p.byModel, 'model') };
  }

  return {
    totals: publicBucket(r.totals),
    periods,
    charts: { daily: dailyChart, weekly: weeklyChart, monthly: monthlyChart },
    byProject: rankedList(r.byProject, 'project'),
    byModel: rankedList(r.byModel, 'model'),
    // Every project, untruncated, for the full-history list.
    projectTiers: new Map([...r.byProject].map(([p, b]) => [p, { tokens: tokSum(b), live: b.live, recovered: b.recovered, estimated: b.estimated }])),
  };
}

// ── Live (transcript) aggregation ───────────────────────────────────────

function emptyNode() {
  return {
    recMs: -Infinity, timestamp: null, project: null, model: null, isSubagent: false,
    agentType: null, agentLabel: null, recentTokens: 0, recentCostUsd: 0,
    recentInput: 0, recentOutput: 0, recentCache: 0, isThinking: false, thinkingSince: null,
  };
}

// Folds every live record into `rollup` and returns everything else the
// report needs from the transcripts: activity pulse nodes, the recent-turn
// feed, per-session spend (merge.js uses it to measure a real cost per
// prompt), and per-model usage (to price stats-cache.json's totals the
// same way live data is priced). `extraEntries` are reconcile.js's
// additions for spend transcripts don't show; they count toward totals
// and per-session spend, but not the per-response feed or the pulse.
export function aggregateLive(rollup, records, pendingTurns = [], extraEntries = []) {
  const { now } = rollup;
  const sessions = new Set();
  const lastEventByNode = new Map();
  // ownerSessionId -> { costUsd, tok, byModel: Map(model -> { costUsd, tok }), spend: [{ ms, model, tok, costUsd }] }
  // Keyed by the owning (main) session, so a session's subagents count as
  // part of it.
  const bySession = new Map();
  const addSessionSpend = (sid, ms, model, tok, cost) => {
    let s = bySession.get(sid);
    if (!s) bySession.set(sid, (s = { costUsd: 0, tok: emptyTok(), byModel: new Map(), spend: [] }));
    s.costUsd += cost;
    addTok(s.tok, tok);
    let sm = s.byModel.get(model);
    if (!sm) s.byModel.set(model, (sm = { costUsd: 0, tok: emptyTok() }));
    sm.costUsd += cost;
    addTok(sm.tok, tok);
    s.spend.push({ ms, model, tok, costUsd: cost });
  };
  const usageByModel = new Map(); // model -> { tok, write5m, write1h }
  let lastEventAt = null;
  let firstEventAt = null;
  // A model string pricing.js doesn't recognize at all prices to null —
  // those tokens still count everywhere, but add $0, so they're tracked to
  // say so in the UI instead of quietly under-reporting cost. Models only
  // matched by family (a release newer than the price table) are priced at
  // that family's newest rate and flagged as approximate.
  let unpricedTokens = 0;
  const unpricedModels = new Set();
  const approxPricedModels = new Set();

  const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  for (const rec of sorted) {
    const tok = usageBreakdown(rec.usage);
    const total = tokSum(tok);
    const rawCost = costForUsage(rec.model, rec.usage);
    if (rawCost == null) {
      unpricedTokens += total;
      unpricedModels.add(rec.model || 'unknown');
    } else if (!resolveModel(rec.model).exact) {
      approxPricedModels.add(rec.model);
    }
    const cost = rawCost || 0;
    const recMs = Date.parse(rec.timestamp);
    const model = rec.model || 'unknown';

    addEntry(rollup, { ms: recMs, project: rec.project, model, tier: 'live', tok, costUsd: cost, turns: 1 });

    const sid = rec.ownerSessionId || rec.sessionId;
    if (sid) {
      sessions.add(sid);
      addSessionSpend(sid, recMs, model, tok, cost);
    }

    let mu = usageByModel.get(model);
    if (!mu) usageByModel.set(model, (mu = { tok: emptyTok(), write5m: 0, write1h: 0 }));
    addTok(mu.tok, tok);
    const split = cacheSplit(rec.usage);
    mu.write5m += split.write5m;
    mu.write1h += split.write1h;

    // A subagent gets its own node (keyed by agentId) so N subagents
    // running in parallel under one session show as N pulses, not one.
    // Main-thread turns fall back to sessionId.
    const nodeKey = rec.agentId || rec.sessionId;
    if (nodeKey) {
      let node = lastEventByNode.get(nodeKey);
      if (!node) lastEventByNode.set(nodeKey, (node = emptyNode()));
      if (recMs > node.recMs) {
        node.recMs = recMs;
        node.timestamp = rec.timestamp;
        node.project = rec.project;
        node.model = rec.model;
        node.isSubagent = Boolean(rec.agentId);
        node.agentType = rec.agentType;
        node.agentLabel = rec.agentLabel;
      }
      // Volume for the pulse animation: total throughput for this node
      // within the warm window, not just its single latest turn. Kept
      // split by type too, so the pulse can show input/output/cache as
      // distinct downstream sinks instead of one undifferentiated total.
      const ageMs = now - recMs;
      if (ageMs >= 0 && ageMs <= WARM_WINDOW_MS) {
        node.recentTokens += total;
        node.recentCostUsd += cost;
        node.recentInput += tok.input;
        node.recentOutput += tok.output;
        node.recentCache += tok.cacheWrite + tok.cacheRead;
      }
    }

    if (!lastEventAt || rec.timestamp > lastEventAt) lastEventAt = rec.timestamp;
    if (!firstEventAt || rec.timestamp < firstEventAt) firstEventAt = rec.timestamp;
  }

  for (const e of extraEntries) {
    addEntry(rollup, e);
    if (e.ownerSessionId) addSessionSpend(e.ownerSessionId, e.ms, e.model, e.tok, e.costUsd);
  }

  // Fold in sessions/subagents that are mid-turn right now — prompt or tool
  // result submitted, no reply logged yet. Applied after the records above
  // so its recency always wins: a pending entry only exists when it's the
  // last turn in its file, so by construction it postdates every assistant
  // record already folded into that same node. This is what makes a
  // brand-new prompt light the pulse up immediately instead of waiting for
  // its first billed reply.
  for (const p of pendingTurns) {
    const nodeKey = p.agentId || p.sessionId;
    if (!nodeKey) continue;
    const pendingMs = Date.parse(p.timestamp);
    if (now - pendingMs > THINKING_TIMEOUT_MS) continue;

    let node = lastEventByNode.get(nodeKey);
    if (!node) lastEventByNode.set(nodeKey, (node = emptyNode()));
    node.isThinking = true;
    node.thinkingSince = p.timestamp;
    node.project = node.project || p.project;
    node.model = node.model || p.model; // last known model as a placeholder until its own reply lands
    node.agentType = node.agentType || p.agentType;
    node.agentLabel = node.agentLabel || p.agentLabel;
    node.isSubagent = node.isSubagent || Boolean(p.agentId);
    if (pendingMs > node.recMs) {
      node.recMs = pendingMs;
      node.timestamp = p.timestamp;
    }
  }

  const recent = sorted
    .slice(-RECENT_N)
    .reverse()
    .map((rec) => ({
      timestamp: rec.timestamp,
      project: rec.project,
      model: rec.model,
      tokens: tokSum(usageBreakdown(rec.usage)),
      costUsd: costForUsage(rec.model, rec.usage),
    }));

  // Every session or subagent whose most recent turn landed within
  // WARM_WINDOW_MS — this is what the pulse animation renders. "Live" (last
  // 30s) vs "warm" (fading out over the following minutes) is decided
  // client-side against the two window values below, so there's one
  // definition of each shared by every consumer.
  const networkNodes = [...lastEventByNode.entries()]
    .map(([nodeId, s]) => ({
      nodeId,
      project: s.project,
      model: s.model,
      isSubagent: s.isSubagent,
      agentType: s.agentType,
      agentLabel: s.agentLabel,
      lastEventAt: s.timestamp,
      msAgo: now - s.recMs,
      tokens: s.recentTokens,
      costUsd: s.recentCostUsd,
      input: s.recentInput,
      output: s.recentOutput,
      cache: s.recentCache,
      isThinking: s.isThinking,
      thinkingSince: s.thinkingSince,
    }))
    .filter((n) => n.msAgo >= 0 && n.msAgo <= WARM_WINDOW_MS);

  return {
    lastEventAt,
    firstEventAt,
    sessions: sessions.size,
    bySession,
    usageByModel,
    unpricedTokens,
    unpricedModels: [...unpricedModels],
    approxPricedModels: [...approxPricedModels],
    recent,
    network: { nodes: networkNodes, liveWindowMs: LIVE_WINDOW_MS, warmWindowMs: WARM_WINDOW_MS },
  };
}

function addTok(into, t) {
  into.input += t.input;
  into.output += t.output;
  into.cacheWrite += t.cacheWrite;
  into.cacheRead += t.cacheRead;
}
