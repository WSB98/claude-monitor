// Per-prompt cost model, measured on this machine's own sessions, for
// prompts in history.jsonl whose transcripts are gone.
//
// A flat "average cost per prompt" ignores how cost actually behaves in a
// Claude Code session: every turn re-reads the conversation so far, so the
// 30th prompt of a long session costs far more than the 1st prompt of a
// fresh one, and some projects simply run heavier than others. So:
//
//  1. Every basis session (a surviving transcript that also has
//     history.jsonl prompts) has its spend split across its prompts — each
//     response, and each reconcile.js addition, belongs to the latest
//     prompt at or before it.
//  2. Prompts are bucketed by their position within their session
//     (1, 2-3, 4-7, 8-15, 16-31, 32-63, 64+). Each bucket's rate is its
//     measured spend over its prompt count, per model and token type.
//     Sparse buckets borrow from the pooled rate.
//  3. Each project gets a factor: its actual spend over what the bucket
//     rates predict for its prompts, shrunk toward 1 by how many *sessions*
//     back it (prompts within one session move together, so one unusual
//     session can't define a project).
//  4. How you use Claude Code changes over time (models, effort, how much
//     work goes to subagents), so the model is fitted on recent sessions
//     but anchored to each period by an era factor: every session with
//     known spend near a prompt's date — surviving transcripts, plus
//     deleted sessions Claude Code itself recorded (history.js
//     readReportedSessions) — says how actual spend compared to the
//     model's prediction then. Those ratios are averaged (geometrically,
//     weighted by closeness in time and by session size), shrunk toward 1
//     where evidence is thin.
//
// An uncovered prompt is then priced at its own position's rate times its
// project's factor times its era's factor. Its position is known exactly,
// because history.jsonl keeps every prompt of the deleted session.

const BUCKET_LIMITS = [1, 3, 7, 15, 31, 63]; // upper bounds; beyond = last bucket
const MIN_BUCKET_PROMPTS = 8; // below this, a bucket's rate leans on the pooled rate
const PROJECT_SHRINK_SESSIONS = 2; // sessions of evidence that count as much as the overall prior
const ERA_KERNEL_DAYS = 30; // how far in time a calibration session's evidence reaches
const ERA_PRIOR_WEIGHT = 1; // weight of "same as the fitted behavior" when evidence is thin
const SESSION_SIZE_HALF = 5; // a session of this many prompts carries half weight
const DAY_MS = 24 * 60 * 60 * 1000;

export const BUCKET_LABELS = ['1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];

export function bucketOf(position) {
  const i = BUCKET_LIMITS.findIndex((lim) => position <= lim);
  return i === -1 ? BUCKET_LIMITS.length : i;
}

const emptyTok = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

function emptyAcc() {
  return { prompts: 0, costUsd: 0, byModel: new Map() }; // model -> { tok, costUsd }
}

function accAdd(acc, model, tok, costUsd) {
  let m = acc.byModel.get(model);
  if (!m) acc.byModel.set(model, (m = { tok: emptyTok(), costUsd: 0 }));
  m.tok.input += tok.input;
  m.tok.output += tok.output;
  m.tok.cacheWrite += tok.cacheWrite;
  m.tok.cacheRead += tok.cacheRead;
  m.costUsd += costUsd;
  acc.costUsd += costUsd;
}

// Per-prompt rate (per model) from an accumulator.
function rateOf(acc) {
  const n = acc.prompts || 1;
  return {
    costUsd: acc.costUsd / n,
    byModel: [...acc.byModel].map(([model, m]) => ({
      model,
      costUsd: m.costUsd / n,
      tok: { input: m.tok.input / n, output: m.tok.output / n, cacheWrite: m.tok.cacheWrite / n, cacheRead: m.tok.cacheRead / n },
    })),
  };
}

// Blends two per-prompt rates: w * a + (1 - w) * b.
function blend(a, b, w) {
  const models = new Map();
  const put = (r, f) => {
    for (const m of r.byModel) {
      const cur = models.get(m.model) || { model: m.model, costUsd: 0, tok: emptyTok() };
      cur.costUsd += m.costUsd * f;
      for (const k of Object.keys(cur.tok)) cur.tok[k] += m.tok[k] * f;
      models.set(m.model, cur);
    }
  };
  put(a, w);
  put(b, 1 - w);
  const byModel = [...models.values()];
  return { costUsd: byModel.reduce((s, m) => s + m.costUsd, 0), byModel };
}

// Positions of every prompt within its own session (1-based, by time).
export function promptPositions(promptHistory) {
  const bySession = new Map();
  for (const p of promptHistory) {
    if (!p.sessionId) continue;
    if (!bySession.has(p.sessionId)) bySession.set(p.sessionId, []);
    bySession.get(p.sessionId).push(p);
  }
  const pos = new Map(); // prompt object -> position
  for (const list of bySession.values()) {
    list.sort((a, b) => a.ms - b.ms);
    list.forEach((p, i) => pos.set(p, i + 1));
  }
  return { pos, bySession };
}

// sessionSpend: Map(sessionId -> { spend: [{ ms, model, tok, costUsd }] })
export function buildPromptModel(sessionSpend, promptHistory) {
  const { pos, bySession: promptsBySession } = promptPositions(promptHistory);
  const buckets = BUCKET_LABELS.map(() => emptyAcc());
  const pooled = emptyAcc();
  const basis = []; // { project, prompts, actual, buckets: [bucket per prompt] }
  let basisSessions = 0;

  for (const [sid, prompts] of promptsBySession) {
    const s = sessionSpend.get(sid);
    if (!s || !s.spend?.length) continue;
    basisSessions += 1;
    const accs = prompts.map(() => emptyAcc());
    const spend = [...s.spend].sort((a, b) => a.ms - b.ms);
    let j = 0;
    for (const item of spend) {
      while (j + 1 < prompts.length && prompts[j + 1].ms <= item.ms) j += 1;
      accAdd(accs[j], item.model, item.tok, item.costUsd);
    }
    const sessionBuckets = [];
    prompts.forEach((p, i) => {
      const b = bucketOf(i + 1);
      const acc = accs[i];
      buckets[b].prompts += 1;
      pooled.prompts += 1;
      for (const [model, m] of acc.byModel) {
        accAdd(buckets[b], model, m.tok, m.costUsd);
        accAdd(pooled, model, m.tok, m.costUsd);
      }
      sessionBuckets.push(b);
    });
    basis.push({ project: prompts[0].project, prompts, actual: accs.reduce((a, x) => a + x.costUsd, 0), buckets: sessionBuckets });
  }

  if (!pooled.prompts) return null;
  const pooledRate = rateOf(pooled);
  // Each bucket leans on the pooled rate in proportion to how thin it is.
  const bucketRates = buckets.map((acc) => {
    if (!acc.prompts) return pooledRate;
    const w = acc.prompts / (acc.prompts + MIN_BUCKET_PROMPTS);
    return blend(rateOf(acc), pooledRate, w);
  });

  // Project factors: observed spend vs what the bucket rates predict, as a
  // ratio shrunk (in log space) toward 1 by session count.
  const projAcc = new Map();
  for (const sess of basis) {
    const a = projAcc.get(sess.project) || { actual: 0, predicted: 0, sessions: 0 };
    a.actual += sess.actual;
    a.predicted += sess.buckets.reduce((sum, b) => sum + bucketRates[b].costUsd, 0);
    a.sessions += 1;
    projAcc.set(sess.project, a);
  }
  const projectFactors = new Map();
  for (const [project, a] of projAcc) {
    const raw = a.predicted > 0 && a.actual > 0 ? a.actual / a.predicted : 1;
    projectFactors.set(project, Math.pow(raw, a.sessions / (a.sessions + PROJECT_SHRINK_SESSIONS)));
  }

  const baseCost = (prompt) => {
    const p = pos.get(prompt);
    const rate = p ? bucketRates[bucketOf(p)] : pooledRate;
    return rate.costUsd * (projectFactors.get(prompt.project) ?? 1);
  };

  // Calibration points for the era factor: every session whose real spend
  // is known. Basis sessions first; merge.js adds Claude Code's own records
  // of deleted sessions via addCalibration().
  const calibration = basis.map((sess) => ({
    ms: medianMs(sess.prompts),
    prompts: sess.prompts.length,
    actual: sess.actual,
    predicted: sess.prompts.reduce((a, p) => a + baseCost(p), 0),
    source: 'transcript',
  }));

  // priorWeight 0 = trust the period's evidence alone (the low end of the
  // range shown in the UI); no era factor at all = assume today's behavior
  // throughout (the high end).
  const eraFactorAt = (ms, priorWeight = ERA_PRIOR_WEIGHT) => {
    let num = 0;
    let den = priorWeight;
    for (const c of calibration) {
      if (!(c.predicted > 0)) continue;
      const days = (ms - c.ms) / DAY_MS;
      const w = (c.prompts / (c.prompts + SESSION_SIZE_HALF)) * Math.exp(-0.5 * (days / ERA_KERNEL_DAYS) ** 2);
      // a cent of slack keeps a $0 session from meaning "infinitely cheaper"
      num += w * Math.log((c.actual + 0.01) / (c.predicted + 0.01));
      den += w;
    }
    return den > 0 ? Math.exp(num / den) : 1;
  };

  return {
    // Expected per-model spend for one prompt, era-adjusted.
    predict(prompt) {
      const p = pos.get(prompt);
      const rate = p ? bucketRates[bucketOf(p)] : pooledRate;
      const f = (projectFactors.get(prompt.project) ?? 1) * eraFactorAt(prompt.ms);
      return rate.byModel.map((m) => ({
        model: m.model,
        costUsd: m.costUsd * f,
        tok: { input: m.tok.input * f, output: m.tok.output * f, cacheWrite: m.tok.cacheWrite * f, cacheRead: m.tok.cacheRead * f },
      }));
    },
    // Model prediction without the era factor, for building calibration.
    baseCost,
    // Total predicted cost under the two bounding assumptions above.
    costRange(prompts) {
      let low = 0;
      let high = 0;
      for (const p of prompts) {
        const b = baseCost(p);
        low += b * eraFactorAt(p.ms, 0);
        high += b;
      }
      return { low, high };
    },
    addCalibration(prompts, actual) {
      if (!prompts.length) return;
      calibration.push({ ms: medianMs(prompts), prompts: prompts.length, actual, predicted: prompts.reduce((a, p) => a + baseCost(p), 0), source: 'reported' });
    },
    eraFactorAt,
    stats() {
      return {
        basisSessions,
        basisPrompts: pooled.prompts,
        pooledCostPerPrompt: pooledRate.costUsd,
        buckets: BUCKET_LABELS.map((label, i) => ({ positions: label, prompts: buckets[i].prompts, costPerPrompt: bucketRates[i].costUsd })),
        projectFactors: Object.fromEntries([...projectFactors].map(([k, v]) => [k, Math.round(v * 100) / 100])),
        calibration: calibration.map((c) => ({ date: new Date(c.ms).toISOString().slice(0, 10), prompts: c.prompts, actualUsd: c.actual, predictedUsd: c.predicted, source: c.source })),
      };
    },
  };
}

function medianMs(prompts) {
  const ms = prompts.map((p) => p.ms).sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)];
}
