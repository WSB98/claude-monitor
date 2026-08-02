// Shared display formatting — used by main.js (hero cards, bar lists, feed)
// and networkViz.js (hover tooltips) so a token/cost number reads the same
// wherever it shows up.

const currencyFmt = {
  2: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  3: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 3, maximumFractionDigits: 3 }),
};

export function formatTokens(n) {
  if (n == null || Number.isNaN(n)) return '--';
  const v = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (v >= 1_000_000_000) return sign + (v / 1_000_000_000).toFixed(3) + 'B';
  if (v >= 1_000_000) return sign + (v / 1_000_000).toFixed(2) + 'M';
  if (v >= 1_000) return sign + (v / 1_000).toFixed(1) + 'k';
  return sign + String(Math.round(v));
}

// toLocaleString-backed currency formatting — real thousands separators
// (a $2,618.49 total no longer prints as "$2618.49"), full cents precision
// above $10, one extra digit below that so sub-dollar per-turn costs in the
// live feed don't all round down to the same couple of cents.
export function formatCost(n) {
  if (n == null || Number.isNaN(n)) return '--';
  return currencyFmt[Math.abs(n) >= 10 ? 2 : 3].format(n);
}

export function formatRelative(iso) {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diffMs / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}

// innerHTML is built from strings that ultimately trace back to local
// filesystem names (project directory basenames) or agent-generated
// descriptions — neither is attacker-controlled in the traditional sense
// since this dashboard only ever reads the local user's own machine, but
// escaping is nearly free and means a stray "<"/"&" in a folder name or a
// subagent's task description can never be interpreted as markup.
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
