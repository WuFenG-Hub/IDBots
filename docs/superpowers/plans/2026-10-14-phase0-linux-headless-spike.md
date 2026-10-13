# Phase 0 — Linux Headless Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. If those skills are not installed in your environment, execute the tasks in order, tick each checkbox as you finish it, and never skip a verification step.

**Goal:** Measure, on a Hong Kong Alibaba Cloud Linux host, whether the unmodified IDBots desktop backend runs headless in a Docker container, how much memory one user's container really needs, and whether the document, search, scheduling, and chain-write features work on Linux, then return a go/no-go report with numbers.

**Architecture:** Build one Docker image that contains the IDBots repository at a pinned commit plus every system dependency the bundled skills need. Run the stock Electron app inside it under a virtual display (Xvfb) and, separately, under Chromium's headless Ozone platform. Drive the app from inside the container through the Chrome DevTools Protocol (CDP): the harness evaluates `window.electron.*` calls in the real renderer page, so it exercises exactly the IPC surface the future mobile client will use, without changing app code. A sampler records per-process memory throughout, and a density run starts several containers side by side.

**Tech Stack:** Docker 24+ (BuildKit) on Linux x86_64 with cgroup v2; base image `node:24-bookworm`; Electron 41.10.5 (from the repo's `package.json`); pnpm via corepack; Node 24 built-in `fetch`/`WebSocket` for the CDP harness (no npm dependencies); Python 3 venv for document skills; LibreOffice, pandoc, poppler, tesseract, ffmpeg, and Debian Chromium from apt.

## Global Constraints

- Node.js `>=24 <25`; package manager pnpm only, installed with `pnpm install --frozen-lockfile`. Never run `npm install` / `npm ci` for the repository root, `dsh-runtime/`, or `SKILLs/web-search/`.
- Do not modify anything under `src/`, `dsh-runtime/`, `SKILLs/`, or `scripts/`. If the app cannot get past a step without a code change, follow the "App patch policy" below and record the patch.
- All files you create live under `spikes/linux-headless/` on branch `spike/linux-headless`, created from `main`.
- All code comments, docs, logs you write, and the report are in English.
- Use test identities only. Never import a real user's mnemonic, never export any mnemonic, and never write API keys, mnemonics, or session tokens into `spikes/linux-headless/results/`.
- Do not push to `main`. Do not push any branch unless the owner explicitly tells you to (see Task 13 for how results come back).
- Do not post anything on-chain except what Task 9 (S07) and the onboarding in Tasks 5, 11, and 12 do through the app itself.
- Time box: about 4 working days in total. If one scenario stays blocked for more than 4 hours, record it as `FAIL` with evidence and continue with the next independent scenario.

---

## Read This First (context for an agent with no IDBots background)

IDBots is an Electron 41 + React 18 desktop app. The main process (`src/main/`) owns SQLite storage (`idbots.sqlite`), wallets, the agent runtime, scheduled tasks, and roughly 340 IPC handlers. The renderer (`src/renderer/`) talks to it only through `window.electron`, which `src/main/preload.ts` exposes. Each user's AI agents are called **MetaBots**; the first one is the **twin**. The agent loop runs in a child process called the **DSH runtime** (`dsh-runtime/`), spawned with the Electron binary in Node mode. Skills (`SKILLs/`) are folders of instructions plus scripts (Python or Node) that the agent runs through a bash tool.

The product plan is to give every mobile user one always-on container running this backend, reached through a gateway. The design is in `docs/superpowers/specs/2026-10-14-mobile-cloud-design.md`; read its "Current-State Constraints" and "Tenant Server Mode" sections. This spike decides whether that is feasible and sizes it.

Known facts you can rely on:

- Running the repo unpackaged without `NODE_ENV=development` and without `ELECTRON_START_URL` loads the built renderer from `dist/index.html`.
- Env vars the app already honors: `IDBOTS_USER_DATA_PATH` and `IDBOTS_APP_DATA_PATH` (data directory), `IDBOTS_DISABLE_LINUX_SANDBOX=1` (adds `--no-sandbox`), `IDBOTS_DISABLE_GPU=1`, `IDBOTS_FFMPEG_PATH`. On Linux the app always adds `disable-dev-shm-usage`.
- There is no local P2P indexer subprocess any more; indexer reads go to remote MetaID services.
- On a fresh data directory the renderer automatically bootstraps a free LLM provider called `metaid-free` (via `llmRelay.bootstrap`), but creating the twin MetaBot waits for a user click, so the harness does that step.
- Bundled skills are copied into the user data directory on first launch; skills with npm dependencies (for example `pptx`) get a background `npm install --omit=dev` by the app itself. Playwright's Chromium is never downloaded automatically.
- Known headless risks: tray creation (`createTray`) has no error handling; first-run auto-launch registration may log an error; the app quits when all windows close on Linux.

Questions this spike must answer, and where the answer is used:

| # | Question | Scenario | Feeds |
|---|----------|----------|-------|
| Q1 | Does the stock app boot headless in a container, and which display mode works? | S02, S09 | Server mode requirements (WS-A) |
| Q2 | Can a fresh container onboard itself: free LLM provider, twin MetaBot on-chain, traffic account? | S03 | Server-mode bootstrap (WS-A), Metaso per-IP policy (WS-D) |
| Q3 | Do chat turns stream and complete, and is memory stable over 10 turns? | S04 | Gateway timeouts (C2), memory limit (C1) |
| Q4 | Do docx, xlsx, pptx, pdf, web search, and weather work on Linux? | S05 | Tenant image dependencies (WS-C) |
| Q5 | Do scheduled tasks run with no client attached? | S06 | Always-on policy |
| Q6 | Does a traffic-sponsored chain write work from the cloud host? | S07 | Billing (WS-D) |
| Q7 | Does data survive `docker stop`/`start` with an intact database? | S08 | Upgrade and restart runbook (WS-C) |
| Q8 | How much memory per user, idle and peak, and how many users per host? | S04, S05, S10, S11 | Memory limit, host sizing, pricing |
| Q9 | Which outbound endpoints are reachable from the Hong Kong host? | S00 | Egress rules (WS-C) |

### App patch policy

1. First try configuration only: env vars, Chromium switches in `docker/entrypoint.sh`, extra system packages in the `Dockerfile`.
2. If a code change is unavoidable, make the smallest guard possible (for example wrap one call in `try/catch`, or skip it when an env var is set), commit it alone with the message `spike: <what and why>`, and save the diff with `git diff main -- src > spikes/linux-headless/results/app-patches.diff`.
3. List every patch in the report under "Required app changes". These become server-mode requirements; they are not merged from this branch.

### Owner prerequisites (confirm before Task 1)

- [ ] One Hong Kong Alibaba Cloud ECS host: x86_64, at least 8 vCPU / 32 GB RAM, at least 120 GB free disk, Ubuntu 22.04+ or Alibaba Cloud Linux 3, Docker 24+ with BuildKit, cgroup v2, unrestricted outbound HTTPS. Use a dedicated host or one with at least 24 GB free RAM so other workloads do not distort the memory numbers.
- [ ] SSH access for the executing agent with permission to run `docker`.
- [ ] Which commit to test. The default is the latest `origin/main` of `https://github.com/metaid-developers/IDBots` (a public repository). If the owner's local `main` is ahead of `origin/main`, the owner either pushes it first or accepts the older commit; the agent records the exact commit in the report either way.
- [ ] Optional: a DeepSeek API key in `SPIKE_DEEPSEEK_API_KEY`, used only if the free `metaid-free` provider cannot be bootstrapped from the host.
- [ ] Consent that the spike creates up to 7 test MetaBots on-chain through the app's gas subsidy (one each for the main, ozone, and five density containers) and posts one test Buzz.

---

## File Structure

All paths are relative to the repository root.

| Path | Responsibility |
|------|----------------|
| `spikes/linux-headless/README.md` | How to build, run, and reproduce the spike. |
| `spikes/linux-headless/.gitignore` | Keeps raw logs and scratch files out of git. |
| `spikes/linux-headless/Dockerfile` | Tenant-like image: system deps, skills venv, built IDBots. |
| `spikes/linux-headless/Dockerfile.dockerignore` | Build-context exclusions (BuildKit picks it up next to the Dockerfile). |
| `spikes/linux-headless/docker/entrypoint.sh` | Starts Xvfb or Ozone headless, D-Bus, then Electron with CDP enabled. |
| `spikes/linux-headless/harness/cdp.mjs` | Minimal CDP client: find the app page, evaluate functions in it. |
| `spikes/linux-headless/harness/results.mjs` | Result files: scenario records, JSON outputs, the memory phase label. |
| `spikes/linux-headless/harness/idbots.mjs` | App-level helpers: connect, event recorder, onboarding, chat turns, state snapshot. |
| `spikes/linux-headless/harness/run.mjs` | Command-line driver: one command per scenario. |
| `spikes/linux-headless/harness/memsample.mjs` | Background memory sampler (cgroup totals plus per-process PSS by category). |
| `spikes/linux-headless/harness/analyze-memory.mjs` | Summarizes `memory.csv` per phase label. |
| `spikes/linux-headless/scripts/net-check.sh` | Outbound reachability check (runs inside the container). |
| `spikes/linux-headless/scripts/run-density.sh` | Starts N tenant containers on the host and records memory. |
| `spikes/linux-headless/results/` | Outputs, one subdirectory per container plus `density/`. |
| `spikes/linux-headless/PHASE0_REPORT.md` | Final report (template in Task 13). |
| `spikes/linux-headless/results.json` | Machine-readable summary (schema in Task 13). |

Container layout used by every task:

| Inside the container | Purpose |
|----------------------|---------|
| `/opt/idbots` | Repository copy with built `dist/`, `dist-electron/`, and installed dependencies. |
| `/opt/spike` | Read-only mount of `spikes/linux-headless/` from the host (harness and scripts). |
| `/results` | Read-write mount of `spikes/linux-headless/results/<container>/`. |
| `/data` | Named Docker volume `<container>-data`: `userdata/`, `appdata/`, `workspace/`. |

---

### Task 1: Host Readiness and Checkout

**Files:**
- Create: `spikes/linux-headless/results/host.txt`

**Interfaces:**
- Produces: a clone at `~/idbots-phase0` on branch `spike/linux-headless`; the shell variable `SPIKE` (absolute path of `spikes/linux-headless`) used by every later task.

- [ ] **Step 1: Check the host**

```bash
uname -a; nproc; free -m; df -h /var/lib/docker "$HOME"
docker version --format 'server={{.Server.Version}} client={{.Client.Version}}'
docker info --format 'cgroup={{.CgroupVersion}} driver={{.CgroupDriver}} storage={{.Driver}}'
stat -fc %T /sys/fs/cgroup
```

Expected: x86_64, at least 8 CPUs and 32 GB, Docker 24 or newer, `cgroup=2`, and `cgroup2fs`. If cgroup is version 1, continue but note it; the sampler falls back to v1 paths.

- [ ] **Step 2: Clone and branch**

```bash
git clone https://github.com/metaid-developers/IDBots.git ~/idbots-phase0
cd ~/idbots-phase0
git checkout -b spike/linux-headless origin/main
git log -1 --format='%H %cs %s'
```

Expected: the branch is created and the last line prints the commit under test. If the owner named a different commit, use `git checkout -b spike/linux-headless <commit>` instead.

- [ ] **Step 3: Record host facts**

```bash
cd ~/idbots-phase0
export SPIKE="$PWD/spikes/linux-headless"
mkdir -p "$SPIKE/results"
{
  echo "date: $(date -u +%FT%TZ)"
  echo "commit: $(git rev-parse HEAD)"
  echo "kernel: $(uname -r)"
  echo "cpus: $(nproc)"
  free -m
  docker info --format 'docker={{.ServerVersion}} cgroup={{.CgroupVersion}} storage={{.Driver}}'
  cat /etc/os-release | head -3
  curl -s -m 5 http://100.100.100.200/latest/meta-data/instance/instance-type || echo "instance-type: unknown"
} > "$SPIKE/results/host.txt"
cat "$SPIKE/results/host.txt"
```

Expected: the file lists the commit, CPU count, memory, Docker and cgroup versions, and (on Alibaba Cloud) the instance type.

- [ ] **Step 4: Commit**

```bash
git add spikes/linux-headless/results/host.txt
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record phase 0 host facts"
```

---

### Task 2: Spike Image (S01)

**Files:**
- Create: `spikes/linux-headless/README.md`
- Create: `spikes/linux-headless/.gitignore`
- Create: `spikes/linux-headless/Dockerfile`
- Create: `spikes/linux-headless/Dockerfile.dockerignore`
- Create: `spikes/linux-headless/docker/entrypoint.sh`
- Create: `spikes/linux-headless/results/S01-build.txt`

**Interfaces:**
- Produces: local image `idbots-spike:phase0`. Its entrypoint reads `SPIKE_DISPLAY_MODE` (`xvfb` default, or `ozone`) and starts Electron with CDP on `127.0.0.1:9222` inside the container.

- [ ] **Step 1: Write `spikes/linux-headless/.gitignore`**

```gitignore
results/**/*.log
results/**/current-label.txt
results/**/artifacts/**/*.mp4
```

- [ ] **Step 2: Write `spikes/linux-headless/Dockerfile.dockerignore`**

```gitignore
**/node_modules
**/.DS_Store
**/._*
.git
.worktrees
dist
dist-electron
release
logs
output
.cowork-temp
.dev-userdata-*
spikes/linux-headless/results
```

- [ ] **Step 3: Write `spikes/linux-headless/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
# Phase 0 spike image: the stock IDBots desktop backend plus every system
# dependency the bundled skills need on Linux. Build from the repo root:
#   docker build -f spikes/linux-headless/Dockerfile -t idbots-spike:phase0 .
FROM node:24-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PATH=/opt/skills-venv/bin:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb xauth dbus dbus-x11 \
      libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 libxtst6 \
      libatk-bridge2.0-0 libatspi2.0-0 libdrm2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libcups2 libsecret-1-0 \
      libayatana-appindicator3-1 libnotify4 \
      fonts-noto-cjk fonts-liberation \
      ca-certificates curl git bash procps jq file unzip sqlite3 \
      python3 python3-venv python3-pip build-essential \
      pandoc libreoffice-writer libreoffice-calc libreoffice-impress \
      poppler-utils tesseract-ocr tesseract-ocr-chi-sim ffmpeg chromium \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m venv /opt/skills-venv \
 && /opt/skills-venv/bin/pip install --no-cache-dir \
      defusedxml openpyxl pypdf reportlab pdfplumber pypdfium2 pdf2image \
      pytesseract Pillow "markitdown[pptx]" python-docx python-pptx edge-tts \
 && echo 'export PATH=/opt/skills-venv/bin:$PATH' > /etc/profile.d/skills-venv.sh

RUN corepack enable \
 && mkdir -p /opt/idbots /data /results \
 && chown -R node:node /opt/idbots /opt/skills-venv /data /results

WORKDIR /opt/idbots
COPY --chown=node:node . .
USER node
RUN pnpm install --frozen-lockfile
RUN NODE_OPTIONS=--max-old-space-size=8192 pnpm run build \
 && pnpm run compile:electron \
 && pnpm run build:skills

USER root
COPY spikes/linux-headless/docker/entrypoint.sh /usr/local/bin/idbots-entrypoint
RUN chmod 0755 /usr/local/bin/idbots-entrypoint
USER node

ENV IDBOTS_USER_DATA_PATH=/data/userdata \
    IDBOTS_APP_DATA_PATH=/data/appdata \
    IDBOTS_DISABLE_LINUX_SANDBOX=1 \
    IDBOTS_DISABLE_GPU=1 \
    IDBOTS_FFMPEG_PATH=/usr/bin/ffmpeg \
    ELECTRON_ENABLE_LOGGING=1 \
    SPIKE_DISPLAY_MODE=xvfb
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/idbots-entrypoint"]
```

- [ ] **Step 4: Write `spikes/linux-headless/docker/entrypoint.sh`**

```bash
#!/usr/bin/env bash
# Phase 0 spike entrypoint: virtual display or headless Ozone, D-Bus, then the
# stock Electron app with CDP enabled on the container loopback only.
set -euo pipefail

mkdir -p "$IDBOTS_USER_DATA_PATH" "$IDBOTS_APP_DATA_PATH" /data/workspace

flags=(--remote-debugging-port=9222 '--remote-allow-origins=*')
case "${SPIKE_DISPLAY_MODE:-xvfb}" in
  xvfb)
    Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
    export DISPLAY=:99
    for _ in $(seq 1 100); do
      [ -S /tmp/.X11-unix/X99 ] && break
      sleep 0.1
    done
    ;;
  ozone)
    flags+=(--ozone-platform=headless)
    ;;
  *)
    echo "Unknown SPIKE_DISPLAY_MODE=${SPIKE_DISPLAY_MODE}" >&2
    exit 64
    ;;
esac

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
fi

cd /opt/idbots
echo "[spike] starting electron mode=${SPIKE_DISPLAY_MODE:-xvfb} at $(date -u +%FT%TZ)"
exec ./node_modules/electron/dist/electron . "${flags[@]}"
```

- [ ] **Step 5: Write `spikes/linux-headless/README.md`**

```markdown
# Linux Headless Spike (Phase 0)

Measures whether the stock IDBots backend runs headless in a Linux container,
how much memory one user's container needs, and whether skills work on Linux.
The plan is `docs/superpowers/plans/2026-10-14-phase0-linux-headless-spike.md`;
the findings are in `PHASE0_REPORT.md` and `results.json`.

## Build

    docker build -f spikes/linux-headless/Dockerfile -t idbots-spike:phase0 .

## Run one tenant

    SPIKE="$PWD/spikes/linux-headless"
    mkdir -p "$SPIKE/results/main" && chmod 0777 "$SPIKE/results/main"
    docker run -d --init --name spike-main --shm-size=1g \
      -v spike-main-data:/data \
      -v "$SPIKE:/opt/spike:ro" \
      -v "$SPIKE/results/main:/results" \
      idbots-spike:phase0
    docker exec -d spike-main node /opt/spike/harness/memsample.mjs 5000
    docker exec spike-main node /opt/spike/harness/run.mjs boot S02

`SPIKE_DISPLAY_MODE=ozone` switches from Xvfb to Chromium's headless Ozone
platform. `harness/run.mjs` lists every scenario command.
```

- [ ] **Step 6: Build the image and record time and size**

```bash
cd ~/idbots-phase0
chmod +x spikes/linux-headless/docker/entrypoint.sh
start=$(date +%s)
DOCKER_BUILDKIT=1 docker build -f spikes/linux-headless/Dockerfile -t idbots-spike:phase0 . 2>&1 | tee "$SPIKE/results/S01-build.log"
end=$(date +%s)
{
  echo "build_seconds: $((end - start))"
  echo "image_bytes: $(docker image inspect idbots-spike:phase0 --format '{{.Size}}')"
  docker history --no-trunc --format '{{.Size}}\t{{.CreatedBy}}' idbots-spike:phase0 | head -20
} > "$SPIKE/results/S01-build.txt"
cat "$SPIKE/results/S01-build.txt"
```

Expected: the build finishes and `image_bytes` is printed. If `pnpm run build` fails because it needs git metadata, remove the `.git` line from `Dockerfile.dockerignore`, rebuild, and note it in the report. If `pnpm install` fails in a postinstall step, save the last 100 lines of the log in the report and stop: the image is the base for every later task.

- [ ] **Step 7: Check DSH kernel patches and dependency gate inside the image**

```bash
docker run --rm --entrypoint bash idbots-spike:phase0 -c \
  'cd /opt/idbots && node scripts/apply-dsh-kernel-patches.cjs --check && pnpm run check:dsh-deps' \
  2>&1 | tee -a "$SPIKE/results/S01-build.txt"
```

Expected: both commands exit 0. A failure here is a finding (Linux-specific patch or dependency drift); record the output and continue.

- [ ] **Step 8: Commit**

```bash
git add spikes/linux-headless/.gitignore spikes/linux-headless/Dockerfile spikes/linux-headless/Dockerfile.dockerignore spikes/linux-headless/docker/entrypoint.sh spikes/linux-headless/README.md spikes/linux-headless/results/S01-build.txt
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: add linux headless spike image"
```

---

### Task 3: Harness and Cold Boot (S02)

**Files:**
- Create: `spikes/linux-headless/harness/cdp.mjs`
- Create: `spikes/linux-headless/harness/results.mjs`
- Create: `spikes/linux-headless/harness/idbots.mjs`
- Create: `spikes/linux-headless/harness/run.mjs`
- Create: `spikes/linux-headless/harness/memsample.mjs`
- Create: `spikes/linux-headless/harness/analyze-memory.mjs`

**Interfaces:**
- Consumes: image `idbots-spike:phase0` (Task 2).
- Produces, all run inside a container as `node /opt/spike/harness/run.mjs <command> [args]`:
  - `boot <scenarioId>`: waits for the app page and `window.electron`, records boot timing.
  - `onboard [botName]`: provider, workspace, twin MetaBot, traffic account (reads `SPIKE_DEEPSEEK_API_KEY`).
  - `chat`: first turn plus 9 follow-ups in one session.
  - `turn <scenarioId> [prompt]`: one new session, one turn.
  - `skills [skillId]`: the six skill cases, or one of them.
  - `schedule-create` and `schedule-check`: one-shot scheduled task.
  - `chain`: Buzz post through the agent.
  - `state save|compare`: data snapshot before and after restart.
  - `idle <seconds> <label>`: labels a quiet memory window.
- Produces files in `/results`: `scenarios.json` (one object per scenario id), `state.json` (`twinId`, `twinName`, `provider`, `chatSessionId`, `scheduledTaskId`, `scheduledAt`), `memory.csv`, `timeline.log`, and per-scenario subdirectories.
- `memsample.mjs <intervalMs>` appends to `/results/memory.csv`; the phase label comes from `/results/current-label.txt`.

- [ ] **Step 1: Write `spikes/linux-headless/harness/cdp.mjs`**

```js
// Minimal Chrome DevTools Protocol client for the Phase 0 spike.
// Uses Node 24's global fetch and WebSocket, so it needs no npm packages.
const CDP_HTTP = process.env.SPIKE_CDP_HTTP ?? 'http://127.0.0.1:9222';

export async function waitForPageTarget({ timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no targets yet';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CDP_HTTP}/json/list`);
      const targets = await response.json();
      const pages = targets.filter((target) => target.type === 'page');
      const appPage = pages.find((target) => /index\.html/.test(target.url)) ?? pages[0];
      if (appPage?.webSocketDebuggerUrl) return appPage;
      lastError = `pages=${JSON.stringify(pages.map((page) => page.url))}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`No IDBots page target within ${timeoutMs}ms: ${lastError}`);
}

export class CdpSession {
  #ws;
  #nextId = 1;
  #pending = new Map();

  static async connect(wsUrl) {
    const session = new CdpSession();
    session.#ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      session.#ws.addEventListener('open', resolve, { once: true });
      session.#ws.addEventListener('error', () => reject(new Error(`CDP connect failed: ${wsUrl}`)), { once: true });
    });
    session.#ws.addEventListener('message', (event) => session.#onMessage(event));
    session.#ws.addEventListener('close', () => {
      for (const { reject } of session.#pending.values()) reject(new Error('CDP socket closed'));
      session.#pending.clear();
    });
    return session;
  }

  #onMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id === undefined) return;
    const entry = this.#pending.get(message.id);
    if (!entry) return;
    this.#pending.delete(message.id);
    if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
    else entry.resolve(message.result);
  }

  send(method, params = {}) {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  // fn runs in the page, so it must not reference variables from this module;
  // pass data through the JSON-serializable arg instead.
  async evaluate(fn, arg) {
    const expression = `(${fn.toString()})(${JSON.stringify(arg ?? null)})`;
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(`Page exception: ${details.exception?.description ?? details.text}`);
    }
    return result.result.value;
  }

  close() {
    this.#ws.close();
  }
}
```

- [ ] **Step 2: Write `spikes/linux-headless/harness/results.mjs`**

```js
// Result-file helpers shared by the spike driver and the memory sampler.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const RESULTS_DIR = process.env.SPIKE_RESULTS_DIR ?? '/results';

export function setLabel(label) {
  mkdirSync(RESULTS_DIR, { recursive: true });
  writeFileSync(join(RESULTS_DIR, 'current-label.txt'), label);
  appendFileSync(join(RESULTS_DIR, 'timeline.log'), `${new Date().toISOString()} ${label}\n`);
}

export function writeJson(name, value) {
  const path = join(RESULTS_DIR, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

export function readJson(name, fallback) {
  const path = join(RESULTS_DIR, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

export function recordScenario(id, data) {
  const all = readJson('scenarios.json', {});
  all[id] = { ...(all[id] ?? {}), ...data, recordedAt: new Date().toISOString() };
  writeJson('scenarios.json', all);
}
```

- [ ] **Step 3: Write `spikes/linux-headless/harness/idbots.mjs`**

```js
// App-level helpers: every function passed to cdp.evaluate runs inside the
// IDBots renderer and calls the same window.electron API the UI uses.
import { CdpSession, waitForPageTarget } from './cdp.mjs';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(cdp, predicate, { arg = null, timeoutMs = 60_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await cdp.evaluate(predicate, arg);
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms (last=${JSON.stringify(last)})`);
}

function installRecorder() {
  if (window.__spike) return 'already-installed';
  const state = { events: [], firstUpdateAt: {}, updateCount: {} };
  const cowork = window.electron.cowork;
  cowork.onStreamMessage(({ sessionId, message }) => {
    state.events.push({ type: 'message', at: Date.now(), sessionId, messageType: message?.type ?? null });
  });
  cowork.onStreamMessageUpdate(({ sessionId }) => {
    if (!state.firstUpdateAt[sessionId]) state.firstUpdateAt[sessionId] = Date.now();
    state.updateCount[sessionId] = (state.updateCount[sessionId] ?? 0) + 1;
  });
  cowork.onStreamComplete(({ sessionId }) => {
    state.events.push({ type: 'complete', at: Date.now(), sessionId });
  });
  cowork.onStreamError(({ sessionId, error }) => {
    state.events.push({ type: 'error', at: Date.now(), sessionId, error: String(error).slice(0, 2000) });
  });
  cowork.onStreamPermission(async ({ sessionId, request }) => {
    state.events.push({ type: 'permission', at: Date.now(), sessionId, toolName: request?.toolName ?? null });
    await cowork.respondToPermission({ requestId: request.requestId, result: { behavior: 'allow' } });
  });
  window.electron.scheduledTasks.onRunUpdate((data) => {
    state.events.push({ type: 'scheduledRun', at: Date.now(), data: JSON.parse(JSON.stringify(data ?? null)) });
  });
  window.__spike = state;
  return 'installed';
}

export async function connect({ timeoutMs = 180_000 } = {}) {
  const startedAt = Date.now();
  const target = await waitForPageTarget({ timeoutMs });
  const cdp = await CdpSession.connect(target.webSocketDebuggerUrl);
  await waitFor(cdp, () => typeof window.electron?.cowork?.startSession === 'function', { timeoutMs });
  const recorder = await cdp.evaluate(installRecorder);
  return { cdp, connectMs: Date.now() - startedAt, targetUrl: target.url, recorder };
}

export function summarizeTurn(turn) {
  const { messages, ...rest } = turn;
  return rest;
}

async function fetchSessionMessages(cdp, sessionId) {
  return cdp.evaluate(async (sid) => {
    const response = await window.electron.cowork.getSession(sid, { messageLimit: 500 });
    const session = response?.session;
    if (!session) return { status: null, messages: [] };
    return {
      status: session.status,
      messages: session.messages.map((message) => ({
        type: message.type,
        content: String(message.content ?? '').slice(0, 4000),
        toolName: message.metadata?.toolName ?? message.metadata?.name ?? null,
        isError: Boolean(message.metadata?.isError ?? message.metadata?.error),
      })),
    };
  }, sessionId);
}

export async function runChatTurn(cdp, { prompt, metabotId, title, timeoutMs = 600_000 }) {
  const startedAt = Date.now();
  const start = await cdp.evaluate(async (opts) => {
    const response = await window.electron.cowork.startSession({
      prompt: opts.prompt,
      metabotId: opts.metabotId,
      title: opts.title,
      cwd: '/data/workspace',
      permissionMode: 'bypassPermissions',
    });
    return { success: response?.success ?? false, sessionId: response?.session?.id ?? null, error: response?.error ?? null };
  }, { prompt, metabotId, title });
  const startReturnedMs = Date.now() - startedAt;
  if (!start.success || !start.sessionId) {
    return { ok: false, phase: 'start', error: start.error, startReturnedMs, reply: '', toolCalls: [], toolErrors: [], messages: [] };
  }
  let outcome;
  try {
    outcome = await waitFor(cdp, (sid) => {
      const state = window.__spike;
      const done = state.events.find((event) => event.sessionId === sid && (event.type === 'complete' || event.type === 'error'));
      if (!done) return null;
      const firstAssistant = state.events.find((event) => event.sessionId === sid && event.type === 'message' && event.messageType === 'assistant');
      const candidates = [state.firstUpdateAt[sid], firstAssistant?.at].filter(Boolean);
      return {
        type: done.type,
        at: done.at,
        error: done.error ?? null,
        firstOutputAt: candidates.length ? Math.min(...candidates) : null,
        updates: state.updateCount[sid] ?? 0,
      };
    }, { arg: start.sessionId, timeoutMs, intervalMs: 1000 });
  } catch (error) {
    outcome = { type: 'timeout', at: Date.now(), error: error.message, firstOutputAt: null, updates: 0 };
  }
  const session = await fetchSessionMessages(cdp, start.sessionId);
  const lastAssistant = [...session.messages].reverse().find((message) => message.type === 'assistant');
  return {
    ok: outcome.type === 'complete',
    sessionId: start.sessionId,
    outcome: outcome.type,
    error: outcome.error,
    startReturnedMs,
    ttftMs: outcome.firstOutputAt ? outcome.firstOutputAt - startedAt : null,
    totalMs: outcome.at - startedAt,
    streamUpdates: outcome.updates,
    sessionStatus: session.status,
    reply: lastAssistant?.content ?? '',
    toolCalls: session.messages.filter((message) => message.type === 'tool_use').map((message) => message.toolName),
    toolErrors: session.messages.filter((message) => message.type === 'tool_result' && message.isError).map((message) => message.content.slice(0, 1000)),
    messages: session.messages,
  };
}

export async function runFollowUp(cdp, { sessionId, text, timeoutMs = 600_000 }) {
  const before = await cdp.evaluate(
    (sid) => window.__spike.events.filter((event) => event.sessionId === sid && (event.type === 'complete' || event.type === 'error')).length,
    sessionId,
  );
  const startedAt = Date.now();
  const submit = await cdp.evaluate(async (opts) => {
    const response = await window.electron.cowork.submitInput({
      sessionId: opts.sessionId,
      submissionId: crypto.randomUUID(),
      text: opts.text,
    });
    return JSON.parse(JSON.stringify(response ?? null));
  }, { sessionId, text });
  let outcome;
  try {
    outcome = await waitFor(cdp, (opts) => {
      const done = window.__spike.events.filter((event) => event.sessionId === opts.sessionId && (event.type === 'complete' || event.type === 'error'));
      return done.length > opts.before ? done[done.length - 1] : null;
    }, { arg: { sessionId, before }, timeoutMs });
  } catch (error) {
    outcome = { type: 'timeout', at: Date.now(), error: error.message };
  }
  return { ok: outcome.type === 'complete', outcome: outcome.type, totalMs: outcome.at - startedAt, error: outcome.error ?? null, submit };
}

export async function onboard(cdp, { botName, deepseekApiKey }) {
  const startedAt = Date.now();
  const steps = {};

  steps.uiBootstrap = await waitFor(cdp, async () => {
    const config = await window.electron.store.get('app_config');
    const free = config?.providers?.['metaid-free'];
    return free?.apiKey ? { provider: 'metaid-free', model: free.models?.[0]?.id ?? null } : null;
  }, { timeoutMs: 90_000, intervalMs: 3000 }).catch((error) => ({ error: error.message }));
  let provider = steps.uiBootstrap?.provider ? steps.uiBootstrap : null;

  if (!provider) {
    steps.manualBootstrap = await cdp.evaluate(async () => {
      const response = await window.electron.llmRelay.bootstrap();
      if (!response?.success || !response.result) return { error: response?.error ?? 'bootstrap failed' };
      const config = (await window.electron.store.get('app_config')) ?? {};
      const models = (response.result.models ?? []).map((model) => {
        const id = typeof model === 'string' ? model : model.id;
        return { id, name: id };
      });
      await window.electron.store.set('app_config', {
        ...config,
        providers: {
          ...(config.providers ?? {}),
          'metaid-free': {
            enabled: true,
            apiKey: response.result.apiKey,
            baseUrl: response.result.baseUrl,
            apiFormat: 'openai',
            models,
            name: 'IDBots-Free',
          },
        },
        model: { ...(config.model ?? {}), defaultModel: models[0]?.id, defaultProvider: 'metaid-free' },
      });
      return { provider: 'metaid-free', model: models[0]?.id ?? null, quotaRemaining: response.result.quotaRemaining ?? null };
    });
    if (steps.manualBootstrap?.provider) provider = steps.manualBootstrap;
  }

  if (!provider && deepseekApiKey) {
    steps.deepseekFallback = await cdp.evaluate(async (key) => {
      const config = (await window.electron.store.get('app_config')) ?? {};
      const existing = config.providers?.deepseek ?? {};
      const models = existing.models?.length ? existing.models : [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' }];
      await window.electron.store.set('app_config', {
        ...config,
        providers: {
          ...(config.providers ?? {}),
          deepseek: { baseUrl: 'https://api.deepseek.com', apiFormat: 'openai', ...existing, models, enabled: true, apiKey: key },
        },
        model: { ...(config.model ?? {}), defaultModel: models[0].id, defaultProvider: 'deepseek' },
      });
      return { provider: 'deepseek', model: models[0].id };
    }, deepseekApiKey);
    provider = steps.deepseekFallback;
  }
  if (!provider) return { ok: false, steps, error: 'no LLM provider available', durationMs: Date.now() - startedAt };

  steps.workspace = await cdp.evaluate(async () => {
    const response = await window.electron.cowork.setConfig({ workingDirectory: '/data/workspace' });
    return JSON.parse(JSON.stringify(response ?? null));
  });

  let twin = await cdp.evaluate(async () => {
    const response = await window.electron.metabot.list();
    const found = (response?.list ?? []).find((metabot) => metabot.metabot_type === 'twin');
    return found ? { id: found.id, name: found.name, reused: true } : null;
  });

  if (!twin) {
    steps.createTwin = await cdp.evaluate(async (opts) => {
      const response = await window.electron.idbots.createMetaBotOnChain({
        name: opts.botName,
        metabot_type: 'twin',
        role: 'On-chain AI companion',
        soul: 'Helpful, concise, and careful.',
        goal: 'Help the owner with everyday tasks.',
        bio: 'Linux headless spike test bot.',
        llm_id: opts.model,
        llm_provider: opts.provider,
      });
      return {
        success: response?.success ?? false,
        metabotId: response?.metabot?.id ?? null,
        subsidy: JSON.parse(JSON.stringify(response?.subsidy ?? null)),
        chainPartial: response?.chainPartial ?? null,
        chainSetupPending: response?.chainSetupPending ?? null,
        chainError: response?.chainError ?? null,
        error: response?.error ?? null,
      };
    }, { botName, model: provider.model, provider: provider.provider });
    steps.createTwin.durationMs = Date.now() - startedAt;
    if (steps.createTwin.metabotId) twin = { id: steps.createTwin.metabotId, name: botName, reused: false };
  }

  steps.traffic = await cdp.evaluate(async () => {
    const out = {};
    const calls = [
      ['ensureAccount', () => window.electron.traffic.ensureAccount()],
      ['claimFreeGrant', () => window.electron.traffic.claimFreeGrant()],
      ['getBalance', () => window.electron.traffic.getBalance({ forceRefresh: true })],
    ];
    for (const [name, call] of calls) {
      try {
        out[name] = JSON.parse(JSON.stringify((await call()) ?? null));
      } catch (error) {
        out[name] = { thrown: String(error) };
      }
    }
    return out;
  });

  return { ok: Boolean(twin), twin, provider, steps, durationMs: Date.now() - startedAt };
}

export async function snapshotState(cdp) {
  return cdp.evaluate(async () => {
    const metabots = await window.electron.metabot.list();
    const sessions = await window.electron.cowork.listSessions();
    const tasks = await window.electron.scheduledTasks.list();
    const config = await window.electron.store.get('app_config');
    return {
      metabots: (metabots?.list ?? []).map((metabot) => ({ id: metabot.id, name: metabot.name, type: metabot.metabot_type })).sort((a, b) => a.id - b.id),
      sessionIds: (sessions?.sessions ?? []).map((session) => session.id).sort(),
      scheduledTaskIds: (tasks?.tasks ?? []).map((task) => task.id).sort(),
      defaultProvider: config?.model?.defaultProvider ?? null,
    };
  });
}
```

- [ ] **Step 4: Write `spikes/linux-headless/harness/run.mjs`**

```js
#!/usr/bin/env node
// Phase 0 spike driver. Runs inside a tenant container via `docker exec`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { connect, onboard, runChatTurn, runFollowUp, sleep, snapshotState, summarizeTurn } from './idbots.mjs';
import { readJson, recordScenario, setLabel, writeJson } from './results.mjs';

const [command, ...args] = process.argv.slice(2);
const state = readJson('state.json', {});
const saveState = () => writeJson('state.json', state);

const SKILL_CASES = [
  {
    id: 'docx',
    file: '/data/workspace/spike/docx/report.docx',
    prompt: '请使用 docx 技能，在 /data/workspace/spike/docx/report.docx 生成一个 Word 文档：标题为“Linux 无头验证”，包含一段中文说明和一个 3 行 2 列的表格。完成后只回复文件的绝对路径。',
    verify: "import docx, sys\nd = docx.Document(sys.argv[1])\nt = ' '.join(p.text for p in d.paragraphs)\nassert '验证' in t, t[:200]\nassert len(d.tables) >= 1, 'no table'\nprint('ok tables=%d' % len(d.tables))",
  },
  {
    id: 'xlsx',
    file: '/data/workspace/spike/xlsx/sales.xlsx',
    prompt: '请使用 xlsx 技能，在 /data/workspace/spike/xlsx/sales.xlsx 生成一个表格：A2 到 A6 为 1 到 5 月，B2 到 B6 为销售额，B7 单元格用公式求和。完成后只回复文件的绝对路径。',
    verify: "import openpyxl, sys\nws = openpyxl.load_workbook(sys.argv[1]).active\nf = [c.value for row in ws.iter_rows() for c in row if isinstance(c.value, str) and c.value.startswith('=')]\nassert f, 'no formula'\nprint('ok formulas=%d' % len(f))",
  },
  {
    id: 'pptx',
    file: '/data/workspace/spike/pptx/deck.pptx',
    prompt: '请使用 pptx 技能，在 /data/workspace/spike/pptx/deck.pptx 生成一个 3 页的演示文稿，主题是“IDBots 云端化”，每页有中文标题。完成后只回复文件的绝对路径。',
    verify: "from pptx import Presentation\nimport sys\nn = len(Presentation(sys.argv[1]).slides)\nassert n >= 3, n\nprint('ok slides=%d' % n)",
  },
  {
    id: 'pdf',
    file: '/data/workspace/spike/pdf/note.pdf',
    prompt: '请使用 pdf 技能，在 /data/workspace/spike/pdf/note.pdf 生成一个 PDF，正文包含中文句子“云端验证通过”。然后读取这个 PDF 的文字确认内容。完成后只回复文件的绝对路径。',
    verify: "import pypdf, sys\nr = pypdf.PdfReader(sys.argv[1])\nt = ''.join((p.extract_text() or '') for p in r.pages).replace(' ', '')\nassert '云端验证通过' in t, t[:200]\nprint('ok pages=%d' % len(r.pages))",
  },
  {
    id: 'web-search',
    prompt: '请使用 web-search 技能搜索“DeepSeek 最新消息”，给出 3 条结果，每条包含标题和链接。',
    verifyReply: (reply) => (reply.match(/https?:\/\/\S+/g) ?? []).length >= 2,
  },
  {
    id: 'weather',
    prompt: '请查询香港今天的天气，告诉我气温。',
    verifyReply: (reply) => /°C|℃|度/.test(reply),
  },
];

function requireTwin() {
  if (!state.twinId) throw new Error('No twin in /results/state.json; run onboard first');
}

function containerUptimeSeconds() {
  return Number(execFileSync('ps', ['-o', 'etimes=', '-p', '1'], { encoding: 'utf8' }).trim());
}

function findPptxNodeModules() {
  const out = execFileSync('bash', ['-c', "find /data -maxdepth 6 -type d -path '*/SKILLs/pptx/node_modules' 2>/dev/null | head -1"], { encoding: 'utf8' });
  return out.trim() || null;
}

function verifySkill(skillCase, turn) {
  if (!turn.ok) return { verified: false, verifyDetail: `turn ${turn.outcome}: ${turn.error}` };
  if (skillCase.file) {
    if (!existsSync(skillCase.file)) return { verified: false, verifyDetail: `missing ${skillCase.file}` };
    try {
      const out = execFileSync('python3', ['-c', skillCase.verify, skillCase.file], { encoding: 'utf8', timeout: 120_000 });
      return { verified: true, verifyDetail: out.trim(), fileBytes: statSync(skillCase.file).size };
    } catch (error) {
      return { verified: false, verifyDetail: String(error.stderr || error.message).slice(0, 2000) };
    }
  }
  return { verified: skillCase.verifyReply(turn.reply), verifyDetail: turn.reply.slice(0, 500) };
}

async function cmdBoot() {
  const scenario = args[0] ?? 'S02';
  setLabel(`${scenario}:boot`);
  const { cdp, connectMs, targetUrl, recorder } = await connect();
  const info = await cdp.evaluate(async () => ({
    version: JSON.parse(JSON.stringify(await window.electron.appInfo.getVersion())),
    userAgent: navigator.userAgent,
  }));
  const result = { ok: true, readyAfterContainerStartSec: containerUptimeSeconds(), harnessConnectMs: connectMs, targetUrl, recorder, ...info };
  recordScenario(scenario, result);
  setLabel('idle');
  console.log(JSON.stringify(result, null, 2));
  cdp.close();
}

async function cmdOnboard() {
  const scenario = process.env.SPIKE_SCENARIO ?? 'S03';
  setLabel(`${scenario}:onboard`);
  const { cdp } = await connect();
  const botName = args[0] ?? `Spike${Date.now().toString(36).slice(-6)}`;
  const result = await onboard(cdp, { botName, deepseekApiKey: process.env.SPIKE_DEEPSEEK_API_KEY ?? '' });
  if (result.twin) {
    state.twinId = result.twin.id;
    state.twinName = result.twin.name;
    state.provider = result.provider;
    saveState();
  }
  recordScenario(scenario, result);
  setLabel('idle');
  console.log(JSON.stringify(result, null, 2));
  cdp.close();
}

async function cmdChat() {
  requireTwin();
  setLabel('S04:first-turn');
  const { cdp } = await connect();
  const first = await runChatTurn(cdp, {
    metabotId: state.twinId,
    title: 'spike-chat',
    prompt: '你好！请用一句话介绍你自己，并告诉我 17 乘以 23 等于多少。',
  });
  writeJson('S04/first-turn-messages.json', first.messages);
  state.chatSessionId = first.sessionId;
  saveState();
  const turns = [{ turn: 1, ...summarizeTurn(first) }];
  setLabel('S04:loop');
  for (let index = 2; index <= 10 && first.ok; index += 1) {
    const next = await runFollowUp(cdp, {
      sessionId: first.sessionId,
      text: `第 ${index} 轮：请写一首四行的短诗，主题是“云端第 ${index} 天”。`,
    });
    turns.push({ turn: index, ...next });
  }
  setLabel('idle');
  const result = { ok: turns.length === 10 && turns.every((turn) => turn.ok), correctMath: /391/.test(first.reply), turns };
  recordScenario('S04', result);
  console.log(JSON.stringify(result, null, 2));
  cdp.close();
}

async function cmdTurn() {
  requireTwin();
  const scenario = args[0] ?? 'turn';
  const prompt = args[1] ?? '请用三句话解释什么是区块链。';
  setLabel(`${scenario}:turn`);
  const { cdp } = await connect();
  const turn = await runChatTurn(cdp, { metabotId: state.twinId, title: `spike-${scenario}`, prompt });
  setLabel('idle');
  recordScenario(scenario, summarizeTurn(turn));
  console.log(JSON.stringify(summarizeTurn(turn), null, 2));
  cdp.close();
}

async function cmdSkills() {
  requireTwin();
  const only = args[0];
  const { cdp } = await connect();
  const results = readJson('S05/skills.json', {});
  const cases = SKILL_CASES.filter((skillCase) => !only || skillCase.id === only);
  for (const skillCase of cases) {
    const pptxNodeModules = skillCase.id === 'pptx' ? findPptxNodeModules() : undefined;
    setLabel(`S05:${skillCase.id}`);
    const turn = await runChatTurn(cdp, {
      metabotId: state.twinId,
      title: `spike-skill-${skillCase.id}`,
      prompt: skillCase.prompt,
      timeoutMs: 15 * 60_000,
    });
    setLabel('idle');
    results[skillCase.id] = { ...summarizeTurn(turn), ...verifySkill(skillCase, turn), pptxNodeModules };
    writeJson(`S05/${skillCase.id}-messages.json`, turn.messages);
    writeJson('S05/skills.json', results);
    console.log(skillCase.id, JSON.stringify({ verified: results[skillCase.id].verified, detail: results[skillCase.id].verifyDetail }));
    await sleep(30_000);
  }
  recordScenario('S05', { ok: SKILL_CASES.every((skillCase) => results[skillCase.id]?.verified), results });
  cdp.close();
}

async function cmdScheduleCreate() {
  requireTwin();
  const { cdp } = await connect();
  const when = new Date(Date.now() + 2 * 60_000).toISOString();
  const created = await cdp.evaluate(async (opts) => {
    const response = await window.electron.scheduledTasks.create({
      name: 'spike-once',
      description: 'Phase 0 background run',
      enabled: true,
      schedule: { type: 'at', datetime: opts.when },
      prompt: '在 /data/workspace/spike/schedule/done.txt 写入当前 UTC 时间（如目录不存在先创建），然后只回复 DONE。',
      workingDirectory: '/data/workspace',
      systemPrompt: '',
      executionMode: 'local',
      metabotId: opts.metabotId,
      expiresAt: null,
      notifyPlatforms: [],
    });
    return { success: response?.success ?? false, task: JSON.parse(JSON.stringify(response?.task ?? null)), error: response?.error ?? null };
  }, { when, metabotId: state.twinId });
  state.scheduledTaskId = created.task?.id ?? null;
  state.scheduledAt = when;
  saveState();
  recordScenario('S06', { created, scheduledAt: when });
  console.log(JSON.stringify(created, null, 2));
  cdp.close();
}

async function cmdScheduleCheck() {
  if (!state.scheduledTaskId) throw new Error('No scheduledTaskId in state.json; run schedule-create first');
  const { cdp } = await connect();
  const runs = await cdp.evaluate(async (taskId) => {
    const response = await window.electron.scheduledTasks.listRuns(taskId, 10, 0);
    return JSON.parse(JSON.stringify(response?.runs ?? []));
  }, state.scheduledTaskId);
  const file = '/data/workspace/spike/schedule/done.txt';
  const fileExists = existsSync(file);
  const result = {
    ok: fileExists && runs.length > 0,
    fileExists,
    fileContent: fileExists ? readFileSync(file, 'utf8').slice(0, 200) : null,
    runs,
    scheduledAt: state.scheduledAt,
    checkedAt: new Date().toISOString(),
  };
  recordScenario('S06', result);
  console.log(JSON.stringify(result, null, 2));
  cdp.close();
}

async function cmdChain() {
  requireTwin();
  setLabel('S07:chain');
  const { cdp } = await connect();
  const before = await cdp.evaluate(async () => JSON.parse(JSON.stringify(await window.electron.traffic.getBalance({ forceRefresh: true }))));
  const turn = await runChatTurn(cdp, {
    metabotId: state.twinId,
    title: 'spike-chain',
    prompt: `请发一条 Buzz（链上动态），内容是：“IDBots Linux 云端无头测试 ${new Date().toISOString()}”。发布成功后告诉我交易 ID 或 PIN ID。`,
    timeoutMs: 10 * 60_000,
  });
  setLabel('idle');
  const haystack = [turn.reply, ...turn.messages.map((message) => message.content)].join('\n');
  const pinIds = [...new Set(haystack.match(/\b[0-9a-f]{64}i\d+\b/g) ?? [])];
  const txids = [...new Set(haystack.match(/\b[0-9a-f]{64}\b/g) ?? [])];
  const after = await cdp.evaluate(async () => JSON.parse(JSON.stringify(await window.electron.traffic.getBalance({ forceRefresh: true }))));
  writeJson('S07/messages.json', turn.messages);
  const result = { ...summarizeTurn(turn), ok: turn.ok && (pinIds.length > 0 || txids.length > 0), pinIds, txids: txids.slice(0, 5), trafficBefore: before, trafficAfter: after };
  recordScenario('S07', result);
  console.log(JSON.stringify(result, null, 2));
  cdp.close();
}

async function cmdState() {
  const mode = args[0] ?? 'save';
  const { cdp } = await connect();
  const snapshot = await snapshotState(cdp);
  if (mode === 'save') {
    writeJson('S08/pre-restart.json', snapshot);
  } else {
    const pre = readJson('S08/pre-restart.json', null);
    recordScenario('S08', { ok: Boolean(pre) && JSON.stringify(pre) === JSON.stringify(snapshot), pre, post: snapshot });
  }
  console.log(JSON.stringify(snapshot, null, 2));
  cdp.close();
}

async function cmdIdle() {
  const seconds = Number(args[0] ?? 300);
  const label = args[1] ?? 'idle';
  setLabel(label);
  await sleep(seconds * 1000);
  setLabel('idle');
  console.log(`idle ${label} ${seconds}s done`);
}

const commands = {
  boot: cmdBoot,
  onboard: cmdOnboard,
  chat: cmdChat,
  turn: cmdTurn,
  skills: cmdSkills,
  'schedule-create': cmdScheduleCreate,
  'schedule-check': cmdScheduleCheck,
  chain: cmdChain,
  state: cmdState,
  idle: cmdIdle,
};

const handler = commands[command];
if (!handler) {
  console.error(`Usage: run.mjs <${Object.keys(commands).join('|')}> [args]`);
  process.exit(64);
}
handler().then(
  () => process.exit(0),
  (error) => {
    console.error(error?.stack ?? String(error));
    process.exit(1);
  },
);
```

- [ ] **Step 5: Write `spikes/linux-headless/harness/memsample.mjs`**

```js
#!/usr/bin/env node
// Background memory sampler. Writes one CSV row per interval with the
// container cgroup totals and per-process PSS summed by category.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const RESULTS_DIR = process.env.SPIKE_RESULTS_DIR ?? '/results';
const OUT = `${RESULTS_DIR}/memory.csv`;
const intervalMs = Number(process.argv[2] ?? 5000);
const CATEGORIES = [
  'electron-main', 'renderer', 'gpu', 'utility', 'zygote', 'dsh-runtime', 'node-child',
  'xvfb', 'chromium', 'soffice', 'python', 'spike-tooling', 'other',
];

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function cgroupCurrentBytes() {
  const v2 = readText('/sys/fs/cgroup/memory.current');
  if (v2) return Number(v2.trim());
  const v1 = readText('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  return v1 ? Number(v1.trim()) : 0;
}

function cgroupStat() {
  const text = readText('/sys/fs/cgroup/memory.stat') ?? readText('/sys/fs/cgroup/memory/memory.stat') ?? '';
  const stat = {};
  for (const line of text.split('\n')) {
    const [key, value] = line.split(' ');
    if (key) stat[key] = Number(value);
  }
  return { anon: stat.anon ?? stat.rss ?? 0, file: stat.file ?? stat.cache ?? 0 };
}

function classify(cmd) {
  if (cmd.includes('/opt/spike/')) return 'spike-tooling';
  if (cmd.includes('dsh-runtime')) return 'dsh-runtime';
  if (/(^|\/)Xvfb\b/.test(cmd)) return 'xvfb';
  if (cmd.includes('soffice')) return 'soffice';
  if (/(^|\/|\s)python3?(\s|$)/.test(cmd) || cmd.includes('/opt/skills-venv/')) return 'python';
  if (/chromium|chrome-linux|headless_shell/.test(cmd)) return 'chromium';
  if (cmd.includes('electron/dist/electron')) {
    if (cmd.includes('--type=renderer')) return 'renderer';
    if (cmd.includes('--type=gpu-process')) return 'gpu';
    if (cmd.includes('--type=utility')) return 'utility';
    if (cmd.includes('--type=zygote')) return 'zygote';
    if (/\.(c|m)?js(\s|$)/.test(cmd)) return 'node-child';
    return 'electron-main';
  }
  if (/(^|\/)node(\s|$)/.test(cmd)) return 'node-child';
  return 'other';
}

function pssKb(pid) {
  const rollup = readText(`/proc/${pid}/smaps_rollup`);
  const pss = rollup?.match(/^Pss:\s+(\d+) kB/m);
  if (pss) return Number(pss[1]);
  const rss = readText(`/proc/${pid}/status`)?.match(/^VmRSS:\s+(\d+) kB/m);
  return rss ? Number(rss[1]) : 0;
}

function sample() {
  const pss = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  const count = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const cmd = (readText(`/proc/${entry}/cmdline`) ?? '').split('\0').join(' ').trim();
    if (!cmd) continue;
    const category = classify(cmd);
    pss[category] += pssKb(entry);
    count[category] += 1;
  }
  const { anon, file } = cgroupStat();
  const label = readText(`${RESULTS_DIR}/current-label.txt`)?.trim() ?? '';
  const row = [
    new Date().toISOString(),
    label,
    (cgroupCurrentBytes() / 1048576).toFixed(1),
    (anon / 1048576).toFixed(1),
    (file / 1048576).toFixed(1),
    ...CATEGORIES.map((category) => (pss[category] / 1024).toFixed(1)),
    ...CATEGORIES.map((category) => count[category]),
  ];
  appendFileSync(OUT, `${row.join(',')}\n`);
}

if (!existsSync(OUT)) {
  const header = [
    'ts', 'label', 'cgroup_current_mb', 'cgroup_anon_mb', 'cgroup_file_mb',
    ...CATEGORIES.map((category) => `pss_${category}_mb`),
    ...CATEGORIES.map((category) => `n_${category}`),
  ];
  writeFileSync(OUT, `${header.join(',')}\n`);
}
sample();
setInterval(sample, intervalMs);
```

- [ ] **Step 6: Write `spikes/linux-headless/harness/analyze-memory.mjs`**

```js
#!/usr/bin/env node
// Summarizes memory.csv per phase label. Usage: analyze-memory.mjs <resultsDir>
import { readFileSync, writeFileSync } from 'node:fs';

const dir = process.argv[2] ?? '/results';
const lines = readFileSync(`${dir}/memory.csv`, 'utf8').trim().split('\n');
const header = lines[0].split(',');
const rows = lines.slice(1).map((line) => Object.fromEntries(line.split(',').map((value, index) => [header[index], index < 2 ? value : Number(value)])));
const pssColumns = header.filter((column) => column.startsWith('pss_'));
const average = (values) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const round = (value) => Math.round(value * 10) / 10;

const groups = new Map();
for (const row of rows) {
  const key = row.label || '(none)';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const summary = {};
for (const [label, group] of groups) {
  const appEstimate = group.map((row) => row.cgroup_current_mb - row['pss_spike-tooling_mb']);
  summary[label] = {
    samples: group.length,
    appEstimateAvgMb: round(average(appEstimate)),
    appEstimatePeakMb: round(Math.max(...appEstimate)),
    cgroupPeakMb: round(Math.max(...group.map((row) => row.cgroup_current_mb))),
    anonAvgMb: round(average(group.map((row) => row.cgroup_anon_mb))),
    pssAvgMb: Object.fromEntries(pssColumns.map((column) => [column.slice(4, -3), round(average(group.map((row) => row[column])))])),
  };
}

writeFileSync(`${dir}/memory-summary.json`, JSON.stringify(summary, null, 2));
console.table(Object.fromEntries(Object.entries(summary).map(([label, value]) => [label, {
  avgMb: value.appEstimateAvgMb,
  peakMb: value.appEstimatePeakMb,
  anonMb: value.anonAvgMb,
  samples: value.samples,
}])));
```

- [ ] **Step 7: Syntax-check the harness**

```bash
docker run --rm --entrypoint bash -v "$SPIKE:/opt/spike:ro" idbots-spike:phase0 -c \
  'for f in /opt/spike/harness/*.mjs; do node --check "$f" || exit 1; done; echo HARNESS_SYNTAX_OK'
```

Expected: `HARNESS_SYNTAX_OK`.

- [ ] **Step 8: Cold boot under Xvfb (S02)**

```bash
mkdir -p "$SPIKE/results/main" && chmod 0777 "$SPIKE/results/main"
docker run -d --init --name spike-main --shm-size=1g \
  -v spike-main-data:/data \
  -v "$SPIKE:/opt/spike:ro" \
  -v "$SPIKE/results/main:/results" \
  idbots-spike:phase0
docker exec -d spike-main node /opt/spike/harness/memsample.mjs 5000
docker exec spike-main node /opt/spike/harness/run.mjs boot S02
```

Expected: JSON with `ok: true`, `readyAfterContainerStartSec`, `targetUrl` ending in `dist/index.html`, and the app version. Run the `boot` command immediately after `docker run` so the uptime number is the real cold-start time.

If `boot` times out, run `docker logs spike-main | tail -100` and `docker ps -a`. Typical causes and first fixes: a missing shared library (add the apt package to the Dockerfile and rebuild), a tray or D-Bus crash (try `SPIKE_DISPLAY_MODE=ozone` to classify it, then apply the App patch policy), or the container exiting because the window closed.

- [ ] **Step 9: Capture and classify boot logs**

```bash
docker logs spike-main > "$SPIKE/results/main/S02-boot.log" 2>&1
grep -nEi 'tray|auto-?launch|autostart|dbus|gpu|sandbox|uncaught|unhandled|fatal|error' "$SPIKE/results/main/S02-boot.log" \
  | head -200 > "$SPIKE/results/main/S02-log-highlights.txt"
wc -l "$SPIKE/results/main/S02-log-highlights.txt"
```

Expected: a highlights file. For the report, sort each highlighted line into one of: harmless (for example missing tray host), needs a server-mode skip, or blocking.

- [ ] **Step 10: Commit**

```bash
gzip -kf "$SPIKE/results/main/S02-boot.log"
git add spikes/linux-headless/harness spikes/linux-headless/results/main/scenarios.json spikes/linux-headless/results/main/S02-boot.log.gz spikes/linux-headless/results/main/S02-log-highlights.txt
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: add cdp harness and record cold boot"
```

---

### Task 4: Outbound Network Check (S00)

**Files:**
- Create: `spikes/linux-headless/scripts/net-check.sh`
- Create: `spikes/linux-headless/results/main/S00-network.csv`

**Interfaces:**
- Consumes: running container `spike-main` (Task 3).
- Produces: a CSV `url,http_code,time_total_sec`; `000` means unreachable or timed out.

- [ ] **Step 1: Write `spikes/linux-headless/scripts/net-check.sh`**

```bash
#!/usr/bin/env bash
# Outbound reachability from inside a tenant container. Any HTTP status other
# than 000 means the endpoint is reachable; 000 means DNS, TCP, or TLS failed.
set -u
urls=(
  https://www.metaso.network/assist-open-api/v1/traffic/pricing
  https://manapi.metaid.io
  https://man.metaid.io
  https://file.metaid.io
  https://api.idchat.io
  https://www.show.now
  https://www.metalet.space
  https://mempool.space/api/blocks/tip/height
  https://api.deepseek.com
  https://github.com
  https://registry.npmjs.org
  https://pypi.org/simple/
  https://playwright.azureedge.net
  https://wttr.in/HongKong?format=3
  https://www.bing.com
  https://www.baidu.com
  https://open.feishu.cn
  https://api.dingtalk.com
  https://api.telegram.org
)
echo "url,http_code,time_total_sec"
for url in "${urls[@]}"; do
  result=$(curl -s -o /dev/null -m 20 -w "%{http_code},%{time_total}" "$url" 2>/dev/null)
  echo "$url,${result:-000,20}"
done
```

- [ ] **Step 2: Run it**

```bash
chmod +x "$SPIKE/scripts/net-check.sh"
docker exec spike-main bash /opt/spike/scripts/net-check.sh | tee "$SPIKE/results/main/S00-network.csv"
```

Expected: one line per URL. Metaso, MetaID, DeepSeek, npm, and PyPI must be reachable; any `000` among them is a blocking finding for the report.

- [ ] **Step 3: Commit**

```bash
git add spikes/linux-headless/scripts/net-check.sh spikes/linux-headless/results/main/S00-network.csv
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record outbound network reachability"
```

---

### Task 5: Onboarding (S03)

**Files:**
- Modify: `spikes/linux-headless/results/main/scenarios.json` (written by the harness)
- Create: `spikes/linux-headless/results/main/state.json` (written by the harness)

**Interfaces:**
- Consumes: `run.mjs onboard` (Task 3).
- Produces: `state.json` with `twinId`, `twinName`, `provider`; later tasks require `twinId`.

- [ ] **Step 1: Onboard**

```bash
docker exec -e SPIKE_DEEPSEEK_API_KEY="${SPIKE_DEEPSEEK_API_KEY:-}" spike-main node /opt/spike/harness/run.mjs onboard
```

Expected: `ok: true`, a `twin.id`, `provider.provider` equal to `metaid-free` (or `deepseek` only if the free bootstrap failed), `steps.createTwin.success: true`, and `steps.traffic.ensureAccount` without an error. Write down the following for the report: whether `steps.uiBootstrap` succeeded without help (the renderer bootstrapped the provider on its own), `steps.createTwin.subsidy`, `chainPartial`, and `chainSetupPending`, and the traffic balance.

If `createTwin` returns `chainSetupPending` or `chainPartial: true`, wait 2 minutes and run `docker exec spike-main node /opt/spike/harness/run.mjs state save` to confirm the MetaBot exists, then continue; record it as a partial result. If the free bootstrap or subsidy fails with a rate or IP limit message, record the exact message: it decides the Metaso per-IP policy for the cloud host.

- [ ] **Step 2: Measure idle memory after onboarding**

```bash
docker exec spike-main node /opt/spike/harness/run.mjs idle 300 S03:idle-after-onboard
```

Expected: `idle S03:idle-after-onboard 300s done`.

- [ ] **Step 3: Commit**

```bash
git add spikes/linux-headless/results/main/scenarios.json spikes/linux-headless/results/main/state.json
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record headless onboarding"
```

---

### Task 6: Chat Turns and Leak Check (S04)

**Files:**
- Create: `spikes/linux-headless/results/main/S04/first-turn-messages.json` (written by the harness)

**Interfaces:**
- Consumes: `run.mjs chat`, `state.json.twinId`.
- Produces: `scenarios.json.S04` with `turns[]` (`ok`, `ttftMs` on turn 1, `totalMs`), `correctMath`; `state.json.chatSessionId`.

- [ ] **Step 1: Run 10 turns**

```bash
docker exec spike-main node /opt/spike/harness/run.mjs chat
```

Expected: `ok: true`, `correctMath: true`, ten turns with `ok: true`, and turn 1 with a non-null `ttftMs` and `streamUpdates > 0`. A `streamUpdates` of 0 with `ok: true` means the reply arrived without incremental updates; record it, because the mobile client depends on streaming.

- [ ] **Step 2: Measure idle memory after the loop**

```bash
docker exec spike-main node /opt/spike/harness/run.mjs idle 300 S04:idle-after-loop
```

Expected: done after 5 minutes. Task 13 compares this window with `S03:idle-after-onboard` to detect growth.

- [ ] **Step 3: Commit**

```bash
git add spikes/linux-headless/results/main/scenarios.json spikes/linux-headless/results/main/S04
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record chat turns and leak window"
```

---

### Task 7: Skills on Linux (S05)

**Files:**
- Create: `spikes/linux-headless/results/main/S05/` (written by the harness)
- Create: `spikes/linux-headless/results/main/artifacts/`

**Interfaces:**
- Consumes: `run.mjs skills [skillId]`.
- Produces: `S05/skills.json` keyed by `docx`, `xlsx`, `pptx`, `pdf`, `web-search`, `weather`, each with `verified`, `verifyDetail`, `ttftMs`, `totalMs`, `toolCalls`, `toolErrors`; `pptxNodeModules` for `pptx`.

- [ ] **Step 1: Run all skill cases as shipped**

```bash
docker exec spike-main node /opt/spike/harness/run.mjs skills
```

Expected: one line per skill with `verified` and a detail string. Each case can take several minutes. Do not install anything before this run: the first pass measures what works out of the box.

- [ ] **Step 2: Diagnose each failure, apply an image-level fix, and re-run only that skill**

For each skill with `verified: false`, read `results/main/S05/<skill>-messages.json` (tool calls and their errors) and classify the cause. Apply the matching fix inside the running container, then re-run with `docker exec spike-main node /opt/spike/harness/run.mjs skills <skillId>`:

| Symptom | Fix to try in the running container | Becomes an image requirement |
|---------|--------------------------------------|------------------------------|
| `pptxNodeModules` is null, or `Cannot find module 'pptxgenjs'` | `docker exec spike-main bash -c 'cd "$(dirname "$(find /data -maxdepth 6 -type f -path "*/SKILLs/pptx/package.json" | head -1)")" && npm install --omit=dev --no-audit --no-fund'` (the same command the app's skill installer runs) | Preinstall the pptx skill's npm dependencies in the image |
| Playwright `Executable doesn't exist` | `docker exec spike-main bash -c 'cd "$(dirname "$(find /data -maxdepth 6 -type f -path "*/SKILLs/pptx/package.json" | head -1)")" && npx playwright install chromium'` | Bake the Playwright Chromium browser into the image |
| Python `ModuleNotFoundError` | `docker exec spike-main /opt/skills-venv/bin/pip install <module>` | Add the module to the venv list |
| Missing CJK text in the PDF | Prompt again with "使用 /usr/share/fonts/opentype/noto 下的 Noto CJK 字体" and re-run | Document the CJK font path in the skill or image |
| web-search browser launch failure | `docker exec spike-main bash -c 'ls -l /usr/bin/chromium; chromium --version'` and capture the skill's own log | Chromium flags or path for web-search |

Each fix is applied only to the running container; record the exact command and whether the re-run passed. Do not change files in `SKILLs/`.

- [ ] **Step 3: Copy the generated files out for review**

```bash
docker cp spike-main:/data/workspace/spike "$SPIKE/results/main/artifacts"
ls -lR "$SPIKE/results/main/artifacts" | head -50
```

Expected: `docx/report.docx`, `xlsx/sales.xlsx`, `pptx/deck.pptx`, `pdf/note.pdf` (for the skills that passed).

- [ ] **Step 4: Commit**

```bash
git add spikes/linux-headless/results/main/scenarios.json spikes/linux-headless/results/main/S05 spikes/linux-headless/results/main/artifacts
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record skill results on linux"
```

---

### Task 8: Background Scheduled Task (S06)

**Files:**
- Modify: `spikes/linux-headless/results/main/scenarios.json` (written by the harness)

**Interfaces:**
- Consumes: `run.mjs schedule-create`, `run.mjs schedule-check`.
- Produces: `scenarios.json.S06` with `created`, `runs[]`, `fileExists`, `fileContent`.

- [ ] **Step 1: Create a one-shot task for two minutes from now**

```bash
docker exec spike-main node /opt/spike/harness/run.mjs schedule-create
```

Expected: `success: true` and a task id.

- [ ] **Step 2: Wait four minutes with no harness connected**

Run nothing against the container for 4 minutes (use `sleep 240` on the host). This proves the task runs with no client attached.

- [ ] **Step 3: Check the run**

```bash
docker exec spike-main node /opt/spike/harness/run.mjs schedule-check
```

Expected: `ok: true`, at least one run, and `fileContent` holding a UTC timestamp. Record each run's status fields as returned.

- [ ] **Step 4: Commit**

```bash
git add spikes/linux-headless/results/main/scenarios.json
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record background scheduled task"
```

---

### Task 9: Traffic-Sponsored Chain Write (S07)

**Files:**
- Create: `spikes/linux-headless/results/main/S07/messages.json` (written by the harness)

**Interfaces:**
- Consumes: `run.mjs chain`.
- Produces: `scenarios.json.S07` with `pinIds`, `txids`, `trafficBefore`, `trafficAfter`.

- [ ] **Step 1: Post one Buzz through the agent**

```bash
docker exec spike-main node /opt/spike/harness/run.mjs chain
```

Expected: `ok: true` with at least one pin id (`<64 hex>i<n>`) or txid. Compare `trafficBefore` and `trafficAfter`: a lower traffic balance means the write was traffic-sponsored. If the agent reports insufficient funds or a sponsor error, record the full tool error from `S07/messages.json`.

- [ ] **Step 2: Confirm on the public indexer**

```bash
PIN=$(jq -r '.S07.pinIds[0] // empty' "$SPIKE/results/main/scenarios.json")
[ -n "$PIN" ] && curl -s "https://manapi.metaid.io/pin/$PIN" | head -c 600; echo
```

Expected: JSON describing the pin. An indexer delay of a few minutes is normal; retry once after 3 minutes before recording a failure.

- [ ] **Step 3: Commit**

```bash
git add spikes/linux-headless/results/main/scenarios.json spikes/linux-headless/results/main/S07
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record traffic-sponsored chain write"
```

---

### Task 10: Restart Persistence and Database Integrity (S08)

**Files:**
- Create: `spikes/linux-headless/results/main/S08/` (written by the harness)
- Create: `spikes/linux-headless/results/main/S08-restart.txt`

**Interfaces:**
- Consumes: `run.mjs state save|compare`, `run.mjs boot S08`.
- Produces: `scenarios.json.S08` with `ok` (snapshots match), plus stop and integrity evidence.

- [ ] **Step 1: Snapshot, stop gracefully, and check the database offline**

```bash
docker exec spike-main node /opt/spike/harness/run.mjs state save
start=$(date +%s)
docker stop -t 30 spike-main
end=$(date +%s)
{
  echo "stop_seconds: $((end - start))"
  echo "exit_code: $(docker inspect -f '{{.State.ExitCode}}' spike-main)"
  docker run --rm --entrypoint bash -v spike-main-data:/data idbots-spike:phase0 -c \
    'find /data -maxdepth 3 -name "idbots.sqlite*" -printf "%p %s\n"; db=$(find /data -maxdepth 3 -name idbots.sqlite | head -1); echo "integrity: $(sqlite3 "$db" "PRAGMA integrity_check;")"'
} | tee "$SPIKE/results/main/S08-restart.txt"
```

Expected: `stop_seconds` under 30 (a value of 30 means SIGTERM was ignored and Docker killed the app), an exit code of 0 or 143, and `integrity: ok`.

- [ ] **Step 2: Restart and compare**

```bash
docker start spike-main
docker exec -d spike-main node /opt/spike/harness/memsample.mjs 5000
docker exec spike-main node /opt/spike/harness/run.mjs boot S08
docker exec spike-main node /opt/spike/harness/run.mjs state compare
docker exec spike-main node /opt/spike/harness/run.mjs turn S08-turn '重启后你好，请回复“已恢复”。'
```

Expected: `boot` succeeds; `scenarios.json.S08.ok` is `true` (the same MetaBots, sessions, scheduled tasks, and provider); the turn succeeds.

- [ ] **Step 3: Commit**

```bash
git add spikes/linux-headless/results/main/scenarios.json spikes/linux-headless/results/main/S08 spikes/linux-headless/results/main/S08-restart.txt
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record restart persistence"
```

---

### Task 11: Headless Ozone Mode (S09)

**Files:**
- Create: `spikes/linux-headless/results/ozone/` (written by the harness)

**Interfaces:**
- Consumes: the image with `SPIKE_DISPLAY_MODE=ozone`; `run.mjs boot|onboard|turn|idle`.
- Produces: `results/ozone/scenarios.json` (`S09`, `S03`, `S09-turn`) and `results/ozone/memory.csv`.

- [ ] **Step 1: Boot a fresh container without Xvfb**

```bash
mkdir -p "$SPIKE/results/ozone" && chmod 0777 "$SPIKE/results/ozone"
docker run -d --init --name spike-ozone --shm-size=1g -e SPIKE_DISPLAY_MODE=ozone \
  -v spike-ozone-data:/data \
  -v "$SPIKE:/opt/spike:ro" \
  -v "$SPIKE/results/ozone:/results" \
  idbots-spike:phase0
docker exec -d spike-ozone node /opt/spike/harness/memsample.mjs 5000
docker exec spike-ozone node /opt/spike/harness/run.mjs boot S09
```

Expected: either a successful boot, or a failure with logs. If it fails, save `docker logs spike-ozone > "$SPIKE/results/ozone/S09-boot.log" 2>&1`, record `S09` as `FAIL`, remove the container, and skip to Task 12.

- [ ] **Step 2: Onboard, run a turn, and measure idle memory**

```bash
docker exec -e SPIKE_DEEPSEEK_API_KEY="${SPIKE_DEEPSEEK_API_KEY:-}" spike-ozone node /opt/spike/harness/run.mjs onboard
docker exec spike-ozone node /opt/spike/harness/run.mjs turn S09-turn
docker exec spike-ozone node /opt/spike/harness/run.mjs skills docx
docker exec spike-ozone node /opt/spike/harness/run.mjs idle 300 S09:idle
docker logs spike-ozone > "$SPIKE/results/ozone/S09-boot.log" 2>&1
```

Expected: onboarding and the turn succeed, and the docx skill verifies. Task 13 compares `S09:idle` with the Xvfb idle windows.

- [ ] **Step 3: Stop the ozone container**

```bash
docker stop -t 30 spike-ozone
```

- [ ] **Step 4: Commit**

```bash
gzip -kf "$SPIKE/results/ozone/S09-boot.log"
git add spikes/linux-headless/results/ozone/scenarios.json spikes/linux-headless/results/ozone/state.json spikes/linux-headless/results/ozone/memory.csv spikes/linux-headless/results/ozone/S09-boot.log.gz
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record headless ozone mode"
```

If some of these files do not exist because the ozone boot failed, stage only the files that exist.

---

### Task 12: Density (S10)

**Files:**
- Create: `spikes/linux-headless/scripts/run-density.sh`
- Create: `spikes/linux-headless/results/density/`
- Create: `spikes/linux-headless/results/spike-d1/` … `spike-d5/` (written by the harness)

**Interfaces:**
- Consumes: the display mode that Task 11 and Task 3 showed to work (Xvfb by default; pass `SPIKE_DISPLAY_MODE=ozone` if ozone booted and used clearly less memory).
- Produces: host `free -m` snapshots, `docker stats` snapshots, and per-container `memory.csv` and `scenarios.json`.

- [ ] **Step 1: Write `spikes/linux-headless/scripts/run-density.sh`**

```bash
#!/usr/bin/env bash
# Starts N tenant containers side by side, onboards each, records idle memory,
# then runs three chat turns concurrently. Usage: run-density.sh <N>
set -euo pipefail
N="${1:-5}"
IMAGE="${SPIKE_IMAGE:-idbots-spike:phase0}"
MODE="${SPIKE_DISPLAY_MODE:-xvfb}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/results/density"
mkdir -p "$OUT"
stats() { docker stats --no-stream --format '{{.Name}},{{.MemUsage}},{{.CPUPerc}}' > "$OUT/$1"; }

free -m > "$OUT/host-free-before.txt"
for i in $(seq 1 "$N"); do
  name="spike-d$i"
  mkdir -p "$ROOT/results/$name" && chmod 0777 "$ROOT/results/$name"
  docker run -d --init --name "$name" --shm-size=1g -e SPIKE_DISPLAY_MODE="$MODE" \
    -v "$name-data:/data" \
    -v "$ROOT:/opt/spike:ro" \
    -v "$ROOT/results/$name:/results" \
    "$IMAGE" >/dev/null
  docker exec -d "$name" node /opt/spike/harness/memsample.mjs 5000
  docker exec "$name" node /opt/spike/harness/run.mjs boot S10-boot \
    || echo "boot failed for $name" | tee -a "$OUT/errors.txt"
  docker exec -e SPIKE_SCENARIO=S10-onboard -e SPIKE_DEEPSEEK_API_KEY="${SPIKE_DEEPSEEK_API_KEY:-}" "$name" \
    node /opt/spike/harness/run.mjs onboard || echo "onboard failed for $name" | tee -a "$OUT/errors.txt"
done
stats docker-stats-after-onboard.csv

for i in $(seq 1 "$N"); do
  docker exec -d "spike-d$i" node /opt/spike/harness/run.mjs idle 600 S10:idle
done
sleep 300
stats docker-stats-idle.csv
free -m > "$OUT/host-free-idle.txt"
sleep 310

pids=()
for i in 1 2 3; do
  [ "$i" -le "$N" ] || break
  docker exec "spike-d$i" node /opt/spike/harness/run.mjs turn S10-concurrent > "$OUT/concurrent-d$i.json" 2>&1 &
  pids+=("$!")
done
sleep 20
stats docker-stats-concurrent.csv
free -m > "$OUT/host-free-concurrent.txt"
for pid in "${pids[@]}"; do wait "$pid" || true; done
echo "density run complete: $OUT"
```

- [ ] **Step 2: Stop the main container so it does not distort host memory, then run with N=5**

```bash
docker stop -t 30 spike-main
chmod +x "$SPIKE/scripts/run-density.sh"
SPIKE_DISPLAY_MODE=xvfb "$SPIKE/scripts/run-density.sh" 5 2>&1 | tee "$SPIKE/results/density/run.log"
```

Expected: `density run complete`, three `concurrent-d*.json` files with `ok: true`, and the `docker-stats-*.csv` and `host-free-*.txt` snapshots. Onboarding five containers in a row from one IP may hit Metaso rate or IP limits; record every such message in the report (it sizes the per-IP allowance the cloud host needs).

- [ ] **Step 3: Stop the density containers**

```bash
for i in 1 2 3 4 5; do docker stop -t 30 "spike-d$i" || true; done
```

- [ ] **Step 4: Commit**

```bash
git add spikes/linux-headless/scripts/run-density.sh spikes/linux-headless/results/density
for i in 1 2 3 4 5; do git add "spikes/linux-headless/results/spike-d$i/scenarios.json" "spikes/linux-headless/results/spike-d$i/memory.csv" 2>/dev/null || true; done
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: record multi-tenant density"
```

---

### Task 13: Memory Analysis, Report, and Handoff (S11)

**Files:**
- Create: `spikes/linux-headless/results/*/memory-summary.json`
- Create: `spikes/linux-headless/PHASE0_REPORT.md`
- Create: `spikes/linux-headless/results.json`
- Create (outside git): `~/phase0-linux-headless-results.tgz`

**Interfaces:**
- Consumes: every result file from Tasks 1–12.
- Produces: the report and `results.json` returned to the owner.

- [ ] **Step 1: Summarize memory for every container**

```bash
for dir in "$SPIKE"/results/main "$SPIKE"/results/ozone "$SPIKE"/results/spike-d*; do
  [ -f "$dir/memory.csv" ] || continue
  echo "== $dir"
  node "$SPIKE/harness/analyze-memory.mjs" "$dir"
done 2>&1 | tee "$SPIKE/results/memory-summary.txt"
```

Expected: one table per container with a row per label (`S03:idle-after-onboard`, `S04:first-turn`, `S04:loop`, `S04:idle-after-loop`, `S05:<skill>`, `S09:idle`, `S10:idle`, …). The `appEstimate` columns already subtract the spike's own processes.

- [ ] **Step 2: Compute the sizing numbers with these fixed rules**

- `idleMb`: `appEstimateAvgMb` of `S04:idle-after-loop` in the chosen display mode (use `S09:idle` if ozone is chosen).
- `chatPeakMb`: the maximum `appEstimatePeakMb` over `S04:first-turn` and `S04:loop`.
- `skillPeakMb`: the maximum `appEstimatePeakMb` over all `S05:*` labels.
- `leakMb`: `S04:idle-after-loop` average minus `S03:idle-after-onboard` average.
- `tenantMemoryLimitMB`: `skillPeakMb × 1.3`, rounded up to a multiple of 256.
- `usersPerHost` for a host with `H` MB of RAM (report both `H = 16384` and `H = 32768`): `floor((H − 3072) / (idleMb + 0.2 × (chatPeakMb − idleMb)))`. This assumes 20% of tenants are mid-turn at once and 3 GB reserved for the OS, Docker, and the control plane.
- Cross-check against the density run: the host's used memory in `host-free-idle.txt` minus `host-free-before.txt`, divided by 5, should be within 25% of `idleMb`. If not, report both and explain the difference.

- [ ] **Step 3: Choose the verdict with these fixed rules**

- `GO`: S02, S03, S04, S06, S07, and S08 pass; at least docx, xlsx, and pdf pass (possibly after image-level fixes); no app patches; `idleMb ≤ 1024`.
- `GO_WITH_CONDITIONS`: the same scenarios pass, but app patches were needed, or pptx/web-search/weather need fixes not yet proven, or `1024 < idleMb ≤ 1536`.
- `NO_GO`: S02, S03, or S04 fails with no workaround inside the time box, or `idleMb > 1536`.

- [ ] **Step 4: Write `spikes/linux-headless/PHASE0_REPORT.md` from this template**

Replace every `<…>` with measured values or short evidence. Keep the headings.

```markdown
# Linux Headless Tenant — Phase 0 Spike Report

Branch: `spike/linux-headless` · Commit under test: `<sha>` · Dates: `<start>–<end>` · Host: `<instance type, vCPU, RAM, OS, Docker, cgroup>`

Phase 0 asked: **can the stock IDBots backend run headless as one container per user on a Hong Kong Linux host, how much memory does one user need, and do the core skills work on Linux?**

**Verdict: <GO | GO_WITH_CONDITIONS | NO_GO>.** <Two sentences: the main reason and the main condition.>

## Verification

| # | Verification | Result | Evidence |
|---|--------------|--------|----------|
| S00 | Outbound network from the host | <PASS/FAIL> | `results/main/S00-network.csv` |
| S01 | Image builds; DSH kernel patches and dependency gate pass | <…> | `results/S01-build.txt` |
| S02 | Cold boot under Xvfb | <… seconds> | `results/main/scenarios.json#S02` |
| S03 | Self-onboarding (provider, twin on-chain, traffic account) | <…> | `#S03` |
| S04 | 10 chat turns; first-token and total time | <TTFT … s, total … s> | `#S04` |
| S05 | Skills: docx / xlsx / pptx / pdf / web-search / weather | <…/…/…/…/…/…> | `results/main/S05/skills.json` |
| S06 | Scheduled task with no client attached | <…> | `#S06` |
| S07 | Traffic-sponsored Buzz | <pin id> | `#S07` |
| S08 | Graceful stop, DB integrity, restart persistence | <…> | `results/main/S08-restart.txt` |
| S09 | Headless Ozone mode | <…> | `results/ozone/` |
| S10 | Five tenants side by side; three concurrent turns | <…> | `results/density/` |
| S11 | Memory analysis | see below | `results/memory-summary.txt` |

## Memory

| Window | App estimate avg (MB) | Peak (MB) | Largest process categories |
|--------|-----------------------|-----------|----------------------------|
| Idle after onboarding | <…> | <…> | <…> |
| First chat turn | <…> | <…> | <…> |
| Idle after 10 turns | <…> | <…> | <…> |
| docx / xlsx / pptx / pdf | <…> | <…> | <…> |
| web-search | <…> | <…> | <…> |
| Ozone idle | <…> | <…> | <…> |

Sizing (rules from the plan, Task 13 Step 2): idleMb `<…>`, chatPeakMb `<…>`, skillPeakMb `<…>`, leakMb `<…>`, tenantMemoryLimitMB `<…>`, usersPerHost at 16 GB `<…>` and at 32 GB `<…>`. Density cross-check: `<…>`.

## Findings

- F1. <one finding per line, most important first, each with its evidence path>

## Required App Changes (become server-mode requirements)

- <one line per app patch, with the file and reason; "None" if there were none>

## Tenant Image Requirements

- <apt packages, Python modules, npm preinstalls, Playwright browser, fonts, Chromium flags proven necessary>

## Network and External Services

- <unreachable endpoints; Metaso rate or IP-limit messages with exact text; subsidy behavior>

## Open Risks

- <anything not proven, with what would prove it>
```

- [ ] **Step 5: Write `spikes/linux-headless/results.json` with this schema**

Use `null` for anything not measured. Numbers are plain numbers (MB, seconds).

```json
{
  "spikeVersion": 1,
  "gitCommit": "<sha>",
  "host": { "instanceType": "<type>", "vcpu": 8, "memoryMb": 32768, "os": "<os>", "docker": "<version>", "cgroup": 2 },
  "image": { "tag": "idbots-spike:phase0", "bytes": 0, "buildSeconds": 0 },
  "scenarios": {
    "S00": "PASS", "S01": "PASS", "S02": "PASS", "S03": "PASS", "S04": "PASS", "S05": "PARTIAL",
    "S06": "PASS", "S07": "PASS", "S08": "PASS", "S09": "FAIL", "S10": "PASS", "S11": "PASS"
  },
  "timingsSec": { "coldBoot": 0, "onboarding": 0, "firstTokenTurn1": 0, "turn1Total": 0, "restartBoot": 0, "gracefulStop": 0 },
  "memoryMb": {
    "idleAfterOnboard": 0, "idleAfterLoop": 0, "chatPeak": 0, "leak": 0,
    "skillPeak": { "docx": 0, "xlsx": 0, "pptx": 0, "pdf": 0, "web-search": 0, "weather": 0 },
    "ozoneIdle": null,
    "breakdownIdle": { "electron-main": 0, "renderer": 0, "gpu": 0, "utility": 0, "dsh-runtime": 0, "xvfb": 0 }
  },
  "density": { "tenants": 5, "hostUsedIdleMb": 0, "perTenantIdleMb": 0, "concurrentTurnsOk": 3, "concurrentTtftSec": [0, 0, 0] },
  "skills": {
    "docx": { "status": "PASS", "fixApplied": null },
    "xlsx": { "status": "PASS", "fixApplied": null },
    "pptx": { "status": "PASS", "fixApplied": "<command or null>" },
    "pdf": { "status": "PASS", "fixApplied": null },
    "web-search": { "status": "PASS", "fixApplied": null },
    "weather": { "status": "PASS", "fixApplied": null }
  },
  "network": { "unreachable": [] },
  "metaso": { "freeBootstrap": "ok", "gasSubsidy": "ok", "rateLimitMessages": [] },
  "appPatches": [],
  "imageRequirements": [],
  "blockingIssues": [],
  "recommendation": {
    "verdict": "GO_WITH_CONDITIONS",
    "displayMode": "xvfb",
    "tenantMemoryLimitMB": 0,
    "usersPerHost16GB": 0,
    "usersPerHost32GB": 0
  }
}
```

The example values above only show types; every value in the delivered file must come from the measurements.

- [ ] **Step 6: Scan results for secrets**

```bash
grep -rnEI 'sk-[A-Za-z0-9]{16,}|"apiKey"\s*:\s*"[^"]{12,}"|mnemonic|BEGIN [A-Z ]*PRIVATE KEY' "$SPIKE" --exclude-dir=harness || echo "NO_SECRETS_FOUND"
```

Expected: `NO_SECRETS_FOUND`, or only harmless matches such as the word "mnemonic" in a log line with no words after it. Redact any real secret in place before continuing.

- [ ] **Step 7: Commit the report**

```bash
gzip -kf "$SPIKE"/results/density/run.log 2>/dev/null || true
git add spikes/linux-headless/PHASE0_REPORT.md spikes/linux-headless/results.json spikes/linux-headless/results/memory-summary.txt
git add spikes/linux-headless/results/*/memory-summary.json spikes/linux-headless/results/density/run.log.gz 2>/dev/null || true
git -c user.name="IDBots Phase0 Agent" -c user.email="phase0-agent@idbots.invalid" commit -m "spike: phase 0 linux headless report"
```

- [ ] **Step 8: Package the results for the owner**

```bash
cd ~/idbots-phase0
rm -rf /tmp/phase0-patches && git format-patch -o /tmp/phase0-patches "$(git merge-base HEAD origin/main)"
tar czf ~/phase0-linux-headless-results.tgz -C /tmp phase0-patches -C ~/idbots-phase0 spikes/linux-headless
ls -lh ~/phase0-linux-headless-results.tgz
```

Expected: one archive holding the patch series (so the owner can replay the branch with `git am`) and the full `spikes/linux-headless/` directory. Hand the archive to the owner. Push the branch only if the owner explicitly asks for it.

- [ ] **Step 9: Clean up the host**

```bash
for c in spike-main spike-ozone spike-d1 spike-d2 spike-d3 spike-d4 spike-d5; do docker rm -f "$c" 2>/dev/null || true; done
for v in spike-main-data spike-ozone-data spike-d1-data spike-d2-data spike-d3-data spike-d4-data spike-d5-data; do docker volume rm "$v" 2>/dev/null || true; done
docker image ls idbots-spike
```

Expected: no spike containers or volumes remain. Keep the image and the clone until the owner confirms the archive arrived; then remove them with `docker image rm idbots-spike:phase0` and `rm -rf ~/idbots-phase0`.

---

## What the Owner Gets Back

1. `~/phase0-linux-headless-results.tgz` from the host, containing `PHASE0_REPORT.md`, `results.json`, all raw results, and the commit series of `spike/linux-headless`.
2. A short message from the executing agent with the verdict, the recommended `tenantMemoryLimitMB` and `usersPerHost`, and every blocking issue.

The owner's local agent reviews the archive, replays the commits into a local `spike/linux-headless` worktree, posts the development journal, and folds the numbers into the workstream documents in `docs/cloud-mobile/` (tenant runtime contract, image requirements, sizing, and Metaso per-IP policy).
