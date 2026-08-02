// Single source of truth for reading token counts out of an Anthropic
// `message.usage` object (see server/parseLogs.js for the exact JSONL shape
// this comes from). pricing.js, parseLogs.js, and aggregate.js all read
// through this module instead of each re-deriving the cache_creation split.

export function cacheSplit(usage) {
  const cc = usage.cache_creation || {};
  return {
    write5m: cc.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0,
    write1h: cc.ephemeral_1h_input_tokens ?? 0,
    read: usage.cache_read_input_tokens ?? 0,
  };
}

export function usageBreakdown(usage) {
  const { write5m, write1h, read } = cacheSplit(usage);
  return {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheWrite: write5m + write1h,
    cacheRead: read,
  };
}

export function usageTotalTokens(usage) {
  const b = usageBreakdown(usage);
  return b.input + b.output + b.cacheWrite + b.cacheRead;
}

export function usageHasTokens(usage) {
  return usageTotalTokens(usage) > 0;
}
