// Fills in spend that real API usage incurred but transcripts don't show.
//
// Transcripts are the only per-response record of usage, but they miss
// some of it:
//  - A response's final usage arrives at the end of its stream. If its
//    final line was never written (common in subagent transcripts), only a
//    mid-stream line survives, with a partial output_tokens count — and
//    some subagent responses get no line at all.
//  - Background calls (session titles, small-model helpers, summaries)
//    never get a transcript line.
// Claude Code's own `cost-state` lines (see parseLogs.js) hold its running
// per-model token totals for a session, counted from the final responses
// themselves. Where transcripts agree with them they agree exactly, which
// is what makes them usable as ground truth here.
//
// Two layers:
//  1. Reported (exact amounts): for every window a cost-state snapshot
//     covers, whatever its totals exceed the transcript by — per model and
//     token type — is added back. A shortfall in output goes to the
//     responses that were never completed; anything else is spread over
//     the window's responses in proportion to their own usage, so it lands
//     on the right days and projects. Models with no transcript lines at
//     all (background calls) are spread evenly over the window. Where the
//     transcript shows more than a snapshot, the transcript stands —
//     every one of those responses is individually logged.
//  2. Modeled (estimated): responses no snapshot covers (older Claude Code
//     versions, or earlier runs of a session) get the shortfall the
//     reported layer measured, as a rate fitted on this machine's own
//     sessions: tokens per response plus tokens per incomplete response,
//     by token type, plus background spend per response.

import { usageBreakdown, cacheSplit } from './usage.js';
import { costFromBreakdown } from './pricing.js';

const KINDS = ['input', 'output', 'cacheWrite', 'cacheRead'];
const normModel = (m) => String(m || 'unknown').replace(/\[[^\]]*\]$/, ''); // "claude-opus-4-7[1m]" -> "claude-opus-4-7"
const emptyTok = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const tokSum = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

function stateTok(u) {
  return {
    input: u.inputTokens || 0,
    output: u.outputTokens || 0,
    cacheWrite: u.cacheCreationInputTokens || 0,
    cacheRead: u.cacheReadInputTokens || 0,
  };
}

function priceTok(model, tok, share1h) {
  return (
    costFromBreakdown(model, {
      input: tok.input,
      output: tok.output,
      cacheRead: tok.cacheRead,
      cacheWrite5m: tok.cacheWrite * (1 - share1h),
      cacheWrite1h: tok.cacheWrite * share1h,
      perRequest: false,
    }) || 0
  );
}

function share1hOf(recs) {
  let w5 = 0;
  let w1 = 0;
  for (const r of recs) {
    const s = cacheSplit(r.usage);
    w5 += s.write5m;
    w1 += s.write1h;
  }
  return w5 + w1 > 0 ? w1 / (w5 + w1) : 0;
}

// Spreads `amount` over `recs` by `weightOf`, falling back to equal shares.
function spread(recs, amount, weightOf, onPiece) {
  if (!recs.length || amount <= 0) return;
  let total = 0;
  for (const r of recs) total += weightOf(r);
  for (const r of recs) onPiece(r, total > 0 ? (amount * weightOf(r)) / total : amount / recs.length);
}

// Least squares y ≈ a·x1 + b·x2 with a, b >= 0 (two regressors, no
// intercept): the unconstrained fit, else the better single-regressor fit.
function fitNonNegative(rows) {
  let s11 = 0, s12 = 0, s22 = 0, s1y = 0, s2y = 0, syy = 0;
  for (const { x1, x2, y } of rows) {
    s11 += x1 * x1; s12 += x1 * x2; s22 += x2 * x2; s1y += x1 * y; s2y += x2 * y; syy += y * y;
  }
  const det = s11 * s22 - s12 * s12;
  if (det > 0) {
    const a = (s1y * s22 - s2y * s12) / det;
    const b = (s2y * s11 - s1y * s12) / det;
    if (a >= 0 && b >= 0) return { a, b };
  }
  const a1 = s11 > 0 ? Math.max(0, s1y / s11) : 0;
  const b2 = s22 > 0 ? Math.max(0, s2y / s22) : 0;
  const sse1 = syy - 2 * a1 * s1y + a1 * a1 * s11;
  const sse2 = syy - 2 * b2 * s2y + b2 * b2 * s22;
  return sse1 <= sse2 ? { a: a1, b: 0 } : { a: 0, b: b2 };
}

export function reconcile(records, snapshots) {
  const bySession = new Map();
  for (const r of records) {
    const sid = r.ownerSessionId || r.sessionId;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push({ ...r, ms: Date.parse(r.timestamp) });
  }

  // Snapshots are cumulative from their startTime. Snapshots sharing one
  // startTime came from the same run, which may have spanned more than one
  // session id — they're reconciled as one unit so no spend is added twice.
  const runs = new Map();
  for (const s of snapshots) {
    if (!s.startMs || !s.coversUntil || !(s.totalCostUSD > 0)) continue;
    let run = runs.get(s.startMs);
    if (!run) runs.set(s.startMs, (run = { sessions: new Set(), best: null }));
    run.sessions.add(s.ownerSessionId);
    if (!run.best || s.totalCostUSD > run.best.totalCostUSD || (s.totalCostUSD === run.best.totalCostUSD && s.coversUntil > run.best.coversUntil)) run.best = s;
  }

  const entries = [];
  const covered = new Set();
  const learn = []; // per run: { n, incomplete, gap: tok, bg: tok, bgModel }
  const bgByModel = new Map(); // background model -> tokens, to price the modeled background rate
  let reportedCostUsd = 0;

  for (const [startMs, run] of runs) {
    const untilMs = Date.parse(run.best.coversUntil);
    const win = [];
    for (const sid of run.sessions) for (const r of bySession.get(sid) || []) if (r.ms >= startMs && r.ms <= untilMs) win.push(r);
    if (!win.length) continue;
    for (const r of win) covered.add(r.key);
    const share1h = share1hOf(win);

    const transByModel = new Map();
    for (const r of win) {
      const m = normModel(r.model);
      if (!transByModel.has(m)) transByModel.set(m, { recs: [], tok: emptyTok() });
      const t = transByModel.get(m);
      t.recs.push(r);
      const b = usageBreakdown(r.usage);
      for (const k of KINDS) t.tok[k] += b[k];
    }
    const stateByModel = new Map();
    for (const [model, u] of Object.entries(run.best.modelUsage || {})) {
      const m = normModel(model);
      const cur = stateByModel.get(m) || emptyTok();
      const add = stateTok(u);
      for (const k of KINDS) cur[k] += add[k];
      stateByModel.set(m, cur);
    }

    const pieces = new Map(); // record key -> Map(model -> tok)
    const addPiece = (r, model, kind, amount) => {
      if (!pieces.has(r.key)) pieces.set(r.key, { r, byModel: new Map() });
      const p = pieces.get(r.key).byModel;
      if (!p.has(model)) p.set(model, emptyTok());
      p.get(model)[kind] += amount;
    };

    const gap = emptyTok();
    const bg = emptyTok();
    let bgModel = null;
    for (const [m, st] of stateByModel) {
      const tr = transByModel.get(m);
      if (!tr) {
        // No transcript line for this model at all: background calls.
        for (const k of KINDS) {
          spread(win, st[k], () => 1, (r, amt) => addPiece(r, m, k, amt));
          bg[k] += st[k];
        }
        bgModel = bgModel || m;
        const acc = bgByModel.get(m) || emptyTok();
        for (const k of KINDS) acc[k] += st[k];
        bgByModel.set(m, acc);
        continue;
      }
      for (const k of KINDS) {
        const missing = st[k] - tr.tok[k];
        if (missing <= 0) continue;
        gap[k] += missing;
        if (k === 'output') {
          const incomplete = tr.recs.filter((r) => !r.complete);
          if (incomplete.length) spread(incomplete, missing, () => 1, (r, amt) => addPiece(r, m, k, amt));
          else spread(tr.recs, missing, (r) => usageBreakdown(r.usage).output, (r, amt) => addPiece(r, m, k, amt));
        } else {
          spread(tr.recs, missing, (r) => usageBreakdown(r.usage)[k], (r, amt) => addPiece(r, m, k, amt));
        }
      }
    }

    for (const { r, byModel } of pieces.values()) {
      for (const [model, tok] of byModel) {
        const costUsd = priceTok(model, tok, share1h);
        reportedCostUsd += costUsd;
        entries.push({ ms: r.ms, project: r.project, model, ownerSessionId: r.ownerSessionId, tier: 'live', source: 'reported', tok, costUsd, turns: 0 });
      }
    }
    learn.push({ n: win.length, incomplete: win.filter((r) => !r.complete).length, gap, bg });
  }

  // ── Modeled layer for everything no snapshot covers. ──
  const rates = {};
  for (const k of KINDS) rates[k] = fitNonNegative(learn.map((l) => ({ x1: l.n, x2: l.incomplete, y: l.gap[k] })));
  const learnedResponses = learn.reduce((a, l) => a + l.n, 0);
  let bgModel = null;
  let bgTop = -1;
  for (const [m, t] of bgByModel) if (tokSum(t) > bgTop) { bgTop = tokSum(t); bgModel = m; }
  const bgPerResponse = emptyTok();
  if (bgModel && learnedResponses) for (const k of KINDS) bgPerResponse[k] = bgByModel.get(bgModel)[k] / learnedResponses;

  let modeledCostUsd = 0;
  let uncoveredResponses = 0;
  for (const recs of bySession.values()) {
    const share1h = share1hOf(recs);
    for (const r of recs) {
      if (covered.has(r.key)) continue;
      uncoveredResponses += 1;
      const tok = emptyTok();
      for (const k of KINDS) tok[k] = rates[k].a + (r.complete ? 0 : rates[k].b);
      if (tokSum(tok) > 0) {
        const costUsd = priceTok(r.model, tok, share1h);
        modeledCostUsd += costUsd;
        entries.push({ ms: r.ms, project: r.project, model: normModel(r.model), ownerSessionId: r.ownerSessionId, tier: 'estimated', source: 'modeled', tok, costUsd, turns: 0 });
      }
      if (bgModel && tokSum(bgPerResponse) > 0) {
        const bgTok = { ...bgPerResponse };
        const costUsd = priceTok(bgModel, bgTok, 0);
        modeledCostUsd += costUsd;
        entries.push({ ms: r.ms, project: r.project, model: bgModel, ownerSessionId: r.ownerSessionId, tier: 'estimated', source: 'modeled', tok: bgTok, costUsd, turns: 0 });
      }
    }
  }

  return {
    entries,
    stats: {
      runs: learn.length,
      coveredResponses: covered.size,
      uncoveredResponses,
      reportedCostUsd,
      modeledCostUsd,
      rates: Object.fromEntries(KINDS.map((k) => [k, { perResponse: rates[k].a, perIncompleteResponse: rates[k].b }])),
      backgroundModel: bgModel,
    },
  };
}
