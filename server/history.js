// READ-ONLY, same invariant as parseLogs.js — only readFileSync against
// files Claude Code itself maintains and that survive its own transcript
// cleanup:
//
//  - ~/.claude.json (and Claude Code's own backups of it): per project, the
//    id and per-model token usage of the last session run there. Only
//    `projects[*].lastSessionId` and `projects[*].lastModelUsage` are read;
//    nothing else in that file (account details, settings) is touched.
//  - stats-cache.json: Claude Code's own internal lifetime stats snapshot.
//    Has real per-model token totals, but stops updating at
//    `lastComputedDate` — there can be a real gap between where this
//    stops and where the live scan (parseLogs.js) picks up.
//  - history.jsonl: every prompt ever submitted, with no gap, but no
//    token/cost data — only enough to know a turn happened. Only
//    `timestamp`, `project` and `sessionId` are ever read out of each line; the
//    prompt text itself (`display` / `pastedContents`) is never touched,
//    stored, or forwarded — consistent with this tool never handling
//    conversation content anywhere else.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { projectNameFromCwd } from './parseLogs.js';

const CLAUDE_DIR = join(homedir(), '.claude');
const STATS_CACHE_PATH = join(CLAUDE_DIR, 'stats-cache.json');
const HISTORY_PATH = join(CLAUDE_DIR, 'history.jsonl');

// Claude Code's own aggregate, as-is. Two things about it matter for
// pricing it (done in merge.js):
//  - `modelUsage` covers exactly the days listed in `dailyModelTokens` (the
//    daily input+output sums add up to modelUsage's input+output), and
//    those daily figures are input + output only, no cache tokens.
//  - Its days are UTC dates, and its sums count every transcript line —
//    the same per-content-block duplication parseLogs.js removes.
export function readRecoveredStats() {
  let data;
  try {
    data = JSON.parse(readFileSync(STATS_CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }
  if (!data?.modelUsage || !Array.isArray(data.dailyModelTokens)) return null;

  const models = {};
  for (const [model, m] of Object.entries(data.modelUsage)) {
    const t = {
      input: m.inputTokens || 0,
      output: m.outputTokens || 0,
      cacheWrite: m.cacheCreationInputTokens || 0,
      cacheRead: m.cacheReadInputTokens || 0,
      webSearches: m.webSearchRequests || 0,
    };
    if (t.input + t.output + t.cacheWrite + t.cacheRead > 0) models[model] = t;
  }
  const days = data.dailyModelTokens
    .filter((d) => d?.date && d.tokensByModel)
    .map((d) => ({ date: d.date, tokensByModel: d.tokensByModel }));
  if (!Object.keys(models).length || !days.length) return null;

  return {
    firstSessionDate: data.firstSessionDate || null,
    lastComputedDate: data.lastComputedDate || null,
    models,
    days,
  };
}

// Claude Code's own record of the last session in each project: its id and
// per-model token totals (counted from the final API responses). For a
// session whose transcript has since been deleted, this is the only exact
// usage left. Backups of the file can hold an older "last session" for a
// project, so they're read too; a session seen more than once keeps its
// largest record (the usage only grows).
export function readReportedSessions() {
  const paths = [join(homedir(), '.claude.json')];
  try {
    for (const f of readdirSync(join(CLAUDE_DIR, 'backups'))) if (f.startsWith('.claude.json')) paths.push(join(CLAUDE_DIR, 'backups', f));
  } catch {
    // no backups folder
  }
  const bySession = new Map();
  for (const path of paths) {
    let projects;
    try {
      projects = JSON.parse(readFileSync(path, 'utf8')).projects;
    } catch {
      continue;
    }
    for (const [projectPath, v] of Object.entries(projects || {})) {
      const usage = v?.lastModelUsage;
      if (!v?.lastSessionId || !usage || typeof usage !== 'object' || !Object.keys(usage).length) continue;
      const models = {};
      let tokens = 0;
      for (const [model, u] of Object.entries(usage)) {
        const t = {
          input: u.inputTokens || 0,
          output: u.outputTokens || 0,
          cacheWrite: u.cacheCreationInputTokens || 0,
          cacheRead: u.cacheReadInputTokens || 0,
          webSearches: u.webSearchRequests || 0,
        };
        models[model] = t;
        tokens += t.input + t.output + t.cacheWrite + t.cacheRead;
      }
      const prev = bySession.get(v.lastSessionId);
      if (prev && prev.tokens >= tokens) continue;
      bySession.set(v.lastSessionId, { sessionId: v.lastSessionId, project: projectNameFromCwd(projectPath), models, tokens });
    }
  }
  return [...bySession.values()];
}

// Every prompt ever submitted — project, timestamp and session id only.
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
    const ms = typeof obj.timestamp === 'number' ? obj.timestamp : Date.parse(obj.timestamp);
    if (!Number.isFinite(ms)) continue;
    out.push({ ms, timestamp: new Date(ms).toISOString(), project: projectNameFromCwd(obj.project), sessionId: obj.sessionId || null });
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
