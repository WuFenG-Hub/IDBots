/**
 * End-to-end real-host evidence driver for the Sleep Guard.
 *
 * Drives the ALREADY RUNNING isolated dev instance (CDP on 127.0.0.1:9444) to
 * start a REAL cowork session whose first tool call is a long local `sleep`,
 * then samples the guard state and `pmset -g assertions` while that real work
 * runs and after it settles.
 *
 * Read-only with respect to the machine's app data: it only talks to the dev
 * instance's own IPC bridge and shells out to pmset.
 */
const { execFileSync, spawnSync } = require('node:child_process');

const CDP_PORT = Number(process.env.SLEEP_GUARD_CDP_PORT || 9444);
const WORKDIR = process.env.SLEEP_GUARD_CWD || process.cwd();
const SLEEP_SECONDS = Number(process.env.SLEEP_GUARD_SLEEP_SECONDS || 150);
const POLL_MS = 5_000;
const TOTAL_BUDGET_MS = 6 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findRendererTarget() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && /127\.0\.0\.1:\d+\//.test(t.url || '') && t.url.includes('/'));
  if (!page) throw new Error(`no renderer page target on CDP ${CDP_PORT}: ${JSON.stringify(targets.map((t) => [t.type, t.url]))}`);
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error(`ws error: ${e.message || e.type}`)));
    ws.addEventListener('open', () =>
      resolve({
        send(method, params) {
          const msgId = ++id;
          ws.send(JSON.stringify({ id: msgId, method, params }));
          return new Promise((res, rej) => pending.set(msgId, { resolve: res, reject: rej }));
        },
        close: () => ws.close(),
      }),
    );
  });
}

function mainProcessPid() {
  // The Electron MAIN process of the isolated instance: its argv carries our
  // CDP port and the `Contents/MacOS/Electron .` app entry — unlike the Helper
  // (renderer/GPU/utility) processes, and unlike the bash/node wrappers that
  // also have the port in their command line.
  const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  for (const line of out.split('\n')) {
    if (!line.includes(`--remote-debugging-port=${CDP_PORT}`)) continue;
    if (line.includes('Helper')) continue;
    if (!/\/Contents\/MacOS\/Electron\s/.test(line)) continue;
    const pid = Number(line.trim().split(/\s+/)[0]);
    if (Number.isInteger(pid)) {
      console.log(`[e2e] matched main process argv: ${line.trim().slice(0, 160)}`);
      return pid;
    }
  }
  return null;
}

function pmsetAssertions() {
  const text = execFileSync('pmset', ['-g', 'assertions'], { encoding: 'utf8' });
  const lines = text.split('\n');
  const out = [];
  let inOwned = false;
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^Listed by owning process:/i.test(line)) { inOwned = true; current = null; continue; }
    if (/^No kernel assertions/i.test(line) || /^Kernel Assertions/i.test(line)) { inOwned = false; current = null; continue; }
    if (!inOwned) continue;
    const m = line.match(/^pid\s+(\d+)\(([^)]+)\):\s*\[[^\]]*\]\s*\S+\s+(\S+)/);
    if (m) { current = { pid: Number(m[1]), process: m[2], type: m[3], raw: raw.trim(), details: [] }; out.push(current); continue; }
    if (current && /^(Details:|Created for PID:|Timeout will fire|Localized=)/.test(line)) current.details.push(line);
  }
  return out;
}

function guardAssertionFor(watchPid) {
  return pmsetAssertions().find(
    (e) =>
      e.process === 'caffeinate' &&
      e.type === 'PreventUserIdleSystemSleep' &&
      e.details.some((d) => new RegExp(`Created for PID:\\s*${watchPid}\\b`).test(d)),
  );
}

(async () => {
  const target = await findRendererTarget();
  const client = await connect(target.webSocketDebuggerUrl);
  await client.send('Runtime.enable', {});

  const evaluate = async (expression) => {
    const result = await client.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails)}`);
    }
    return result.result.value;
  };

  const readStatus = () => evaluate('window.electron.powerGuard.getStatus()');

  const mainPid = mainProcessPid();
  console.log(`[e2e] renderer target: ${target.url}`);
  console.log(`[e2e] electron main pid: ${mainPid}`);
  console.log(`[e2e] guard status before work: ${JSON.stringify(await readStatus())}`);

  const before = mainPid ? guardAssertionFor(mainPid) : null;
  console.log(`[e2e] pmset assertion for main pid BEFORE work: ${before ? before.raw : '(none)'}`);

  const started = await evaluate(
    `window.electron.cowork.startSession(${JSON.stringify({
      prompt:
        `Run this exact Bash command and nothing else, then reply with only its exit code: sleep ${SLEEP_SECONDS}`,
      cwd: WORKDIR,
      permissionMode: 'bypassPermissions',
    })})`,
  );
  console.log(`[e2e] startSession -> ${JSON.stringify({ success: started?.success, id: started?.session?.id, status: started?.session?.status, error: started?.error })}`);
  const sessionId = started?.session?.id ?? null;

  let engagedShot = null;
  let lastStatus = null;
  const deadline = Date.now() + TOTAL_BUDGET_MS;
  let sawDisengagedAfterWork = null;

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const status = await readStatus();
    lastStatus = status;
    const owned = mainPid ? guardAssertionFor(mainPid) : null;
    console.log(
      `[e2e] ${new Date().toISOString()} guard=${JSON.stringify(status)} assertion=${owned ? `${owned.pid}(${owned.process}) ${owned.type} | ${owned.details.join(' | ')}` : '(none)'}`,
    );
    if (!engagedShot && status.engaged && status.sources.includes('cowork') && owned) {
      engagedShot = { status, owned };
    }
    if (engagedShot && !status.engaged) {
      sawDisengagedAfterWork = status;
      break;
    }
  }

  if (sessionId && lastStatus?.engaged) {
    console.log('[e2e] work still running at budget end; stopping the session to observe release');
    await evaluate(`window.electron.cowork.stopSession(${JSON.stringify(sessionId)})`).catch(() => undefined);
    for (let i = 0; i < 12; i += 1) {
      await sleep(POLL_MS);
      const status = await readStatus();
      const owned = mainPid ? guardAssertionFor(mainPid) : null;
      console.log(`[e2e] (post-stop) guard=${JSON.stringify(status)} assertion=${owned ? owned.raw : '(none)'}`);
      if (!status.engaged) { sawDisengagedAfterWork = status; break; }
    }
  }

  await sleep(1_500);
  const after = mainPid ? guardAssertionFor(mainPid) : null;
  console.log(`[e2e] pmset assertion for main pid AFTER work: ${after ? after.raw : '(none)'}`);
  console.log(`[e2e] final guard status: ${JSON.stringify(await readStatus())}`);

  const ok = Boolean(engagedShot && sawDisengagedAfterWork && !after);
  console.log(
    `\n[e2e] RESULT: ${ok ? 'PASS' : 'FAIL'} — engaged while real work ran: ${Boolean(engagedShot)}; released after work: ${Boolean(sawDisengagedAfterWork)}; assertion gone afterwards: ${!after}`,
  );
  client.close();
  process.exit(ok ? 0 : 1);
})().catch((error) => {
  console.error('[e2e] driver crashed:', error);
  process.exit(1);
});
