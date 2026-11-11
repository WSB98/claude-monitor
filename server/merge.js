// Builds the full report: exact live spend from transcripts (aggregate.js),
// plus Claude Code's own historical records (history.js) for whatever the
// transcripts no longer cover. Three tiers, in order of decreasing
// confidence; every prompt in history.jsonl lands in exactly one:
//
//  - "live": its session still has a transcript on disk, so its cost is
//    already counted response by response — plus whatever Claude Code's
//    own cost-state totals show the transcript missed (reconcile.js).
//  - "recovered": its session's transcript is gone, but Claude Code kept
//    its own record of that session's usage (~/.claude.json, see
//    history.js readReportedSessions) — exact token totals, spread over
//    the session's prompts. Or: its session's transcript is gone, but stats-cache.json
//    (Claude Code's own per-day token totals) covers its day. That day's
//    total is split across that day's uncovered prompts in proportion to
//    what each is expected to cost (see estimate.js). Only days
//    before the first surviving transcript event are used, so it never
//    overlaps live data (its days are UTC dates). stats-cache counts
//    every transcript line, so it carries the same per-content-block
//    duplication parseLogs.js removes; it's corrected with the duplication
//    ratio measured on live transcripts, per model and token type.
//  - "estimated": no surviving data at all (deleted session, outside the
//    stats-cache window). Priced by estimate.js's per-prompt model, fitted
//    on every surviving session that also has history.jsonl prompts: cost
//    by the prompt's position within its session, scaled by its project's
//    measured intensity. Sessions with no history.jsonl prompts at all
//    (e.g. ones started from an app or SDK rather than the CLI) can't be
//    split into prompts, so they don't feed the model.
//    Also estimated: reconcile.js's modeled correction for responses no
//    cost-state snapshot covers.
//
// All three tiers feed the same rollup (aggregate.js), so the all-time
// totals, the period cards, By Project / By Model, every chart, and the
// full-history project list are all slices of one set of numbers and
// reconcile exactly.

import { createRollup, addEntry, finalizeRollup, aggregateLive } from './aggregate.js';
import { costFromBreakdown } from './pricing.js';
import { summarizeProjectHistory } from './history.js';
import { reconcile } from './reconcile.js';
import { buildPromptModel } from './estimate.js';

const TOK_KEYS = ['input', 'output', 'cacheWrite', 'cacheRead'];
const ONE = { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 };

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function modelsByMonth(prompts, promptModel) {
  const months = new Map();
  for (const p of prompts) {
    const key = new Date(p.ms).toISOString().slice(0, 7);
    if (!months.has(key)) months.set(key, { month: key, prompts: 0, ms: p.ms });
    months.get(key).prompts += 1;
  }
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      month: m.month,
      prompts: m.prompts,
      models: promptModel.mixAt(Date.parse(`${m.month}-15T12:00:00Z`)).shares.map((x) => ({ model: x.model, share: Math.round(x.share * 1000) / 1000 })),
    }));
}
const tokSum = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;
const scaleTok = (t, f) => ({ input: t.input * f, output: t.output * f, cacheWrite: t.cacheWrite * f, cacheRead: t.cacheRead * f });

// Token-weighted average of the per-model duplication ratios — used for a
// stats-cache model that has no live transcripts to measure its own.
function overallDuplication(duplicationByModel, usageByModel) {
  const num = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  const den = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  for (const [model, r] of duplicationByModel) {
    const u = usageByModel.get(model)?.tok;
    if (!u) continue;
    for (const k of TOK_KEYS) {
      if (!r[k]) continue;
      num[k] += u[k]; // deduplicated
      den[k] += u[k] / r[k]; // raw
    }
  }
  const out = {};
  for (const k of TOK_KEYS) out[k] = den[k] ? num[k] / den[k] : 1;
  return out;
}

// Prices each stats-cache model's whole-window totals the way live data is
// priced, after removing line duplication. stats-cache doesn't split cache
// writes by TTL, so the 1-hour share measured on that model's live data is
// used (all 5-minute if there's none). Haiku 5.5's per-request long-prompt
// tier can't be decided from an aggregate, so base rates apply there.
function priceRecoveredModels(stats, duplicationByModel, usageByModel) {
  const overall = overallDuplication(duplicationByModel, usageByModel);
  let liveW5 = 0;
  let liveW1 = 0;
  for (const u of usageByModel.values()) {
    liveW5 += u.write5m;
    liveW1 += u.write1h;
  }
  const out = new Map();
  for (const [model, m] of Object.entries(stats.models)) {
    const r = duplicationByModel.get(model) || overall || ONE;
    const tok = { input: m.input * r.input, output: m.output * r.output, cacheWrite: m.cacheWrite * r.cacheWrite, cacheRead: m.cacheRead * r.cacheRead };
    const u = usageByModel.get(model);
    const w5 = u ? u.write5m : liveW5;
    const w1 = u ? u.write1h : liveW1;
    const share1h = w5 + w1 > 0 ? w1 / (w5 + w1) : 0;
    const costUsd = costFromBreakdown(model, {
      input: tok.input,
      output: tok.output,
      cacheWrite5m: tok.cacheWrite * (1 - share1h),
      cacheWrite1h: tok.cacheWrite * share1h,
      cacheRead: tok.cacheRead,
      webSearches: m.webSearches,
      perRequest: false,
    });
    // input+output across all its days, to apportion the totals by day
    const dayBasis = stats.days.reduce((a, d) => a + (d.tokensByModel[model] || 0), 0);
    out.set(model, { tok, costUsd, priced: costUsd != null, dayBasis });
  }
  return out;
}

export function buildReport({ records, pendingTurns, transcriptSessionIds, duplicationByModel = new Map(), snapshots = [], recoveredStats, promptHistory = [], reportedSessions = [] }) {
  const rollup = createRollup();
  const recon = reconcile(records, snapshots);
  const live = aggregateLive(rollup, records, pendingTurns, recon.entries);
  let liveW5 = 0;
  let liveW1 = 0;
  for (const u of live.usageByModel.values()) {
    liveW5 += u.write5m;
    liveW1 += u.write1h;
  }
  const promptModel = buildPromptModel(live.bySession, promptHistory, { liveShare1h: liveW5 + liveW1 > 0 ? liveW1 / (liveW5 + liveW1) : 0 });
  const predictPrompt = (p) => (promptModel ? promptModel.predict(p) : []);

  // ── Deleted sessions Claude Code recorded itself: exact usage, recovered.
  // Each is spread over its own prompts by their expected cost, and also
  // becomes a calibration point for what spending looked like back then. ──
  const promptsBySessionId = new Map();
  for (const p of promptHistory) {
    if (!p.sessionId) continue;
    if (!promptsBySessionId.has(p.sessionId)) promptsBySessionId.set(p.sessionId, []);
    promptsBySessionId.get(p.sessionId).push(p);
  }
  const reportedPrompts = new Set();
  let reportedSessionCount = 0;
  let reportedCostUsd = 0;
  for (const rs of reportedSessions) {
    if (transcriptSessionIds.has(rs.sessionId) || live.bySession.has(rs.sessionId)) continue; // counted exactly already
    const prompts = (promptsBySessionId.get(rs.sessionId) || []).sort((a, b) => a.ms - b.ms);
    if (!prompts.length) continue; // nothing to place it in time with
    let sessionCost = 0;
    const weights = prompts.map((p) => (promptModel ? promptModel.baseVolume(p) : 1));
    const wSum = weights.reduce((a, w) => a + w, 0);
    for (const [rawModel, t] of Object.entries(rs.models)) {
      const model = rawModel.replace(/\[[^\]]*\]$/, '');
      // No TTL split is recorded; these predate the transcripts on disk,
      // when the 5-minute cache was the norm.
      const costUsd = costFromBreakdown(model, { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite5m: t.cacheWrite, webSearches: t.webSearches, perRequest: false });
      if (costUsd == null) unpricedModels.add(model);
      const tok = { input: t.input, output: t.output, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead };
      prompts.forEach((p, i) => {
        const share = wSum > 0 ? weights[i] / wSum : 1 / prompts.length;
        addEntry(rollup, { ms: p.ms, project: p.project, model, tier: 'recovered', tok: scaleTok(tok, share), costUsd: (costUsd || 0) * share, turns: 0 });
      });
      sessionCost += costUsd || 0;
    }
    for (const p of prompts) reportedPrompts.add(p);
    if (promptModel) {
      promptModel.addCalibration(
        prompts,
        Object.entries(rs.models).map(([m, t]) => [m, { input: t.input, output: t.output, cacheWrite: t.cacheWrite, cacheRead: t.cacheRead }]),
      );
    }
    reportedSessionCount += 1;
    reportedCostUsd += sessionCost;
  }
  const liveFirstMs = live.firstEventAt ? Date.parse(live.firstEventAt) : Infinity;
  const liveFirstDay = Number.isFinite(liveFirstMs) ? utcDay(liveFirstMs) : null;
  const unpricedModels = new Set(live.unpricedModels);

  // ── Classify every prompt. A prompt without a session id (very old
  // history lines) falls back to time: covered if it's after the first
  // surviving transcript event. ──
  const isCovered = (p) => (p.sessionId ? transcriptSessionIds.has(p.sessionId) || live.bySession.has(p.sessionId) : p.ms >= liveFirstMs);

  // ── Recovered: stats-cache days strictly before any live data. ──
  const recoveredByDay = new Map(); // UTC date -> Map(model -> { tok, costUsd })
  if (recoveredStats) {
    const priced = priceRecoveredModels(recoveredStats, duplicationByModel, live.usageByModel);
    for (const day of recoveredStats.days) {
      if (liveFirstDay && day.date >= liveFirstDay) continue; // live data is exact from here on
      const byModel = new Map();
      for (const [model, dayTokens] of Object.entries(day.tokensByModel)) {
        const pm = priced.get(model);
        if (!pm || !pm.dayBasis || !dayTokens) continue;
        if (!pm.priced) unpricedModels.add(model);
        const share = dayTokens / pm.dayBasis;
        byModel.set(model, { tok: scaleTok(pm.tok, share), costUsd: (pm.costUsd || 0) * share });
      }
      if (byModel.size) recoveredByDay.set(day.date, byModel);
    }
  }

  const recoveredPromptsByDay = new Map();
  const estimatedPrompts = [];
  for (const p of promptHistory) {
    if (isCovered(p) || reportedPrompts.has(p)) continue;
    const day = utcDay(p.ms);
    if (recoveredByDay.has(day)) {
      if (!recoveredPromptsByDay.has(day)) recoveredPromptsByDay.set(day, []);
      recoveredPromptsByDay.get(day).push(p);
    } else {
      estimatedPrompts.push(p);
    }
  }

  // Recovered entries: each day's total split across that day's uncovered
  // prompts by their expected cost (keeping their real time and project).
  // A day with spend but no uncovered prompt keeps its spend, unattributed.
  let recoveredPromptCount = reportedPrompts.size;
  for (const [day, byModel] of recoveredByDay) {
    const prompts = recoveredPromptsByDay.get(day) || [];
    const slots = prompts.length ? prompts : [{ ms: Date.parse(`${day}T12:00:00Z`), project: 'unattributed' }];
    const weights = slots.map((slot) => (prompts.length ? predictPrompt(slot).reduce((a, r) => a + r.costUsd, 0) : 1));
    const wSum = weights.reduce((a, w) => a + w, 0);
    for (const [model, m] of byModel) {
      slots.forEach((slot, i) => {
        const share = wSum > 0 ? weights[i] / wSum : 1 / slots.length;
        addEntry(rollup, { ms: slot.ms, project: slot.project, model, tier: 'recovered', tok: scaleTok(m.tok, share), costUsd: m.costUsd * share, turns: 0 });
      });
    }
    recoveredPromptCount += prompts.length;
  }

  // Estimated entries: every uncovered prompt at its own predicted cost.
  let promptEstimateCostUsd = 0;
  let promptEstimateTokens = 0;
  for (const p of estimatedPrompts) {
    for (const r of predictPrompt(p)) {
      addEntry(rollup, { ms: p.ms, project: p.project, model: r.model, tier: 'estimated', tok: r.tok, costUsd: r.costUsd, turns: 0 });
      promptEstimateCostUsd += r.costUsd;
      promptEstimateTokens += tokSum(r.tok);
    }
  }

  const fin = finalizeRollup(rollup);

  // ── Full-history project list: every project with a prompt or any spend,
  // its tier split straight from the rollup. ──
  const historyRows = summarizeProjectHistory(promptHistory);
  const covered = new Set(historyRows.map((r) => r.project));
  const stubRows = [...fin.projectTiers.keys()]
    .filter((project) => !covered.has(project))
    .map((project) => ({ project, turns: 0, firstSeen: null, lastSeen: null }));
  const allProjectsHistory = [...historyRows, ...stubRows]
    .map((row) => {
      const t = fin.projectTiers.get(row.project);
      const liveCostUsd = t?.live.costUsd || 0;
      const recoveredCostUsd = t?.recovered.costUsd || 0;
      const estimatedCostUsd = t?.estimated.costUsd || 0;
      return { ...row, liveCostUsd, recoveredCostUsd, estimatedCostUsd, totalCostUsd: liveCostUsd + recoveredCostUsd + estimatedCostUsd };
    })
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  const recoveredDays = [...recoveredByDay.keys()].sort();
  const firstCandidates = [
    Number.isFinite(liveFirstMs) ? liveFirstMs : null,
    recoveredDays.length ? Date.parse(`${recoveredDays[0]}T00:00:00Z`) : null,
    promptHistory.length ? Math.min(...promptHistory.map((p) => p.ms)) : null,
  ].filter((v) => v != null);

  return {
    generatedAt: new Date(rollup.now).toISOString(),
    lastEventAt: live.lastEventAt,
    firstEventAt: firstCandidates.length ? new Date(Math.min(...firstCandidates)).toISOString() : null,
    totals: {
      ...fin.totals,
      sessions: live.sessions,
      unpricedTokens: live.unpricedTokens,
      unpricedModels: [...unpricedModels],
      approxPricedModels: live.approxPricedModels,
    },
    periods: fin.periods,
    charts: fin.charts,
    byProject: fin.byProject,
    byModel: fin.byModel,
    recent: live.recent,
    network: live.network,
    dataSources: {
      liveSince: live.firstEventAt,
      recoveredRange: recoveredDays.length ? [recoveredDays[0], recoveredDays[recoveredDays.length - 1]] : null,
      recoveredTurns: recoveredPromptCount,
      gapTurns: estimatedPrompts.length,
      // Uncovered prompts after live data begins: sessions whose
      // transcripts were deleted while others from that time survived.
      deletedSessionTurns: estimatedPrompts.filter((p) => p.ms >= liveFirstMs).length,
      // How the non-exact parts were derived, for the UI's notes.
      promptEstimate: {
        costUsd: promptEstimateCostUsd,
        tokens: promptEstimateTokens,
        avgCostPerPrompt: estimatedPrompts.length ? promptEstimateCostUsd / estimatedPrompts.length : 0,
        range: promptModel ? promptModel.costRange(estimatedPrompts) : null,
        // Which models each month's estimate is priced as (usage shares).
        pricedAs: promptModel ? modelsByMonth(estimatedPrompts, promptModel) : [],
        model: promptModel?.stats() || null,
      },
      reconciliation: recon.stats,
      reportedSessions: { sessions: reportedSessionCount, prompts: reportedPrompts.size, costUsd: reportedCostUsd },
    },
    allProjectsHistory,
  };
}
