// Blends Claude Code's own historical records (server/history.js) into the
// live aggregate (server/aggregate.js). Three tiers, in order of
// decreasing confidence — a prompt is classified into exactly one:
//
//  - "live": exact, straight from the JSONL scan (server/parseLogs.js).
//  - "recovered": stats-cache.json's real lifetime token/cost totals for
//    whatever window it tracked before it stopped updating. A real dollar
//    pool that gets *redistributed* — by day (for the monthly chart, using
//    stats-cache's own daily activity weights) and independently by
//    project (using each project's share of prompts in that window, since
//    stats-cache has no project dimension at all). Both redistributions
//    always sum back to the exact recovered total for whatever portion of
//    that window doesn't overlap the live scan — days at/after the live
//    scan's earliest surviving event are excluded from the pool entirely so
//    a transcript that outlives stats-cache's last computation, or a
//    stats-cache recomputed later than a transcript's retention window,
//    never gets counted on both sides.
//  - "estimated": everything else — prompts with no real dollar pool to
//    redistribute at all, because Claude Code had already deleted that
//    usage data before this tool ever ran. Extrapolated from a blended
//    $/prompt and token/prompt rate built from the live+recovered prompts
//    (the only ones with a known cost), applied to however many prompts
//    fall outside both windows. This is the roughest tier — it assumes a
//    typical prompt costs about the same everywhere, which can overstate
//    quick one-off sessions and understate heavy ones — and it's the only
//    tier that can attach a number to projects with zero surviving
//    transcripts and zero overlap with the recovered window (most of the
//    projects in allProjectsHistory fall here).
//
// The same blended rate and the same per-tier totals feed both the overall
// `totals`/`periods.year`/`charts.monthly` numbers and the per-project
// breakdown in `allProjectsHistory`, so the sum across every project always
// reconciles exactly with the top-level totals — nothing is invented in
// one place and left out of the other.

import { summarizeProjectHistory } from './history.js';

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export function mergeHistorical(liveResult, recoveredStats, promptHistory) {
  if (!recoveredStats && !promptHistory?.length) {
    return { ...liveResult, dataSources: emptyDataSources(liveResult), allProjectsHistory: [] };
  }

  const liveFirstMs = liveResult.firstEventAt ? new Date(liveResult.firstEventAt).getTime() : Infinity;
  const nowMs = Date.now();

  const monthly = liveResult.charts.monthly.map((pt) => ({ ...pt }));
  const monthByKey = new Map(monthly.map((pt) => [pt.key, pt]));

  // ── Tier "recovered": redistribute stats-cache.json's exact pool across
  // the days it actually spans, weighted by its own daily token data. ──
  let recoveredTokens = 0;
  let recoveredCostUsd = 0;
  let yearShareRecoveredTokens = 0;
  let yearShareRecoveredCostUsd = 0;

  if (recoveredStats) {
    // recoveredTokens/recoveredCostUsd (used below in `totals`) are built by
    // summing only the surviving (non-overlapping) days in this loop, NOT
    // assigned from recoveredStats.totalTokens/totalCostUsd directly. If
    // stats-cache.json's tracked window runs later than liveFirstMs — it's
    // recomputed periodically and can outlive an individual transcript's
    // retention — the overlap would otherwise be counted once here via the
    // unclipped lifetime total AND again via the live scan's own totals for
    // those same days. Skipping those days (as the chart redistribution
    // below already did) and summing only what's left keeps this in exact
    // reconciliation with what actually lands in the monthly chart.
    for (const day of recoveredStats.dailyTokens) {
      const dayMs = new Date(day.date).getTime();
      if (dayMs >= liveFirstMs) continue; // already covered, more accurately, by the live scan
      const share = day.tokens / recoveredStats.dailyTokenSum;
      const dayCostUsd = recoveredStats.totalCostUsd * share;

      recoveredTokens += day.tokens;
      recoveredCostUsd += dayCostUsd;

      const monthPt = monthByKey.get(day.date.slice(0, 7));
      if (monthPt) {
        monthPt.recovered = (monthPt.recovered || 0) + day.tokens;
        monthPt.costUsd = (monthPt.costUsd || 0) + dayCostUsd;
      }
      if (nowMs - dayMs <= YEAR_MS) {
        yearShareRecoveredTokens += day.tokens;
        yearShareRecoveredCostUsd += dayCostUsd;
      }
    }
  }

  // ── Single pass over promptHistory: classify every prompt into live /
  // recovered / estimated, tallying whatever each tier needs. Recovered
  // only needs per-project counts here (its day-level split already came
  // from stats-cache.json above); estimated needs per-project AND
  // per-month counts, since promptHistory is its only source at all. ──
  const recoveredStartMs = recoveredStats?.firstSessionDate ? new Date(recoveredStats.firstSessionDate).getTime() : null;
  const recoveredEndMs = recoveredStats?.lastComputedDate ? new Date(recoveredStats.lastComputedDate).getTime() : null;

  let liveWindowPromptCount = 0;
  let recoveredWindowPromptCount = 0;
  let estimatedPromptCount = 0;
  let estimatedYearPromptCount = 0;
  const recoveredCountsByProject = new Map();
  const estimatedCountsByProject = new Map();
  const estimatedCountsByMonth = new Map();

  for (const p of promptHistory) {
    const ms = new Date(p.timestamp).getTime();
    if (ms >= liveFirstMs) {
      liveWindowPromptCount += 1;
    } else if (recoveredStartMs != null && ms >= recoveredStartMs && ms < recoveredEndMs) {
      recoveredWindowPromptCount += 1;
      recoveredCountsByProject.set(p.project, (recoveredCountsByProject.get(p.project) || 0) + 1);
    } else {
      estimatedPromptCount += 1;
      estimatedCountsByProject.set(p.project, (estimatedCountsByProject.get(p.project) || 0) + 1);
      const monthKey = p.timestamp.slice(0, 7);
      estimatedCountsByMonth.set(monthKey, (estimatedCountsByMonth.get(monthKey) || 0) + 1);
      if (nowMs - ms <= YEAR_MS) estimatedYearPromptCount += 1;
    }
  }

  // ── Tier "estimated": blended rate, applied to whatever fell outside
  // both real windows above. ──
  const knownCostUsd = (liveResult.totals.costUsd || 0) + recoveredCostUsd;
  const knownTokens = (liveResult.totals.tokens || 0) + recoveredTokens;
  const knownPromptCount = liveWindowPromptCount + recoveredWindowPromptCount;
  const avgCostPerPrompt = knownPromptCount > 0 ? knownCostUsd / knownPromptCount : 0;
  const avgTokensPerPrompt = knownPromptCount > 0 ? knownTokens / knownPromptCount : 0;

  const estimatedTokens = estimatedPromptCount * avgTokensPerPrompt;
  const estimatedCostUsd = estimatedPromptCount * avgCostPerPrompt;
  const yearShareEstimatedTokens = estimatedYearPromptCount * avgTokensPerPrompt;
  const yearShareEstimatedCostUsd = estimatedYearPromptCount * avgCostPerPrompt;

  for (const [monthKey, count] of estimatedCountsByMonth) {
    const pt = monthByKey.get(monthKey);
    if (!pt) continue;
    pt.estimated = (pt.estimated || 0) + count * avgTokensPerPrompt;
    pt.costUsd = (pt.costUsd || 0) + count * avgCostPerPrompt;
    pt.gapTurns = (pt.gapTurns || 0) + count;
  }

  let gapRange = null;
  if (recoveredEndMs != null && liveFirstMs !== Infinity && liveFirstMs > recoveredEndMs) {
    gapRange = [recoveredStats.lastComputedDate, liveResult.firstEventAt];
  }

  const candidateFirsts = [liveResult.firstEventAt, recoveredStats?.firstSessionDate, earliest(promptHistory)].filter(Boolean);
  const firstEventAt = candidateFirsts.length
    ? new Date(Math.min(...candidateFirsts.map((d) => new Date(d).getTime()))).toISOString()
    : liveResult.firstEventAt;

  // ── Per-project totals — same rate, same pools as above, so the sum
  // across every project reconciles exactly with the totals below. ──
  const liveCostByProject = new Map(liveResult.byProject.map((p) => [p.project, p.costUsd]));
  const allProjects = new Set([...liveCostByProject.keys(), ...recoveredCountsByProject.keys(), ...estimatedCountsByProject.keys()]);
  const projectCosts = new Map();
  for (const project of allProjects) {
    const liveCostUsd = liveCostByProject.get(project) || 0;
    const recoveredShare = recoveredWindowPromptCount > 0 ? (recoveredCountsByProject.get(project) || 0) / recoveredWindowPromptCount : 0;
    const projRecoveredCostUsd = recoveredShare * recoveredCostUsd;
    const projEstimatedCostUsd = (estimatedCountsByProject.get(project) || 0) * avgCostPerPrompt;
    projectCosts.set(project, {
      liveCostUsd,
      recoveredCostUsd: projRecoveredCostUsd,
      estimatedCostUsd: projEstimatedCostUsd,
      totalCostUsd: liveCostUsd + projRecoveredCostUsd + projEstimatedCostUsd,
    });
  }

  // A project can have live cost with zero history.jsonl entries (e.g. a
  // cwd that only ever showed up mid-session, never as a prompt's own
  // project) — summarizeProjectHistory alone would silently drop it and
  // break the reconciliation with totals above, so any such project gets
  // a stub row here instead.
  const historyRows = summarizeProjectHistory(promptHistory);
  const coveredProjects = new Set(historyRows.map((r) => r.project));
  const liveOnlyRows = [...liveCostByProject.keys()]
    .filter((project) => !coveredProjects.has(project))
    .map((project) => ({ project, turns: 0, firstSeen: null, lastSeen: null }));

  const allProjectsHistory = [...historyRows, ...liveOnlyRows]
    .map((row) => ({
      ...row,
      ...(projectCosts.get(row.project) || { liveCostUsd: 0, recoveredCostUsd: 0, estimatedCostUsd: 0, totalCostUsd: 0 }),
    }))
    .sort((a, b) => b.totalCostUsd - a.totalCostUsd);

  return {
    ...liveResult,
    firstEventAt,
    totals: {
      ...liveResult.totals,
      liveTokens: liveResult.totals.tokens,
      liveCostUsd: liveResult.totals.costUsd,
      recoveredTokens,
      recoveredCostUsd,
      estimatedTokens,
      estimatedCostUsd,
      tokens: liveResult.totals.tokens + recoveredTokens + estimatedTokens,
      costUsd: liveResult.totals.costUsd + recoveredCostUsd + estimatedCostUsd,
    },
    periods: {
      ...liveResult.periods,
      year: {
        ...liveResult.periods.year,
        tokens: liveResult.periods.year.tokens + yearShareRecoveredTokens + yearShareEstimatedTokens,
        costUsd: liveResult.periods.year.costUsd + yearShareRecoveredCostUsd + yearShareEstimatedCostUsd,
      },
    },
    charts: { ...liveResult.charts, monthly },
    dataSources: {
      liveSince: liveResult.firstEventAt,
      recoveredRange: recoveredStats ? [recoveredStats.firstSessionDate, recoveredStats.lastComputedDate] : null,
      gapRange,
      gapTurns: estimatedPromptCount,
    },
    allProjectsHistory,
  };
}

function earliest(promptHistory) {
  if (!promptHistory?.length) return null;
  return promptHistory.reduce((min, p) => (p.timestamp < min ? p.timestamp : min), promptHistory[0].timestamp);
}

function emptyDataSources(liveResult) {
  return { liveSince: liveResult.firstEventAt, recoveredRange: null, gapRange: null, gapTurns: 0 };
}
