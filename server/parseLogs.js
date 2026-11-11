// READ-ONLY BY DESIGN. This module only ever calls readdirSync / statSync /
// readFileSync / openSync(path, 'r') + readSync against ~/.claude/projects —
// no write, rename, or delete function is imported anywhere in this project
// (grep the repo for writeFile/unlink/rm/rename/appendFile — there is
// nothing to find). Even a session file Claude Code is actively appending
// to right now is safe to read here: a concurrent OS-level read can't
// corrupt the source file, and at worst this catches a half-written last
// line, which is held back and re-tried on the next poll once the rest of
// it has landed.
//
// This also never reads message content — only timestamps, token counts,
// model IDs, agent identity, and the project directory name. Nothing
// conversational passes through this tool.

import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { usageHasTokens } from './usage.js';

const LOG_ROOT = join(homedir(), '.claude', 'projects');

// Most transcripts run a few MB, but long-lived sessions can grow past
// 100MB. Anything over this limit isn't read whole (that would block the
// event loop and balloon memory); it's followed from its tail instead, as a
// "live-only" file: its recent turns still drive the activity pulse, the
// live feed and the thinking indicator, but it's left out of every
// token/cost total since only a slice of its history was ever read.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

// How far back from the end a live-only file is read when first seen (or
// after falling far behind). Comfortably covers the last several minutes
// of even a busy session, including the occasional multi-MB tool result.
const TAIL_BYTES = 8 * 1024 * 1024;

// Live-only records are kept just long enough to feed the pulse's 5-minute
// warm window and the recent-turns feed, then dropped.
const LIVE_ONLY_RETAIN_MS = 30 * 60 * 1000;

// filePath -> incremental read state (see newFileState).
const fileState = new Map();
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

// Transcripts are read incrementally: each file keeps a byte offset, and
// every poll reads only what was appended since the last one. Claude Code
// only ever appends to these files, so this both avoids re-parsing a
// multi-MB transcript every few seconds and lets an oversized file be
// followed from its tail instead of being skipped outright.
//
// Per file it tracks the usage records parsed so far, plus whether the
// transcript's last real turn is still an open "user" turn — a fresh
// prompt, or a tool result handed back mid-loop — with no assistant reply
// logged yet. That gap is Claude Code actually thinking/generating: it
// exists in every transcript, but is otherwise invisible here since only
// completed `type: "assistant"` turns carry a `message.usage` block.
// Subagent lines additionally carry `agentId`, which the caller uses to give
// each running subagent its own identity in the activity view instead of
// collapsing it into its parent session.
function newFileState(filePath, isSubagent) {
  return {
    offset: 0,
    skipPartial: false, // discard bytes up to the next newline before parsing (set after jumping into the middle of a file)
    leftover: null, // trailing bytes of a line Claude Code hasn't finished writing yet
    records: [],
    lastTurn: null, // most recent type:"user"|"assistant" line with a timestamp, in file order
    lastModel: null, // most recent assistant model seen — fallback identity for a pending turn that has no reply of its own yet
    cwd: null,
    liveOnly: false,
    meta: isSubagent ? readAgentMeta(filePath) : null,
  };
}

function readRange(filePath, start, end) {
  const length = end - start;
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, 'r');
  try {
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return read < length ? buf.subarray(0, read) : buf;
  } finally {
    closeSync(fd);
  }
}

// Returns false for a line that isn't (yet) valid JSON.
function ingestLine(state, line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return false;
  }
  if (!state.cwd && obj.cwd) state.cwd = obj.cwd;
  if (obj.type === 'assistant' && obj.message?.usage) {
    state.lastModel = obj.message.model || state.lastModel;
    // Internal placeholder turns (e.g. model: "<synthetic>") carry zero
    // tokens and aren't real API usage.
    if (usageHasTokens(obj.message.usage)) {
      state.records.push({
        timestamp: obj.timestamp,
        model: obj.message.model,
        cwd: obj.cwd,
        sessionId: obj.session_id || obj.sessionId,
        agentId: obj.agentId || null,
        agentType: state.meta?.agentType || null,
        agentLabel: state.meta?.agentLabel || null,
        usage: obj.message.usage,
      });
    }
  }
  if ((obj.type === 'user' || obj.type === 'assistant') && obj.timestamp) {
    state.lastTurn = obj.type === 'user'
      ? { type: 'user', timestamp: obj.timestamp, cwd: obj.cwd, sessionId: obj.session_id || obj.sessionId, agentId: obj.agentId || null }
      : { type: 'assistant' };
  }
  return true;
}

function ingestBytes(state, chunk) {
  const data = state.leftover ? Buffer.concat([state.leftover, chunk]) : chunk;
  state.leftover = null;
  let pos = 0;
  if (state.skipPartial) {
    const nl = data.indexOf(0x0a);
    if (nl === -1) return; // still inside the line we jumped into
    state.skipPartial = false;
    pos = nl + 1;
  }
  let nl;
  while ((nl = data.indexOf(0x0a, pos)) !== -1) {
    if (nl > pos) ingestLine(state, data.toString('utf8', pos, nl));
    pos = nl + 1;
  }
  if (pos < data.length) {
    // Either a line still being written, or a final line with no trailing
    // newline. A truncated JSON object never parses, so try it and hold the
    // bytes for the next poll if it doesn't.
    if (!ingestLine(state, data.toString('utf8', pos))) {
      state.leftover = Buffer.from(data.subarray(pos));
    }
  }
}

function pendingOf(state) {
  const t = state.lastTurn;
  // The last real turn being "user" means Claude Code is mid-generation
  // right now with nothing billed yet for it.
  if (t?.type !== 'user') return null;
  return {
    timestamp: t.timestamp,
    cwd: t.cwd,
    sessionId: t.sessionId,
    agentId: t.agentId,
    agentType: state.meta?.agentType || null,
    agentLabel: state.meta?.agentLabel || null,
    model: state.lastModel,
  };
}

// Brings one file's state up to date with whatever was appended since the
// last poll, and returns it.
function trackedFile(filePath, isSubagent) {
  const stat = statSync(filePath);
  let state = fileState.get(filePath);
  if (state && stat.size < state.offset) state = null; // truncated or replaced — start over
  if (!state) {
    state = newFileState(filePath, isSubagent);
    fileState.set(filePath, state);
  }

  if (!state.liveOnly && stat.size > MAX_FILE_BYTES) {
    // Too big to read whole — follow it from the tail instead. Anything
    // already parsed (a file that grew past the limit while being watched)
    // is demoted to live-only too, so a transcript's treatment doesn't
    // depend on whether the server happened to be running when it crossed.
    state.liveOnly = true;
    if (state.offset === 0 && Date.now() - stat.mtimeMs > LIVE_ONLY_RETAIN_MS) {
      // Idle oversized file: nothing in it is recent enough to show, so
      // don't read any of it — just start watching from the end.
      state.offset = stat.size - 1;
      state.skipPartial = true;
    }
    if (!warnedOversize.has(filePath)) {
      warnedOversize.add(filePath);
      console.warn(`claude-monitor: oversized log file (${Math.round(stat.size / 1e6)}MB), tracking live activity only (excluded from totals): ${filePath}`);
    }
  }

  if (state.liveOnly && stat.size - state.offset > TAIL_BYTES) {
    // Jump straight to the tail: only recent turns matter for a live-only
    // file, and this bounds the read no matter how far behind it is.
    state.offset = stat.size - TAIL_BYTES - 1;
    state.skipPartial = true;
    state.leftover = null;
  }

  if (stat.size > state.offset) {
    ingestBytes(state, readRange(filePath, state.offset, stat.size));
    state.offset = stat.size;
  }

  if (state.liveOnly) {
    const cutoff = Date.now() - LIVE_ONLY_RETAIN_MS;
    state.records = state.records.filter((r) => new Date(r.timestamp).getTime() >= cutoff);
  }
  return state;
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
function projectNameFor(tracked) {
  const ordered = [...tracked].sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent));
  const cwd = ordered.find((t) => t.state.cwd)?.state.cwd;
  return cwd ? projectNameFromCwd(cwd) : 'unknown';
}

// One pass over every local Claude Code project log, main-thread and
// subagent alike. Returns:
//  - records: every usage record. Ones from oversized files carry
//    `liveOnly: true` — aggregate.js uses them for live activity only.
//  - pendingTurns: one entry per session/subagent that's currently
//    mid-turn (prompt or tool result submitted, no reply logged yet), so
//    the activity pulse lights up the instant a session starts working
//    instead of waiting for its first token-bearing reply.
//  - liveOnlyFiles: how many transcripts are being tailed rather than
//    fully counted, so the UI can say so.
export function collectLogs() {
  const records = [];
  const pendingTurns = [];
  const seen = new Set();
  let liveOnlyFiles = 0;

  for (const projectDir of listProjectDirs()) {
    const tracked = [];
    for (const file of listSessionFiles(projectDir)) {
      try {
        tracked.push({ isSubagent: file.isSubagent, state: trackedFile(file.path, file.isSubagent) });
        seen.add(file.path);
      } catch {
        // file may have been rotated/deleted mid-scan — skip it this pass
      }
    }
    const project = projectNameFor(tracked);
    for (const { state } of tracked) {
      if (state.liveOnly) liveOnlyFiles += 1;
      for (const rec of state.records) {
        records.push({ ...rec, project, liveOnly: state.liveOnly });
      }
      const pending = pendingOf(state);
      if (pending) pendingTurns.push({ ...pending, project, liveOnly: state.liveOnly });
    }
  }

  // Forget files that no longer exist so their state doesn't pile up.
  for (const path of fileState.keys()) {
    if (!seen.has(path)) fileState.delete(path);
  }

  return { records, pendingTurns, liveOnlyFiles };
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
