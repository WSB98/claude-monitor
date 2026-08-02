import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectUsageRecords, collectPendingTurns, logRootExists, scannedProjectCount } from './parseLogs.js';
import { aggregate } from './aggregate.js';
import { readRecoveredStats, readPromptHistory } from './history.js';
import { mergeHistorical } from './merge.js';

const HOST = '127.0.0.1'; // localhost only — this exposes local project names and usage patterns, no reason to put it on the LAN
const PORT = process.env.PORT ? Number(process.env.PORT) : 5787;
const PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function serveStatic(req, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(req.url.split('?')[0]);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  const requested = decoded === '/' ? '/index.html' : decoded;
  const filePath = join(PUBLIC_DIR, requested);
  // Reject anything that resolves outside PUBLIC_DIR — a plain startsWith
  // check would also (wrongly) allow a sibling dir like "public-evil", so
  // require an exact match or the directory separator right after the prefix.
  const withinPublic = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + sep);
  if (!withinPublic) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}

function serveUsage(req, res) {
  let payload;
  try {
    const records = collectUsageRecords();
    const pendingTurns = collectPendingTurns();
    const live = aggregate(records, pendingTurns);
    const merged = mergeHistorical(live, readRecoveredStats(), readPromptHistory());
    payload = { ok: true, logRootExists: logRootExists(), scannedProjects: scannedProjectCount(), ...merged };
  } catch (err) {
    payload = { ok: false, error: err.message };
  }
  res.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

const server = createServer((req, res) => {
  if (req.url === '/api/usage') {
    serveUsage(req, res);
    return;
  }
  serveStatic(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`claude-monitor running at http://${HOST}:${PORT} (localhost only)`);
});
