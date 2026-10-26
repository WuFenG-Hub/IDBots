#!/usr/bin/env node
/**
 * Frees the Electron dev-server port before `electron:dev` / `electron:dev:dsh` start.
 *
 * A previous dev run can leave orphan processes holding the dev port (e.g. the
 * Electron window was quit while `concurrently` kept the old vite alive, or a
 * crashed run never cleaned up). The next `electron:dev` then fails with
 * "Port 5175 is already in use"; the later "Timed out waiting for Electron dev
 * build" is only downstream noise — vite never started, so dist-electron was
 * never rebuilt after the rimraf.
 *
 * This script kills every process holding the port (the listener plus any
 * stale dev Electron windows still connected to it), waits until the port is
 * actually bindable again, and only then lets the dev chain proceed.
 *
 * Usage: node scripts/kill-dev-port.cjs [port]   (default 5175)
 */

const { execFileSync } = require('node:child_process');
const net = require('node:net');

const port = Number.parseInt(process.argv[2], 10) || 5175;
const TAG = '[kill-dev-port]';

function listPortPids(targetPort) {
  if (process.platform === 'win32') {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/);
      // TCP    127.0.0.1:5175    0.0.0.0:0    LISTENING    1234
      if (cols.length >= 5 && cols[0] === 'TCP' && cols[1].endsWith(`:${targetPort}`)) {
        const pid = Number.parseInt(cols[4], 10);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
    }
    return [...pids];
  }
  let out;
  try {
    // lsof exits 1 when nothing matches — that is the "port is free" case.
    out = execFileSync('lsof', ['-ti', `tcp:${targetPort}`], { encoding: 'utf8' });
  } catch (err) {
    if (err.status === 1 && !String(err.stdout || '').trim()) return [];
    throw err;
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const pid = Number.parseInt(line.trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

function processName(pid) {
  try {
    if (process.platform === 'win32') return '';
    return execFileSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function killPid(pid) {
  if (pid === process.pid) return; // never kill ourselves
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' });
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

function isPortFree(targetPort) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port: targetPort, host: '127.0.0.1' }, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function main() {
  if (await isPortFree(port)) {
    console.log(`${TAG} port ${port} is free`);
    return;
  }

  const pids = listPortPids(port);
  if (pids.length === 0) {
    // Occupied but no holder found (e.g. an IPv6-only listener the lookup
    // missed): fail fast with a clear message instead of letting vite emit
    // its generic "Port already in use" error.
    console.error(`${TAG} port ${port} is in use but no owning process was found; free it manually.`);
    process.exit(1);
  }

  for (const pid of pids) {
    const name = processName(pid);
    console.log(`${TAG} port ${port} in use by pid ${pid}${name ? ` (${name})` : ''} — killing`);
    try {
      killPid(pid);
    } catch (err) {
      console.error(`${TAG} failed to kill pid ${pid}: ${err.message}`);
      process.exit(1);
    }
  }

  // Wait until the port is actually bindable again so the vite started right
  // after this script cannot lose the race against a dying socket.
  const deadline = Date.now() + 5000;
  while (!(await isPortFree(port))) {
    if (Date.now() > deadline) {
      console.error(`${TAG} port ${port} still busy after killing pid(s) ${pids.join(', ')}`);
      process.exit(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`${TAG} port ${port} freed`);
}

main().catch((err) => {
  console.error(`${TAG} ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
