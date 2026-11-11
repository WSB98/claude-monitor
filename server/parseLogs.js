// READ-ONLY BY DESIGN. This module only ever calls readdirSync / statSync /
// readFileSync / openSync(path, 'r') + readSync against ~/.claude/projects —
// no write, rename, or delete function is imported anywhere in this project
// (grep the repo for writeFile/unlink/rm/rename/appendFile — there is
// nothing to find). Even a session file Claude Code is actively appending
// to right now is safe to read here: a concurrent OS-level read can't
// corrupt the source file, and at worst this catches a half-written last
// line, which is held back and re-read on the next poll once the rest of
// it has landed.
//
// This also never reads message content — only timestamps, token counts,
// model IDs, agent identity, and the project directory name. Nothing
// conversational passes through this tool.

import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { usageHasTokens, usageBreakdown, usageTotalTokens } from './usage.js';

const LOG_ROOT = join(homedir(), '.claude', 'projects');

// Files are read in slices of this size, so even a transcript of several
// hundred MB never needs one giant buffer or string in memory.
const CHUNK_BYTES = 16 * 1024 * 1024;

// Only lines containing this byte sequence can carry a billed `usage`
// block, so everything else is skipped without being JSON-parsed. That's
// what keeps a full scan of every transcript (oversized ones included)
// fast: the bulk of a transcript is tool output and message text, which
// this never touches. Inside a JSON string the same text would appear
// escaped (\"usage\":), so it can't false-match on content.
const USAGE_NEEDLE = Buffer.from('"usage":');

// Claude Code periodically writes a `cost-state` line into the main
// transcript: its own running per-model token totals for the session,
// counted from the final API responses (thinking included), plus
// background calls that never get a transcript line of their own (e.g.
// small-model helpers) — see reconcile.js for how they're used.
const COST_STATE_NEEDLE = Buffer.from('"cost-state"');

// filePath -> incremental read state (see newFileState).
const fileState = new Map();

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
// every poll reads only what was appended since the last one (Claude Code
// only ever appends to these files).
//
// ONE API RESPONSE IS LOGGED AS SEVERAL LINES. Claude Code writes a
// separate transcript line per content block (thinking, text, each
// tool_use), and every one of them repeats the same `message.id` and the
// full `message.usage` of that response — counting lines instead of
// responses inflates every total by ~2-3x. Lines written while the
// response was still streaming can carry a partial output_tokens count,
// and the odd line carries a zeroed-out usage block. So records are keyed
// by message.id + requestId, and the copy with the most tokens wins (the
// complete one: input and cache counts are identical across copies, only
// output grows).
//
// Per file this also tracks whether the transcript's last real turn is
// still an open "user" turn — a fresh prompt, or a tool result handed back
// mid-loop — with no assistant reply logged yet. That gap is Claude Code
// actually thinking/generating: only completed `type: "assistant"` turns
// carry a `message.usage` block, so it's otherwise invisible. Subagent
// lines additionally carry `agentId`, which the caller uses to give each
// running subagent its own identity in the activity view.
function newFileState(filePath, isSubagent) {
  return {
    // The session this file's spend belongs to: the main transcript's own
    // id, or for a subagent, the parent session whose folder it lives in
    // (subagent lines don't reliably carry the parent's sessionId).
    ownerSessionId: isSubagent ? basename(dirname(dirname(filePath))) : basename(filePath, '.jsonl'),
    isSubagent,
    snapshots: [], // cost-state lines, in file order
    lastRecordTs: null, // latest response timestamp seen so far, in file order
    offset: 0,
    leftover: null, // trailing bytes of a line Claude Code hasn't finished writing yet
    records: new Map(), // responseKey -> record
    rawByModel: new Map(), // model -> token totals summed over every usage line, duplicates included (see collectLogs)
    lastTurn: null, // most recent type:"user"|"assistant" line with a timestamp, in file order
    lastModel: null, // most recent assistant model seen — fallback identity for a pending turn that has no reply of its own yet
    cwd: null,
    meta: isSubagent ? readAgentMeta(filePath) : null,
    filePath,
  };
}

function readRange(fd, start, length) {
  const buf = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, start + read);
    if (n === 0) break;
    read += n;
  }
  return read < length ? buf.subarray(0, read) : buf;
}

function parseJson(buf, start, end) {
  try {
    return JSON.parse(buf.toString('utf8', start, end));
  } catch {
    return null;
  }
}

function responseKey(state, obj, byteOffset) {
  const id = obj.message?.id;
  // Without an id there's nothing to dedupe against — key it by its own
  // position so it's still counted exactly once.
  return id ? `${id}:${obj.requestId || ''}` : `${state.filePath}@${byteOffset}`;
}

function ingestUsageLine(state, obj, byteOffset) {
  if (!state.cwd && obj.cwd) state.cwd = obj.cwd;
  if (obj.type !== 'assistant' || !obj.message?.usage || !obj.timestamp) return;
  state.lastModel = obj.message.model || state.lastModel;
  // Internal placeholder turns (e.g. model: "<synthetic>") carry zero
  // tokens and aren't real API usage.
  if (!usageHasTokens(obj.message.usage)) return;
  addTok(state.rawByModel, obj.message.model || 'unknown', usageBreakdown(obj.message.usage));
  const key = responseKey(state, obj, byteOffset);
  const prev = state.records.get(key);
  if (prev && usageTotalTokens(prev.usage) > usageTotalTokens(obj.message.usage)) return;
  if (!state.lastRecordTs || obj.timestamp > state.lastRecordTs) state.lastRecordTs = obj.timestamp;
  state.records.set(key, {
    key,
    // The response's first line marks when it started.
    timestamp: prev?.timestamp || obj.timestamp,
    model: obj.message.model,
    cwd: obj.cwd,
    sessionId: obj.session_id || obj.sessionId,
    ownerSessionId: state.ownerSessionId,
    isSubagent: state.isSubagent,
    // A response's last line normally carries its stop_reason. Without one,
    // only mid-stream lines were ever written and output_tokens is partial
    // (common in subagent transcripts) — reconcile.js accounts for that.
    complete: obj.message.stop_reason != null,
    agentId: obj.agentId || null,
    agentType: state.meta?.agentType || null,
    agentLabel: state.meta?.agentLabel || null,
    usage: obj.message.usage,
  });
}

function ingestCostState(state, obj) {
  if (!obj.modelUsage || typeof obj.modelUsage !== 'object') return;
  state.snapshots.push({
    ownerSessionId: state.ownerSessionId,
    startMs: Number(obj.startTime) || null,
    // Responses logged before this line are the ones it can account for.
    coversUntil: state.lastRecordTs,
    totalCostUSD: Number(obj.totalCostUSD) || 0,
    modelUsage: obj.modelUsage,
  });
}

function addTok(map, model, t) {
  let into = map.get(model);
  if (!into) map.set(model, (into = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }));
  into.input += t.input;
  into.output += t.output;
  into.cacheWrite += t.cacheWrite;
  into.cacheRead += t.cacheRead;
}

function noteTurn(state, obj) {
  if (!state.cwd && obj.cwd) state.cwd = obj.cwd;
  state.lastTurn = obj.type === 'user'
    ? { type: 'user', timestamp: obj.timestamp, cwd: obj.cwd, sessionId: obj.session_id || obj.sessionId, agentId: obj.agentId || null }
    : { type: 'assistant' };
}

// `body` holds only complete lines (it ends right after a newline).
// `baseOffset` is body's position in the file, for keying id-less records.
function ingestLines(state, body, baseOffset) {
  // Both kinds of interesting line, visited in file order (cost-state
  // snapshots are anchored to the responses logged before them).
  let iUsage = body.indexOf(USAGE_NEEDLE);
  let iCost = state.isSubagent ? -1 : body.indexOf(COST_STATE_NEEDLE);
  while (iUsage !== -1 || iCost !== -1) {
    const i = iUsage === -1 ? iCost : iCost === -1 ? iUsage : Math.min(iUsage, iCost);
    const start = body.lastIndexOf(0x0a, i) + 1;
    let end = body.indexOf(0x0a, i);
    if (end === -1) end = body.length;
    const obj = parseJson(body, start, end);
    if (obj?.type === 'cost-state') ingestCostState(state, obj);
    else if (obj) ingestUsageLine(state, obj, baseOffset + start);
    if (iUsage !== -1 && iUsage < end) iUsage = body.indexOf(USAGE_NEEDLE, end);
    if (iCost !== -1 && iCost < end) iCost = body.indexOf(COST_STATE_NEEDLE, end);
  }

  // Walk back from the end for the last user/assistant turn. Only a few
  // bookkeeping lines (snapshots, system notes) ever trail it, so this
  // parses a handful of lines, not the whole body.
  let end = body.length - 1; // the final newline
  for (let guard = 0; end > 0 && guard < 500; guard++) {
    const start = body.lastIndexOf(0x0a, end - 1) + 1;
    if (end > start) {
      const obj = parseJson(body, start, end);
      if (obj && (obj.type === 'user' || obj.type === 'assistant') && obj.timestamp) {
        noteTurn(state, obj);
        break;
      }
    }
    if (start === 0) break;
    end = start - 1;
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
  if (stat.size <= state.offset) return state;

  const fd = openSync(filePath, 'r');
  try {
    while (state.offset < stat.size) {
      const chunk = readRange(fd, state.offset, Math.min(CHUNK_BYTES, stat.size - state.offset));
      if (!chunk.length) break;
      const leftoverLen = state.leftover?.length || 0;
      const data = leftoverLen ? Buffer.concat([state.leftover, chunk]) : chunk;
      const dataStart = state.offset - leftoverLen; // file position of data[0]
      state.offset += chunk.length;

      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        state.leftover = Buffer.from(data);
        continue;
      }
      ingestLines(state, data.subarray(0, lastNl + 1), dataStart);
      state.leftover = lastNl + 1 < data.length ? Buffer.from(data.subarray(lastNl + 1)) : null;
    }
  } finally {
    closeSync(fd);
  }

  // A final line with no trailing newline is either still being written
  // or simply the last line of a finished file. A truncated JSON object
  // never parses, so if it parses it's complete: take it (as a line with a
  // synthetic newline) and stop holding it.
  if (state.leftover && parseJson(state.leftover, 0, state.leftover.length)) {
    const line = Buffer.concat([state.leftover, Buffer.from('\n')]);
    ingestLines(state, line, state.offset - state.leftover.length);
    state.leftover = null;
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
//  - records: one usage record per billed API response, deduplicated
//    across files too (a resumed or forked session can carry copies of
//    earlier responses into a new transcript).
//  - pendingTurns: one entry per session/subagent that's currently
//    mid-turn (prompt or tool result submitted, no reply logged yet), so
//    the activity pulse lights up the instant a session starts working
//    instead of waiting for its first token-bearing reply.
//  - transcriptSessionIds: every session that still has a main transcript
//    on disk — lets merge.js tell which history.jsonl prompts are already
//    covered by exact data and which belong to deleted sessions.
//  - duplicationByModel: per model and token type, how much of the naive
//    line-by-line sum is real (deduplicated tokens / all-lines tokens).
//    Claude Code's own stats-cache.json sums lines the naive way, so
//    merge.js uses this to correct it.
//  - snapshots: every cost-state line (Claude Code's own running per-model
//    totals for a session), for reconcile.js.
export function collectLogs() {
  const byKey = new Map();
  const rawByModel = new Map();
  const dedupByModel = new Map();
  const snapshots = [];
  const pendingTurns = [];
  const transcriptSessionIds = new Set();
  const seen = new Set();

  for (const projectDir of listProjectDirs()) {
    const tracked = [];
    for (const file of listSessionFiles(projectDir)) {
      try {
        tracked.push({ isSubagent: file.isSubagent, state: trackedFile(file.path, file.isSubagent) });
        seen.add(file.path);
        if (!file.isSubagent) transcriptSessionIds.add(basename(file.path, '.jsonl'));
      } catch {
        // file may have been rotated/deleted mid-scan — skip it this pass
      }
    }
    const project = projectNameFor(tracked);
    // Main transcripts first, so a response copied into a subagent file
    // (or vice versa) keeps its main-thread identity on a tie.
    tracked.sort((a, b) => Number(a.isSubagent) - Number(b.isSubagent));
    for (const { state } of tracked) {
      for (const snap of state.snapshots) snapshots.push({ ...snap, project });
      for (const [model, t] of state.rawByModel) addTok(rawByModel, model, t);
      for (const rec of state.records.values()) {
        addTok(dedupByModel, rec.model || 'unknown', usageBreakdown(rec.usage));
        const prev = byKey.get(rec.key);
        // Copies of one response in two files: keep the most complete one.
        if (prev && usageTotalTokens(prev.usage) >= usageTotalTokens(rec.usage)) continue;
        byKey.set(rec.key, { ...rec, project });
      }
      const pending = pendingOf(state);
      if (pending) pendingTurns.push({ ...pending, project });
    }
  }

  // Forget files that no longer exist so their state doesn't pile up.
  for (const path of fileState.keys()) {
    if (!seen.has(path)) fileState.delete(path);
  }

  const duplicationByModel = new Map();
  for (const [model, raw] of rawByModel) {
    const dd = dedupByModel.get(model);
    const ratio = (k) => (raw[k] ? dd[k] / raw[k] : 1);
    duplicationByModel.set(model, { input: ratio('input'), output: ratio('output'), cacheWrite: ratio('cacheWrite'), cacheRead: ratio('cacheRead') });
  }

  return { records: [...byKey.values()], pendingTurns, transcriptSessionIds, duplicationByModel, snapshots };
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
