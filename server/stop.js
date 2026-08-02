// Cross-platform replacement for a shell-specific "kill whatever's on the
// port" one-liner. Finds the PID(s) bound to PORT and kills them, using
// netstat on Windows and lsof elsewhere. Best-effort: if no process is found
// (or the platform's lookup tool is missing), it just says so and exits 0 —
// this is a dev convenience, not something that should ever fail a script.

import { execSync } from 'node:child_process';

const PORT = process.env.PORT ? Number(process.env.PORT) : 5787;

function findPidsWindows() {
  let out;
  try {
    out = execSync('netstat -ano', { encoding: 'utf8' });
  } catch {
    return [];
  }
  const pids = new Set();
  const portSuffix = `:${PORT}`;
  for (const line of out.split('\n')) {
    if (!line.includes('LISTENING')) continue;
    const cols = line.trim().split(/\s+/);
    // netstat -ano columns: Proto  Local Address  Foreign Address  State  PID
    const [, localAddr, , , pid] = cols;
    if (localAddr && localAddr.endsWith(portSuffix) && pid) pids.add(pid);
  }
  return [...pids];
}

function findPidsUnix() {
  try {
    const out = execSync(`lsof -ti tcp:${PORT}`, { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return []; // no listener on that port, or lsof isn't installed
  }
}

const pids = process.platform === 'win32' ? findPidsWindows() : findPidsUnix();

if (pids.length === 0) {
  console.log('claude-monitor is not running');
} else {
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      } else {
        process.kill(Number(pid), 'SIGKILL');
      }
    } catch {
      // process may have already exited between lookup and kill — fine
    }
  }
  console.log('claude-monitor stopped');
}
