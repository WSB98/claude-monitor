// Blends Claude Code's own historical records (server/history.js) into the
// live aggregate (server/aggregate.js). Three tiers, in order of
// decreasing confidence — a prompt is classified into exactly one:
//
//  - "live": exact, straight from the JSONL scan (server/parseLogs.js).
//  - "recovered": stats-cache.json's real day×model token counts
//    (server/history.js), each priced through that model's own real
//    lifetime rate — a real dollar figure per day, not a window-wide
//    blend. Split across projects using THAT day's real prompt mix from
//    history.jsonl (a day-level join), falling back to the whole
//    recovered window's project mix only for a day stats-cache has data
//    for but history.jsonl doesn't (the two files can have different
//    retention). Days at/after the live scan's earliest surviving event
//    are excluded entirely so a transcript that outlives stats-cache's
//    last computation, or a stats-cache recomputed later than a
//    transcript's retention window, never gets counted on both sides.
//  - "estimated": everything else — prompts with no real dollar pool to
//    draw from at all, because Claude Code had already deleted that usage
//    data before this tool ever ran. Priced per-project using that
//    project's OWN blended $/prompt rate from its live+recovered history
//    when it has any, falling back to a global blended rate (built from
//    every live+recovered prompt) only for a project with zero known cost
//    anywhere. Still the roughest tier — it assumes a typical prompt in
//    that project cost about the same throughout — but it no longer
//    assumes every project's prompts cost the same as every other
//    project's, the way a single global rate would.
//
// The same per-tier totals feed both the overall
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

  // ── Single pass over promptHistory: classify every prompt into live /
  // recovered / estimated, tallying whatever each tier needs, PLUS a
  // day-level project breakdown (independent of tier) used below to split
  // each recovered day's real dollar figure by project. ──
  const recoveredStartMs = recoveredStats?.firstSessionDate ? new Date(recoveredStats.firstSessionDate).getTime() : null;
  const recoveredEndMs = recoveredStats?.lastComputedDate ? new Date(recoveredStats.lastComputedDate).getTime() : null;

  let liveWindowPromptCount = 0;
  let recoveredWindowPromptCount = 0;
  let estimatedPromptCount = 0;
  let estimatedYearPromptCount = 0;
  const liveCountsByProject = new Map();
  const recoveredCountsByProject = new Map();
  const estimatedCountsByProject = new Map();
  const estimatedCountsByMonth = new Map();
  const promptCountByDay = new Map(); // dayKey -> total prompts that day, any project
  const projectCountsByDay = new Map(); // dayKey -> Map(project -> count)

  for (const p of promptHistory) {
    const ms = new Date(p.timestamp).getTime();
    const dayKey = p.timestamp.slice(0, 10);
    promptCountByDay.set(dayKey, (promptCountByDay.get(dayKey) || 0) + 1);
    const dayProjects = projectCountsByDay.get(dayKey) || new Map();
    dayProjects.set(p.project, (dayProjects.get(p.project) || 0) + 1);
    projectCountsByDay.set(dayKey, dayProjects);

    if (ms >= liveFirstMs) {
      liveWindowPromptCount += 1;
      liveCountsByProject.set(p.project, (liveCountsByProject.get(p.project) || 0) + 1);
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

  // ── Tier "recovered": stats-cache.json's real per-day cost (already
  // priced per-model in server/history.js) redistributed across projects
  // using that same day's real prompt mix. ──
  let recoveredTokens = 0;
  let recoveredCostUsd = 0;
  let yearShareRecoveredTokens = 0;
  let yearShareRecoveredCostUsd = 0;
  const recoveredCostByProject = new Map();

  if (recoveredStats) {
    for (const day of recoveredStats.dailyTokens) {
      const dayMs = new Date(day.date).getTime();
      if (dayMs >= liveFirstMs) continue; // already covered, more accurately, by the live scan

      recoveredTokens += day.tokens;
      recoveredCostUsd += day.costUsd;

      const monthPt = monthByKey.get(day.date.slice(0, 7));
      if (monthPt) {
        monthPt.recovered = (monthPt.recovered || 0) + day.tokens;
        monthPt.costUsd = (monthPt.costUsd || 0) + day.costUsd;
      }
      if (nowMs - dayMs <= YEAR_MS) {
        yearShareRecoveredTokens += day.tokens;
        yearShareRecoveredCostUsd += day.costUsd;
      }

      const dayProjects = projectCountsByDay.get(day.date);
      const dayPromptTotal = promptCountByDay.get(day.date) || 0;
      if (dayProjects && dayPromptTotal > 0) {
        for (const [project, count] of dayProjects) {
          recoveredCostByProject.set(project, (recoveredCostByProject.get(project) || 0) + day.costUsd * (count / dayPromptTotal));
        }
      } else if (recoveredWindowPromptCount > 0) {
        // history.jsonl has nothing for this specific day (retention gap
        // between the two files) — fall back to each project's share of
        // the whole recovered window instead of dropping the day's dollars.
        for (const [project, count] of recoveredCountsByProject) {
          recoveredCostByProject.set(project, (recoveredCostByProject.get(project) || 0) + day.costUsd * (count / recoveredWindowPromptCount));
        }
      }
    }
  }

  // ── Tier "estimated": blended rate (per-project below, globally here as
  // its fallback), applied to whatever fell outside both real windows. ──
  const knownCostUsd = (liveResult.totals.costUsd || 0) + recoveredCostUsd;
  const knownTokens = (liveResult.totals.tokens || 0) + recoveredTokens;
  const knownPromptCount = liveWindowPromptCount + recoveredWindowPromptCount;
  const avgCostPerPrompt = knownPromptCount > 0 ? knownCostUsd / knownPromptCount : 0;
  const avgTokensPerPrompt = knownPromptCount > 0 ? knownTokens / knownPromptCount : 0;

  // estimatedCostUsd itself is NOT `estimatedPromptCount * avgCostPerPrompt`
  // here — it's accumulated below from each project's own rate, so the
  // global total is the literal sum of the per-project figures rather than
  // two independently-computed numbers that could disagree. estimatedTokens
  // stays global-rate-based since no per-project token breakdown is ever
  // surfaced for it to need to reconcile against.
  const estimatedTokens = estimatedPromptCount * avgTokensPerPrompt;
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

  // ── Per-project totals — same tiers, same pools as above, so the sum
  // across every project reconciles exactly with the totals below. ──
  const liveCostByProject = new Map(liveResult.byProject.map((p) => [p.project, p.costUsd]));
  const allProjects = new Set([...liveCostByProject.keys(), ...recoveredCountsByProject.keys(), ...estimatedCountsByProject.keys()]);
  const projectCosts = new Map();
  let estimatedCostUsd = 0;
  for (const project of allProjects) {
    const liveCostUsd = liveCostByProject.get(project) || 0;
    const projRecoveredCostUsd = recoveredCostByProject.get(project) || 0;

    // A project's own blended $/prompt from its real (live+recovered)
    // history — falls back to the global blend only when this project has
    // no known cost anywhere, so one project's typical prompt cost never
    // gets assumed for another's.
    const projKnownCostUsd = liveCostUsd + projRecoveredCostUsd;
    const projKnownPromptCount = (liveCountsByProject.get(project) || 0) + (recoveredCountsByProject.get(project) || 0);
    const projAvgCostPerPrompt = projKnownPromptCount > 0 ? projKnownCostUsd / projKnownPromptCount : avgCostPerPrompt;
    const projEstimatedCostUsd = (estimatedCountsByProject.get(project) || 0) * projAvgCostPerPrompt;
    estimatedCostUsd += projEstimatedCostUsd;

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
