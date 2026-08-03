# Claude Monitor

A local dashboard for [Claude Code](https://claude.com/product/claude-code) token usage and cost. It reads the JSONL transcripts and stats files Claude Code already keeps under `~/.claude` on your machine, aggregates them, and serves a live dashboard — turns, tokens, estimated cost, per-project and per-model breakdowns, and a real-time "activity pulse" view of sessions/subagents as they run.

All usage data stays local — read-only, localhost-only, nothing about your usage is ever uploaded anywhere. The one outbound network call is a Google Fonts import for the display type (`public/index.html`); see [How it works](#how-it-works) if you want to swap that out or remove it.

## Requirements

- Node.js ≥ 18.11
- Claude Code, run at least once, so `~/.claude/projects` exists

## Install & run

```sh
git clone <this-repo-url>
cd claude-monitor
npm install
npm run dev
```

Then open **http://127.0.0.1:5787**.

- `npm run dev` — starts the server with `node --watch`, auto-restarting on server-file changes (recommended for local use)
- `npm start` — starts the server once, no auto-restart
- `npm run stop` — kills whatever's listening on the port, in case a previous run is still bound to it

The port defaults to `5787`; override with `PORT=<port> npm run dev`.

## How it works

- **Read-only.** The server only ever calls `readFileSync`/`readdirSync`/`statSync` against your `~/.claude` directory — no file there is ever written, renamed, or deleted. It also never reads message content, only timestamps, token counts, model IDs, and project directory names.
- **Localhost only.** The server binds to `127.0.0.1`, not `0.0.0.0` — it's not reachable from your LAN.
- **No hardcoded paths.** The `~/.claude` location is resolved at runtime via Node's `os.homedir()`, so this works the same on Windows, macOS, and Linux, under any username.
- **Fonts are modular.** The two `<link>` tags at the top of `public/index.html` pull the default type (VT323, Share Tech Mono, Rajdhani) from Google Fonts — swap them for your own Google Fonts import, or delete them entirely. Either way, `public/style.css`'s `--font-*-custom` variables in `:root` are the one thing to edit to match, and every font-family already falls back to a full system-font stack if nothing loads.
- Cost is computed from a local pricing table (`server/pricing.js`) and may drift if Anthropic changes pricing — check `platform.claude.com/docs/en/pricing.md` if numbers look stale.

## License

MIT — see [LICENSE](./LICENSE).
