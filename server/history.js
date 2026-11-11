// READ-ONLY, same invariant as parseLogs.js — only readFileSync against two
// files Claude Code itself maintains and that survive its own transcript
// cleanup:
//
//  - stats-cache.json: Claude Code's own internal lifetime stats snapshot.
//    Has real per-model token totals, but stops updating at
//    `lastComputedDate` — there can be a real gap between where this
//    stops and where the live scan (parseLogs.js) picks up.
//  - history.jsonl: every prompt ever submitted, with no gap, but no
//    token/cost data — only enough to know a turn happened. Only
//    `timestamp` and `project` are ever read out of each line here; the
//    prompt text itself (`display` / `pastedContents`) is never touched,
//    stored, or forwarded — consistent with this tool never handling
//    conversation content anywhere else.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { costFromBreakdown } from './pricing.js';
import { projectNameFromCwd } from './parseLogs.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const STATS_CACHE_PATH = join(CLAUDE_DIR, 'stats-cache.json');
const HISTORY_PATH = join(CLAUDE_DIR, 'history.jsonl');

function statsCacheModelCost(model, m) {
  return (
    costFromBreakdown(model, {
      input: m.inputTokens || 0,
      output: m.outputTokens || 0,
      // stats-cache doesn't record whether a cache write was 5m or 1h
      // tier — treating it all as 5m (the overwhelmingly common case) is
      // a slight under-estimate rather than an over-estimate.
      cacheWrite5m: m.cacheCreationInputTokens || 0,
      cacheRead: m.cacheReadInputTokens || 0,
    }) || 0
  );
}

// Claude Code's own lifetime aggregate — real token/cost totals for
// whatever window it tracked before it stopped updating.
export function readRecoveredStats() {
  let raw;
  try {
    raw = readFileSync(STATS_CACHE_PATH, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data.modelUsage || !data.dailyModelTokens) return null;

  // Each model's own effective $/token, derived from its real lifetime
  // input/output/cache mix — used below to price dailyModelTokens' per-day
  // per-model counts individually instead of applying one rate blended
  // across every model to every day. blendedRate is only a fallback for a
  // model dailyModelTokens mentions but modelUsage doesn't (shouldn't
  // happen, but keeps a stray model from silently pricing at $0).
  let totalTokens = 0;
  let totalCostUsd = 0;
  const ratePerToken = new Map();
  for (const [model, m] of Object.entries(data.modelUsage)) {
    const tokens = (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadInputTokens || 0) + (m.cacheCreationInputTokens || 0);
    if (tokens === 0) continue;
    const cost = statsCacheModelCost(model, m);
    totalTokens += tokens;
    totalCostUsd += cost;
    ratePerToken.set(model, cost / tokens);
  }
  if (totalTokens === 0) return null;
  const blendedRate = totalCostUsd / totalTokens;

  // dailyModelTokens carries a real day×model join — unlike the lifetime
  // modelUsage total above, which only has a model dimension, not a daily
  // one. Pricing each day through the models that actually ran that day,
  // rather than one blended rate for every day, means a day that skewed
  // toward a pricier model correctly costs more than one with the same
  // token count on a cheaper model.
  const dailyTokens = data.dailyModelTokens
    .map((d) => {
      let tokens = 0;
      let costUsd = 0;
      for (const [model, modelTokens] of Object.entries(d.tokensByModel)) {
        tokens += modelTokens;
        costUsd += modelTokens * (ratePerToken.get(model) ?? blendedRate);
      }
      return { date: d.date, tokens, costUsd };
    })
    .filter((d) => d.tokens > 0);

  return {
    firstSessionDate: data.firstSessionDate || null,
    lastComputedDate: data.lastComputedDate || null,
    dailyTokens,
  };
}

// Every prompt ever submitted — project + timestamp only.
export function readPromptHistory() {
  let raw;
  try {
    raw = readFileSync(HISTORY_PATH, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj.timestamp) continue;
    out.push({ timestamp: new Date(obj.timestamp).toISOString(), project: projectNameFromCwd(obj.project) });
  }
  return out;
}

// Every project ever touched, agnostic of whether ~/.claude/projects still
// has anything for it — this is the one source that survives even after a
// project's own transcripts (and its whole project directory) are gone.
// Turn counts only; there's no token/cost data in history.jsonl to report.
export function summarizeProjectHistory(promptHistory) {
  const byProject = new Map();
  for (const p of promptHistory) {
    const e = byProject.get(p.project) || { project: p.project, turns: 0, firstSeen: p.timestamp, lastSeen: p.timestamp };
    e.turns += 1;
    if (p.timestamp < e.firstSeen) e.firstSeen = p.timestamp;
    if (p.timestamp > e.lastSeen) e.lastSeen = p.timestamp;
    byProject.set(p.project, e);
  }
  return [...byProject.values()].sort((a, b) => b.turns - a.turns);
}
