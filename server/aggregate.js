import { usageBreakdown as breakdown } from './usage.js';
import { costForUsage } from './pricing.js';

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
// collectPendingTurns) with no reply for longer than this is treated as
// abandoned rather than still thinking, so a crashed or walked-away-from
// session doesn't light up the pulse forever.
const THINKING_TIMEOUT_MS = 10 * 60 * 1000;

const PERIOD_WINDOWS_MS = {
  today: DAY_MS,
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS,
};

function dayKeyOf(iso) {
  return iso.slice(0, 10);
}

function emptyBucket() {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, costUsd: 0, turns: 0 };
}

function accumulate(bucket, tok, costUsd) {
  bucket.input += tok.input;
  bucket.output += tok.output;
  bucket.cacheWrite += tok.cacheWrite;
  bucket.cacheRead += tok.cacheRead;
  bucket.costUsd += costUsd || 0;
  bucket.turns += 1;
}

function bumpMap(map, key, tok, costUsd) {
  const bucket = map.get(key) || emptyBucket();
  accumulate(bucket, tok, costUsd);
  map.set(key, bucket);
}

function bucketTokens(bucket) {
  return bucket.input + bucket.output + bucket.cacheWrite + bucket.cacheRead;
}

function withTokens(bucket) {
  return { ...bucket, tokens: bucketTokens(bucket) };
}

function chartPoint(bucket, label, key) {
  return {
    key,
    label,
    input: bucket?.input || 0,
    output: bucket?.output || 0,
    cache: (bucket?.cacheWrite || 0) + (bucket?.cacheRead || 0),
    costUsd: bucket?.costUsd || 0,
  };
}

function emptyNode() {
  return {
    recMs: -Infinity, timestamp: null, project: null, model: null, isSubagent: false,
    agentType: null, agentLabel: null, recentTokens: 0, recentCostUsd: 0,
    recentInput: 0, recentOutput: 0, recentCache: 0, isThinking: false, thinkingSince: null,
    liveOnly: false,
  };
}

export function aggregate(records, pendingTurns = []) {
  const now = Date.now();

  const totals = emptyBucket();
  const periods = { today: emptyBucket(), week: emptyBucket(), month: emptyBucket(), year: emptyBucket() };
  const byDay = new Map();
  const byWeekIdx = new Map();
  const byMonth = new Map();
  const byProject = new Map();
  const byModel = new Map();
  // Same breakdown as byProject/byModel above, but scoped to each period
  // window too — feeds the By Project / By Model panels so they follow the
  // Today/7 Days/30 Days/1 Year switch instead of always showing all-time.
  const byProjectPeriod = { today: new Map(), week: new Map(), month: new Map(), year: new Map() };
  const byModelPeriod = { today: new Map(), week: new Map(), month: new Map(), year: new Map() };
  const sessions = new Set();
  const lastEventByNode = new Map();
  let lastEventAt = null;
  let firstEventAt = null;
  // costForUsage returns null for a model string pricing.js doesn't
  // recognize (no exact match, no family-regex fallback) — those tokens
  // still count toward every token total above, but contribute $0 to every
  // cost total, with nothing else here to distinguish "genuinely free" from
  // "unpriced." Tracked separately so the UI can say so instead of quietly
  // under-reporting cost.
  let unpricedTokens = 0;
  const unpricedModels = new Set();

  const sorted = [...records].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  for (const rec of sorted) {
    const tok = breakdown(rec.usage);
    const rawCost = costForUsage(rec.model, rec.usage);
    const cost = rawCost || 0;
    const recMs = new Date(rec.timestamp).getTime();
    const ageMs = now - recMs;

    // Records from an oversized transcript (see parseLogs.js) are only the
    // tail of its history, so counting them in any total would be a
    // misleading partial number. They still feed the live activity below.
    if (!rec.liveOnly) {
      if (rawCost == null) {
        unpricedTokens += bucketTokens(tok);
        unpricedModels.add(rec.model || 'unknown');
      }

      accumulate(totals, tok, cost);

      for (const key of Object.keys(PERIOD_WINDOWS_MS)) {
        if (ageMs >= 0 && ageMs <= PERIOD_WINDOWS_MS[key]) {
          accumulate(periods[key], tok, cost);
          bumpMap(byProjectPeriod[key], rec.project, tok, cost);
          bumpMap(byModelPeriod[key], rec.model, tok, cost);
        }
      }

      bumpMap(byDay, dayKeyOf(rec.timestamp), tok, cost);
      bumpMap(byMonth, dayKeyOf(rec.timestamp).slice(0, 7), tok, cost);
      if (ageMs >= 0) {
        const weekIdx = Math.floor(ageMs / (7 * DAY_MS));
        if (weekIdx < HISTORY_WEEKS) bumpMap(byWeekIdx, weekIdx, tok, cost);
      }

      bumpMap(byProject, rec.project, tok, cost);
      bumpMap(byModel, rec.model, tok, cost);

      if (rec.sessionId) sessions.add(rec.sessionId);
      if (!firstEventAt || rec.timestamp < firstEventAt) firstEventAt = rec.timestamp;
    }

    // A subagent gets its own node (keyed by agentId) so N subagents
    // running in parallel under one session show as N pulses, not one.
    // Main-thread turns fall back to sessionId.
    const nodeKey = rec.agentId || rec.sessionId;
    if (nodeKey) {
      let node = lastEventByNode.get(nodeKey);
      if (!node) {
        node = emptyNode();
        lastEventByNode.set(nodeKey, node);
      }
      if (recMs > node.recMs) {
        node.recMs = recMs;
        node.timestamp = rec.timestamp;
        node.project = rec.project;
        node.model = rec.model;
        node.isSubagent = Boolean(rec.agentId);
        node.agentType = rec.agentType;
        node.agentLabel = rec.agentLabel;
      }
      if (rec.liveOnly) node.liveOnly = true;
      // Volume for the pulse animation: total throughput for this node
      // within the warm window, not just its single latest turn. Kept
      // split by type too, so the pulse can show input/output/cache as
      // distinct downstream sinks instead of one undifferentiated total.
      if (ageMs >= 0 && ageMs <= WARM_WINDOW_MS) {
        node.recentTokens += bucketTokens(tok);
        node.recentCostUsd += cost;
        node.recentInput += tok.input;
        node.recentOutput += tok.output;
        node.recentCache += tok.cacheWrite + tok.cacheRead;
      }
    }

    if (!lastEventAt || rec.timestamp > lastEventAt) lastEventAt = rec.timestamp;
  }

  // Fold in sessions/subagents that are mid-turn right now — prompt or tool
  // result submitted, no reply logged yet (see parseLogs.js's
  // collectPendingTurns). Applied after the records above so its recency
  // always wins: a pending entry only exists when it's the last line in its
  // file, so by construction it postdates every assistant record already
  // folded into that same node. This is what makes a brand-new prompt light
  // the pulse up immediately instead of waiting for its first billed reply.
  for (const p of pendingTurns) {
    const nodeKey = p.agentId || p.sessionId;
    if (!nodeKey) continue;
    const pendingMs = new Date(p.timestamp).getTime();
    if (now - pendingMs > THINKING_TIMEOUT_MS) continue;

    const node = lastEventByNode.get(nodeKey) || emptyNode();
    lastEventByNode.set(nodeKey, node);
    node.isThinking = true;
    node.thinkingSince = p.timestamp;
    node.project = node.project || p.project;
    node.model = node.model || p.model; // last known model as a placeholder until its own reply lands
    node.agentType = node.agentType || p.agentType;
    node.agentLabel = node.agentLabel || p.agentLabel;
    node.isSubagent = node.isSubagent || Boolean(p.agentId);
    if (p.liveOnly) node.liveOnly = true;
    if (pendingMs > node.recMs) {
      node.recMs = pendingMs;
      node.timestamp = p.timestamp;
    }
  }

  const dailyChart = [];
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const key = new Date(now - i * DAY_MS).toISOString().slice(0, 10);
    dailyChart.push(chartPoint(byDay.get(key), key.slice(5).replace('-', '/'), key));
  }

  const weeklyChart = [];
  for (let idx = HISTORY_WEEKS - 1; idx >= 0; idx--) {
    const startMs = now - (idx + 1) * 7 * DAY_MS;
    const key = new Date(startMs).toISOString().slice(0, 10);
    weeklyChart.push(chartPoint(byWeekIdx.get(idx), key.slice(5).replace('-', '/'), key));
  }

  const monthlyChart = [];
  const base = new Date(now);
  for (let i = HISTORY_MONTHS - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    monthlyChart.push(chartPoint(byMonth.get(key), d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }), key));
  }

  const toRankedList = (map, keyName) =>
    [...map.entries()]
      .map(([key, bucket]) => ({ [keyName]: key, tokens: bucketTokens(bucket), costUsd: bucket.costUsd, turns: bucket.turns }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, TOP_N);

  const periodResult = (bucket, projectMap, modelMap) => ({
    ...withTokens(bucket),
    byProject: toRankedList(projectMap, 'project'),
    byModel: toRankedList(modelMap, 'model'),
  });

  const recent = sorted
    .slice(-RECENT_N)
    .reverse()
    .map((rec) => ({
      timestamp: rec.timestamp,
      project: rec.project,
      model: rec.model,
      tokens: bucketTokens(breakdown(rec.usage)),
      costUsd: costForUsage(rec.model, rec.usage),
      liveOnly: Boolean(rec.liveOnly),
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
      liveOnly: s.liveOnly,
    }))
    .filter((n) => n.msAgo >= 0 && n.msAgo <= WARM_WINDOW_MS);

  return {
    generatedAt: new Date(now).toISOString(),
    lastEventAt,
    firstEventAt,
    totals: { ...withTokens(totals), sessions: sessions.size, unpricedTokens, unpricedModels: [...unpricedModels] },
    periods: {
      today: periodResult(periods.today, byProjectPeriod.today, byModelPeriod.today),
      week: periodResult(periods.week, byProjectPeriod.week, byModelPeriod.week),
      month: periodResult(periods.month, byProjectPeriod.month, byModelPeriod.month),
      year: periodResult(periods.year, byProjectPeriod.year, byModelPeriod.year),
    },
    charts: { daily: dailyChart, weekly: weeklyChart, monthly: monthlyChart },
    byProject: toRankedList(byProject, 'project'),
    byModel: toRankedList(byModel, 'model'),
    recent,
    network: { nodes: networkNodes, liveWindowMs: LIVE_WINDOW_MS, warmWindowMs: WARM_WINDOW_MS },
  };
}
