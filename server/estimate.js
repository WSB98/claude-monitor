// Per-prompt cost model for prompts in history.jsonl whose transcripts are
// gone, measured on this machine's own sessions and priced at the prices
// in effect when each prompt was made.
//
// It works in two separate steps, because two separate things change over
// time: how much you use Claude Code per prompt, and what that usage costs.
//
// VOLUME — how many tokens a prompt drove:
//  1. Every basis session (a surviving transcript that also has
//     history.jsonl prompts) has its usage split across its prompts — each
//     response, and each reconcile.js addition, belongs to the latest
//     prompt at or before it.
//  2. Prompts are bucketed by their position within their session
//     (1, 2-3, 4-7, 8-15, 16-31, 32-63, 64+): every turn re-reads the
//     conversation so far, so later prompts in a long session drive far
//     more tokens. Each bucket's rate is its measured tokens per prompt, by
//     token type; sparse buckets borrow from the pooled rate.
//  3. Each project gets an intensity factor — its measured volume over what
//     the bucket rates predict — shrunk toward 1 by how many *sessions*
//     back it, so one unusual session can't define a project.
//  4. An era factor anchors volume to each period: every session with known
//     usage near a prompt's date (surviving transcripts, plus deleted
//     sessions Claude Code itself recorded — history.js
//     readReportedSessions) says how its real volume compared to the
//     prediction. Those ratios are averaged geometrically, weighted by
//     closeness in time and by session size, and shrunk toward 1 where the
//     evidence is thin.
//  "Volume" compares token mixes at one fixed reference price (REF_RATES),
//  so a model getting cheaper or pricier never reads as using it more or
//  less.
//
// PRICE — what those tokens cost then:
//  5. The models in use at a date come from the same nearby sessions (by
//     their usage share per model), and each model's tokens are priced at
//     that model's own list price (pricing.js). So a spring prompt made on
//     Opus 4.7 is priced like Opus 4.7, not like today's Opus.

import { costFromBreakdown, ratesFor } from './pricing.js';

const BUCKET_LIMITS = [1, 3, 7, 15, 31, 63]; // upper bounds; beyond = last bucket
const MIN_BUCKET_PROMPTS = 8; // below this, a bucket's rate leans on the pooled rate
const PROJECT_SHRINK_SESSIONS = 2; // sessions of evidence that count as much as the overall prior
const ERA_KERNEL_DAYS = 30; // how far in time a calibration session's evidence reaches
const ERA_PRIOR_WEIGHT = 1; // weight of "same as the fitted behavior" when evidence is thin
const SESSION_SIZE_HALF = 5; // a session of this many prompts carries half weight
const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = ['input', 'output', 'cacheWrite', 'cacheRead'];

// Fixed weights (USD per MTok, Opus 5.5 list prices, 5-minute writes) used
// only to compare token volumes of different mixes — never to price.
const REF_RATES = { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 };

export const BUCKET_LABELS = ['1', '2-3', '4-7', '8-15', '16-31', '32-63', '64+'];

export function bucketOf(position) {
  const i = BUCKET_LIMITS.findIndex((lim) => position <= lim);
  return i === -1 ? BUCKET_LIMITS.length : i;
}

const emptyTok = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const scaleTok = (t, f) => ({ input: t.input * f, output: t.output * f, cacheWrite: t.cacheWrite * f, cacheRead: t.cacheRead * f });
function addTok(into, t) {
  for (const k of KINDS) into[k] += t[k];
}

export function volumeOf(t) {
  let v = 0;
  for (const k of KINDS) v += t[k] * REF_RATES[k];
  return v / 1_000_000;
}

const normModel = (m) => String(m || 'unknown').replace(/\[[^\]]*\]$/, '');

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

function medianMs(prompts) {
  const ms = prompts.map((p) => p.ms).sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)];
}

// sessionSpend: Map(sessionId -> { spend: [{ ms, model, tok, costUsd }] })
// liveShare1h: share of cache writes at the 1-hour TTL in surviving
// transcripts (the TTL split isn't kept per session).
export function buildPromptModel(sessionSpend, promptHistory, { liveShare1h = 0 } = {}) {
  const { pos, bySession: promptsBySession } = promptPositions(promptHistory);
  const bucketTok = BUCKET_LABELS.map(() => ({ prompts: 0, tok: emptyTok() }));
  const pooled = { prompts: 0, tok: emptyTok() };
  const basis = []; // { project, prompts, tok, buckets, modelTok: Map }

  for (const [sid, prompts] of promptsBySession) {
    const s = sessionSpend.get(sid);
    if (!s || !s.spend?.length) continue;
    const perPrompt = prompts.map(() => emptyTok());
    const modelTok = new Map();
    const spend = [...s.spend].sort((a, b) => a.ms - b.ms);
    let j = 0;
    for (const item of spend) {
      while (j + 1 < prompts.length && prompts[j + 1].ms <= item.ms) j += 1;
      addTok(perPrompt[j], item.tok);
      const m = normModel(item.model);
      if (!modelTok.has(m)) modelTok.set(m, emptyTok());
      addTok(modelTok.get(m), item.tok);
    }
    const buckets = prompts.map((_, i) => bucketOf(i + 1));
    const total = emptyTok();
    perPrompt.forEach((t, i) => {
      bucketTok[buckets[i]].prompts += 1;
      addTok(bucketTok[buckets[i]].tok, t);
      pooled.prompts += 1;
      addTok(pooled.tok, t);
      addTok(total, t);
    });
    basis.push({ project: prompts[0].project, prompts, tok: total, buckets, modelTok });
  }
  if (!pooled.prompts) return null;

  // Tokens per prompt, per position bucket (thin buckets lean on the pooled rate).
  const pooledRate = scaleTok(pooled.tok, 1 / pooled.prompts);
  const bucketRates = bucketTok.map((b) => {
    if (!b.prompts) return pooledRate;
    const w = b.prompts / (b.prompts + MIN_BUCKET_PROMPTS);
    const own = scaleTok(b.tok, 1 / b.prompts);
    const out = emptyTok();
    for (const k of KINDS) out[k] = w * own[k] + (1 - w) * pooledRate[k];
    return out;
  });

  // Project intensity: measured volume over predicted, shrunk (in log
  // space) toward 1 by session count.
  const projAcc = new Map();
  for (const sess of basis) {
    const a = projAcc.get(sess.project) || { actual: 0, predicted: 0, sessions: 0 };
    a.actual += volumeOf(sess.tok);
    a.predicted += sess.buckets.reduce((sum, b) => sum + volumeOf(bucketRates[b]), 0);
    a.sessions += 1;
    projAcc.set(sess.project, a);
  }
  const projectFactors = new Map();
  for (const [project, a] of projAcc) {
    const raw = a.predicted > 0 && a.actual > 0 ? a.actual / a.predicted : 1;
    projectFactors.set(project, Math.pow(raw, a.sessions / (a.sessions + PROJECT_SHRINK_SESSIONS)));
  }

  // Expected tokens for one prompt before the era factor.
  const baseTok = (prompt) => {
    const p = pos.get(prompt);
    return scaleTok(p ? bucketRates[bucketOf(p)] : pooledRate, projectFactors.get(prompt.project) ?? 1);
  };
  const baseVolume = (prompt) => volumeOf(baseTok(prompt));

  // Every session with known usage: what it really used (volume and which
  // models), what the model predicted for it, and when.
  const calibration = basis.map((sess) => ({
    ms: medianMs(sess.prompts),
    prompts: sess.prompts.length,
    actualVol: volumeOf(sess.tok),
    predictedVol: sess.prompts.reduce((a, p) => a + baseVolume(p), 0),
    modelVol: new Map([...sess.modelTok].map(([m, t]) => [m, volumeOf(t)])),
    share1h: liveShare1h,
    source: 'transcript',
  }));

  const weightAt = (c, ms) => (c.prompts / (c.prompts + SESSION_SIZE_HALF)) * Math.exp(-0.5 * ((ms - c.ms) / DAY_MS / ERA_KERNEL_DAYS) ** 2);

  // priorWeight 0 = trust the period's evidence alone (the low end of the
  // range shown in the UI); no era factor at all = today's fitted volume
  // throughout (the high end).
  const eraFactorAt = (ms, priorWeight = ERA_PRIOR_WEIGHT) => {
    let num = 0;
    let den = priorWeight;
    for (const c of calibration) {
      if (!(c.predictedVol > 0)) continue;
      const w = weightAt(c, ms);
      // a small floor keeps a near-empty session from meaning "infinitely less"
      num += w * Math.log((c.actualVol + 0.01) / (c.predictedVol + 0.01));
      den += w;
    }
    return den > 0 ? Math.exp(num / den) : 1;
  };

  // Models in use around a date, plus the cache-write TTL split then. Each
  // nearby session votes with its own model shares, weighted by closeness
  // in time and session size — not by its volume, so one heavy session
  // months away can't outvote the sessions actually from that period. Far
  // from all evidence, the nearest session decides.
  const mixCache = new Map();
  const mixAt = (ms) => {
    const day = Math.floor(ms / DAY_MS);
    if (mixCache.has(day)) return mixCache.get(day);
    const vols = new Map();
    let total = 0;
    let w1h = 0;
    for (const c of calibration) {
      const w = weightAt(c, ms);
      const priced = [...c.modelVol].filter(([m, v]) => ratesFor(m) && v > 0);
      const sum = priced.reduce((a, [, v]) => a + v, 0);
      if (!(sum > 0) || !(w > 0)) continue;
      for (const [m, v] of priced) vols.set(m, (vols.get(m) || 0) + (w * v) / sum);
      total += w;
      w1h += w * c.share1h;
    }
    let mix;
    if (total > 1e-12) {
      mix = { shares: [...vols].map(([model, v]) => ({ model, share: v / total })), share1h: w1h / total };
    } else {
      const nearest = calibration.reduce((a, c) => (!a || Math.abs(c.ms - ms) < Math.abs(a.ms - ms) ? c : a), null);
      const priced = [...(nearest?.modelVol || [])].filter(([m, v]) => ratesFor(m) && v > 0);
      const sum = priced.reduce((a, [, v]) => a + v, 0);
      mix = { shares: sum ? priced.map(([model, v]) => ({ model, share: v / sum })) : [], share1h: nearest?.share1h || 0 };
    }
    mixCache.set(day, mix);
    return mix;
  };

  const priceAt = (tok, ms) => {
    const { shares, share1h } = mixAt(ms);
    return shares.map(({ model, share }) => {
      const t = scaleTok(tok, share);
      const costUsd =
        costFromBreakdown(model, {
          input: t.input,
          output: t.output,
          cacheRead: t.cacheRead,
          cacheWrite5m: t.cacheWrite * (1 - share1h),
          cacheWrite1h: t.cacheWrite * share1h,
          perRequest: false,
        }) || 0;
      return { model, tok: t, costUsd };
    });
  };

  return {
    // Expected per-model usage and cost for one prompt, at that date's
    // volume and that date's models and prices.
    predict(prompt) {
      return priceAt(scaleTok(baseTok(prompt), eraFactorAt(prompt.ms)), prompt.ms);
    },
    baseVolume,
    // Bounds: the period's evidence alone, and today's volume throughout —
    // both still priced at the models in use at each date.
    costRange(prompts) {
      let low = 0;
      let high = 0;
      const sumCost = (parts) => parts.reduce((a, r) => a + r.costUsd, 0);
      for (const p of prompts) {
        const tok = baseTok(p);
        low += sumCost(priceAt(scaleTok(tok, eraFactorAt(p.ms, 0)), p.ms));
        high += sumCost(priceAt(tok, p.ms));
      }
      return { low, high };
    },
    // A deleted session Claude Code recorded: tokens per model.
    addCalibration(prompts, modelTok, share1h = 0) {
      if (!prompts.length) return;
      const total = emptyTok();
      const modelVol = new Map();
      for (const [m, t] of modelTok) {
        addTok(total, t);
        const nm = normModel(m);
        modelVol.set(nm, (modelVol.get(nm) || 0) + volumeOf(t));
      }
      calibration.push({ ms: medianMs(prompts), prompts: prompts.length, actualVol: volumeOf(total), predictedVol: prompts.reduce((a, p) => a + baseVolume(p), 0), modelVol, share1h, source: 'reported' });
      mixCache.clear();
    },
    eraFactorAt,
    mixAt,
    stats() {
      return {
        basisSessions: basis.length,
        basisPrompts: pooled.prompts,
        buckets: BUCKET_LABELS.map((label, i) => ({ positions: label, prompts: bucketTok[i].prompts, volumePerPrompt: volumeOf(bucketRates[i]) })),
        projectFactors: Object.fromEntries([...projectFactors].map(([k, v]) => [k, Math.round(v * 100) / 100])),
        calibration: calibration.map((c) => ({
          date: new Date(c.ms).toISOString().slice(0, 10),
          prompts: c.prompts,
          actualVolume: c.actualVol,
          predictedVolume: c.predictedVol,
          models: [...c.modelVol.keys()],
          source: c.source,
        })),
      };
    },
  };
}
