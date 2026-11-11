import { cacheSplit } from './usage.js';

// USD per million tokens, Claude API first-party list prices. Verified
// against platform.claude.com/docs/en/about-claude/pricing on 2026-11-11 —
// re-check there if numbers look stale.
//
// Per model:
//  - input / output: base rates.
//  - cacheRead: multiplier on the input rate for cache hits. 0.1x is the
//    standard, but newer models discount it further (0.05x on Opus 5.5 and
//    Sonnet 5.5, 0.025x on Fable/Mythos 5.1 and 5.2).
//  - Cache writes are always 1.25x (5-minute TTL) / 2x (1-hour TTL) input.
//  - longPrompt: Claude Haiku 5.5 is priced by prompt size — a request whose
//    prompt (input + cache reads + cache writes) is over 100K tokens pays
//    the higher rates on every token in it, output included.
//  - fast: fast-mode (usage.speed === "fast") input/output rates; cache
//    multipliers apply on top of them.
//  - geo: Claude 4.6 and later bill 1.1x on every token category when the
//    request ran with inference_geo "us".
//
// Claude 3.x and Opus 4/4.1 are retired, but older transcripts and
// stats-cache.json can still mention them, so they stay here at the prices
// they were billed at.
const STD_READ = 0.1;
const MODELS = {
  'claude-fable-5-2': { input: 8, output: 40, cacheRead: 0.025, fast: { input: 16, output: 80 }, geo: true },
  'claude-mythos-5-2': { input: 8, output: 40, cacheRead: 0.025, fast: { input: 16, output: 80 }, geo: true },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025, geo: true },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.025, geo: true },
  'claude-fable-5': { input: 10, output: 50, cacheRead: STD_READ, geo: true },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: STD_READ, geo: true },
  'claude-mythos-preview': { input: 10, output: 50, cacheRead: STD_READ, geo: true },

  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05, fast: { input: 8, output: 40 }, geo: true },
  'claude-opus-5': { input: 5, output: 25, cacheRead: STD_READ, fast: { input: 10, output: 50 }, geo: true },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: STD_READ, fast: { input: 10, output: 50 }, geo: true },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: STD_READ, geo: true },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: STD_READ, geo: true },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: STD_READ },
  'claude-opus-4-1': { input: 15, output: 75, cacheRead: STD_READ },
  'claude-opus-4': { input: 15, output: 75, cacheRead: STD_READ },
  'claude-3-opus': { input: 15, output: 75, cacheRead: STD_READ },

  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.05, geo: true },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: STD_READ, geo: true },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: STD_READ, geo: true },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: STD_READ },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: STD_READ },
  'claude-3-7-sonnet': { input: 3, output: 15, cacheRead: STD_READ },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: STD_READ },

  'claude-haiku-5-5': {
    input: 0.1, output: 0.5, cacheRead: STD_READ, geo: true,
    longPrompt: { overTokens: 100_000, input: 0.5, output: 2.5 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: STD_READ },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: STD_READ },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheRead: STD_READ },
};

// A model string that isn't an exact (normalized) match falls back to the
// newest model of its family — e.g. a future "claude-opus-6" bills at Opus
// 5.5 rates until this table learns about it. Those records are counted as
// approximately priced so the UI can say so instead of passing them off as
// exact.
const FAMILY_FALLBACK = [
  { match: /mythos/i, id: 'claude-mythos-5-2' },
  { match: /fable/i, id: 'claude-fable-5-2' },
  { match: /opus/i, id: 'claude-opus-5-5' },
  { match: /sonnet/i, id: 'claude-sonnet-5-5' },
  { match: /haiku/i, id: 'claude-haiku-5-5' },
];

const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;
const GEO_US_MULT = 1.1;
const WEB_SEARCH_USD_PER_REQUEST = 10 / 1000;

// Strips the decorations providers add around the same model:
// "claude-opus-4-5-20251101", "claude-opus-4-5@20251101" (Vertex),
// "us.anthropic.claude-opus-4-5-20251101-v1:0" (Bedrock).
function normalizeModelId(model) {
  return model
    .toLowerCase()
    .replace(/^(?:[a-z]{2,4}\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[@-]\d{8}$/, '')
    .replace(/-latest$/, '')
    .replace(/-(\d)-0$/, '-$1'); // "claude-opus-4-0" alias -> "claude-opus-4"
}

const resolveCache = new Map();

// Returns { id, rates, exact } or null when nothing matches at all.
export function resolveModel(model) {
  if (!model) return null;
  if (resolveCache.has(model)) return resolveCache.get(model);
  const id = normalizeModelId(model);
  let result = null;
  if (MODELS[id]) {
    result = { id, rates: MODELS[id], exact: true };
  } else {
    const fb = FAMILY_FALLBACK.find((f) => f.match.test(id));
    if (fb) result = { id: fb.id, rates: MODELS[fb.id], exact: false };
  }
  resolveCache.set(model, result);
  return result;
}

export function ratesFor(model) {
  return resolveModel(model)?.rates || null;
}

// Shared cost primitive — anything that can produce a token breakdown (the
// live per-turn usage object, or a coarser lifetime aggregate like
// stats-cache.json's modelUsage) prices through this one function. Each
// call prices one request; `longPrompt` tiering is decided by that one
// request's own prompt size, as Anthropic bills it. Pass perRequest: false
// for a sum over many requests, where that can't be decided (base rates).
export function costFromBreakdown(model, { input = 0, output = 0, cacheWrite5m = 0, cacheWrite1h = 0, cacheRead = 0, webSearches = 0, fast = false, geoUs = false, perRequest = true }) {
  const rates = ratesFor(model);
  if (!rates) return null;

  let inRate = rates.input;
  let outRate = rates.output;
  if (perRequest && rates.longPrompt && input + cacheWrite5m + cacheWrite1h + cacheRead > rates.longPrompt.overTokens) {
    inRate = rates.longPrompt.input;
    outRate = rates.longPrompt.output;
  }
  if (fast && rates.fast) {
    inRate = rates.fast.input;
    outRate = rates.fast.output;
  }
  const mult = geoUs && rates.geo ? GEO_US_MULT : 1;

  const tokenCost =
    input * inRate +
    output * outRate +
    cacheWrite5m * inRate * CACHE_WRITE_5M_MULT +
    cacheWrite1h * inRate * CACHE_WRITE_1H_MULT +
    cacheRead * inRate * rates.cacheRead;

  return (tokenCost * mult) / 1_000_000 + webSearches * WEB_SEARCH_USD_PER_REQUEST;
}

// Returns cost in USD for one usage record, or null if the model is unrecognized.
export function costForUsage(model, usage) {
  if (!usage) return null;
  const { write5m, write1h, read } = cacheSplit(usage);
  return costFromBreakdown(model, {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheWrite5m: write5m,
    cacheWrite1h: write1h,
    cacheRead: read,
    webSearches: usage.server_tool_use?.web_search_requests ?? 0,
    fast: usage.speed === 'fast',
    geoUs: usage.inference_geo === 'us',
  });
}
