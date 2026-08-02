import { cacheSplit } from './usage.js';

// USD per million tokens. Cached from Anthropic pricing, 2026-06-24 — re-check
// platform.claude.com/docs/en/pricing.md if numbers look stale.
const BASE_RATES = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-mythos-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4-1': { input: 5, output: 25 },
  'claude-opus-4-0': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4-0': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// Unrecognized model strings (older snapshots, future releases) fall back to
// their family's current rate by substring match.
const FAMILY_FALLBACK = [
  { match: /fable|mythos/i, rates: BASE_RATES['claude-fable-5'] },
  { match: /opus/i, rates: BASE_RATES['claude-opus-4-8'] },
  { match: /sonnet/i, rates: BASE_RATES['claude-sonnet-5'] },
  { match: /haiku/i, rates: BASE_RATES['claude-haiku-4-5'] },
];

// Standard cache multipliers Anthropic applies against the input rate.
const CACHE_WRITE_5M_MULT = 1.25;
const CACHE_WRITE_1H_MULT = 2;
const CACHE_READ_MULT = 0.1;

export function ratesFor(model) {
  if (!model) return null;
  if (BASE_RATES[model]) return BASE_RATES[model];
  const fallback = FAMILY_FALLBACK.find((f) => f.match.test(model));
  return fallback ? fallback.rates : null;
}

// Shared cost primitive — anything that can produce a token breakdown (the
// live per-turn usage object, or a coarser lifetime aggregate like
// stats-cache.json's modelUsage) prices through this one function.
export function costFromBreakdown(model, { input = 0, output = 0, cacheWrite5m = 0, cacheWrite1h = 0, cacheRead = 0 }) {
  const rates = ratesFor(model);
  if (!rates) return null;

  const perMillion = (tokens, rate) => (tokens * rate) / 1_000_000;

  return (
    perMillion(input, rates.input) +
    perMillion(output, rates.output) +
    perMillion(cacheWrite5m, rates.input * CACHE_WRITE_5M_MULT) +
    perMillion(cacheWrite1h, rates.input * CACHE_WRITE_1H_MULT) +
    perMillion(cacheRead, rates.input * CACHE_READ_MULT)
  );
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
  });
}
