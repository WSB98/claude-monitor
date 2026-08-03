// READ-ONLY BY DESIGN. This module only ever calls readdirSync / statSync /
// readFileSync against ~/.claude/projects — no write, rename, or delete
// function is imported anywhere in this project (grep the repo for
// writeFile/unlink/rm/rename/appendFile — there is nothing to find). Even a
// session file Claude Code is actively appending to right now is safe to
// read here: a concurrent OS-level read can't corrupt the source file, and
// at worst this catches a half-written last line, which the per-line
// JSON.parse below already tolerates by skipping it.
//
// This also never reads message content — only timestamps, token counts,
// model IDs, agent identity, and the project directory name. Nothing
// conversational passes through this tool.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { usageHasTokens } from './usage.js';

const LOG_ROOT = join(homedir(), '.claude', 'projects');

// Real transcripts run a few MB at most. Skip anything wildly larger rather
// than risk blocking the event loop on a giant synchronous read.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// filePath -> { mtimeMs, size, records } — skip re-parsing unchanged files
// (some transcripts run several MB) on every poll.
const fileCache = new Map();
const warnedOversize = new Set();

function listProjectDirs() {
  try {
    return readdirSync(LOG_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(LOG_ROOT, e.name));
  } catch {
    return [];
  }
}

// A session's own transcript lives at <projectDir>/<sessionId>.jsonl. When
// that session delegates to subagents (the Task/Agent tool), each one gets
// its own transcript at <projectDir>/<sessionId>/subagents/agent-*.jsonl,
// plus a agent-*.meta.json sidecar with { agentType, description }. Both
// are scanned so subagent spend and activity are counted, not just the
// main thread.
function listSessionFiles(projectDir) {
  let entries;
  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => ({ path: join(projectDir, e.name), isSubagent: false }));

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const subagentsDir = join(projectDir, e.name, 'subagents');
    let subEntries;
    try {
      subEntries = readdirSync(subagentsDir, { withFileTypes: true });
    } catch {
      continue; // most sessions never spawn a subagent — no directory to find
    }
    for (const sub of subEntries) {
      if (sub.isFile() && sub.name.endsWith('.jsonl')) {
        files.push({ path: join(subagentsDir, sub.name), isSubagent: true });
      }
    }
  }
  return files;
}

export function projectNameFromCwd(cwd) {
  if (!cwd) return 'unknown';
  return basename(cwd.replace(/\\/g, '/'));
}

function readAgentMeta(jsonlFilePath) {
  try {
    const raw = readFileSync(jsonlFilePath.replace(/\.jsonl$/, '.meta.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return { agentType: parsed.agentType || null, agentLabel: parsed.description || null };
  } catch {
    return { agentType: null, agentLabel: null };
  }
}

// Parses one transcript into usage records, plus whether the transcript's
// last real turn is still an open "user" turn — a fresh prompt, or a tool
// result handed back mid-loop — with no assistant reply logged yet. That
// gap is Claude Code actually thinking/generating: it exists in every
// transcript, but was previously invisible here since only completed
// `type: "assistant"` turns carry a `message.usage` block. Subagent lines
// additionally carry `agentId`, which the caller uses to give each running
// subagent its own identity in the activity view instead of collapsing it
// into its parent session.
function parseFile(filePath, isSubagent) {
  const text = readFileSync(filePath, 'utf8');
  const meta = isSubagent ? readAgentMeta(filePath) : null;
  const records = [];
  let lastTurn = null; // most recent type:"user"|"assistant" line with a timestamp, in file order
  let lastModel = null; // most recent assistant model seen — fallback identity for a pending turn that has no reply of its own yet
  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // truncated/malformed line — most likely a file still being written
    }
    if (obj.type === 'assistant' && obj.message?.usage) {
      lastModel = obj.message.model || lastModel;
      // Internal placeholder turns (e.g. model: "<synthetic>") carry zero
      // tokens and aren't real API usage.
      if (usageHasTokens(obj.message.usage)) {
        records.push({
          timestamp: obj.timestamp,
          model: obj.message.model,
          cwd: obj.cwd,
          sessionId: obj.session_id || obj.sessionId,
          agentId: obj.agentId || null,
          agentType: meta?.agentType || null,
          agentLabel: meta?.agentLabel || null,
          usage: obj.message.usage,
        });
      }
    }
    if ((obj.type === 'user' || obj.type === 'assistant') && obj.timestamp) {
      lastTurn = obj;
    }
  }
  // The last real turn being "user" means Claude Code is mid-generation
  // right now with nothing billed yet for it.
  const pending = lastTurn?.type === 'user'
    ? {
        timestamp: lastTurn.timestamp,
        cwd: lastTurn.cwd,
        sessionId: lastTurn.session_id || lastTurn.sessionId,
        agentId: lastTurn.agentId || null,
        agentType: meta?.agentType || null,
        agentLabel: meta?.agentLabel || null,
        model: lastModel,
      }
    : null;
  return { records, pending };
}

function parsedFile(filePath, isSubagent) {
  const stat = statSync(filePath);
  if (stat.size > MAX_FILE_BYTES) {
    if (!warnedOversize.has(filePath)) {
      warnedOversize.add(filePath);
      console.warn(`claude-monitor: skipping oversized log file (${Math.round(stat.size / 1e6)}MB): ${filePath}`);
    }
    return { records: [], pending: null };
  }
  const cached = fileCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached;
  }
  const parsed = parseFile(filePath, isSubagent);
  const entry = { mtimeMs: stat.mtimeMs, size: stat.size, ...parsed };
  fileCache.set(filePath, entry);
  return entry;
}

// A project's display name comes from whichever cwd is found first among
// its main-thread session files, checked before any subagent file — that's
// the cwd that actually determined which project directory Claude Code
// filed everything under, so it's applied to every record and subagent
// found here rather than trusting each one's own possibly-drifted cwd.
// Without this, a subagent (or a mid-session `cd`) that ran one level into
// a subdirectory — e.g. a monorepo's api/ folder — would get silently
// split out into its own fake "project" instead of rolling up into the
// real one.
function resolveProjectDir(projectDir) {
  const files = listSessionFiles(projectDir);
  const ordered = [...files].sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent));
  let projectName = null;
  for (const file of ordered) {
    try {
      const { records, pending } = parsedFile(file.path, file.isSubagent);
      const cwd = records[0]?.cwd || pending?.cwd;
      if (cwd) {
        projectName = projectNameFromCwd(cwd);
        break;
      }
    } catch {
      // file may have been rotated/deleted mid-scan — try the next one
    }
  }
  return { files, projectName: projectName || 'unknown' };
}

// Returns every usage record across every local Claude Code project log,
// main-thread and subagent alike.
export function collectUsageRecords() {
  const all = [];
  for (const projectDir of listProjectDirs()) {
    const { files, projectName } = resolveProjectDir(projectDir);
    for (const file of files) {
      try {
        for (const rec of parsedFile(file.path, file.isSubagent).records) {
          all.push({ ...rec, project: projectName });
        }
      } catch {
        // file may have been rotated/deleted mid-scan — skip it this pass
      }
    }
  }
  return all;
}

// One entry per session/subagent that's currently mid-turn: a prompt or
// tool result has been submitted and no assistant reply is logged yet.
// Lets the activity pulse show a session as active the instant it starts
// working instead of waiting for its first token-bearing reply.
export function collectPendingTurns() {
  const all = [];
  for (const projectDir of listProjectDirs()) {
    const { files, projectName } = resolveProjectDir(projectDir);
    for (const file of files) {
      try {
        const pending = parsedFile(file.path, file.isSubagent).pending;
        if (pending) all.push({ ...pending, project: projectName });
      } catch {
        // file may have been rotated/deleted mid-scan — skip it this pass
      }
    }
  }
  return all;
}

export function logRootExists() {
  try {
    return statSync(LOG_ROOT).isDirectory();
  } catch {
    return false;
  }
}

// Total project directories found under ~/.claude/projects, regardless of
// whether any of them contain real usage — lets the UI show it's genuinely
// scanning everything rather than silently narrowing to one project.
export function scannedProjectCount() {
  return listProjectDirs().length;
}
