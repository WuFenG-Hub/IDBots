#!/usr/bin/env node
/**
 * Fake Docker Engine API (REQ-B-21 harness): an in-process node:http server
 * emulating the subset of the Docker API the control plane's docker client
 * uses, with containers backed by child processes running fake-tenant.mjs.
 * No Docker daemon required — this is what the local dev loop and the
 * integration tests run against.
 *
 * Usage from tests:
 *   import { FakeDocker } from '../test/fake-docker/index.mjs';
 *   const docker = new FakeDocker();
 *   await docker.listen(0);
 *   docker.url();            // http://127.0.0.1:<port>
 *   docker.volumes / docker.containers / docker.images  // live state
 *   await docker.close();    // kills children, closes the server
 *
 * Standalone: node test/fake-docker/main.mjs --port 2375
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TENANT_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fake-tenant/fake-tenant.mjs',
);

const ZERO_TIME = '0001-01-01T00:00:00Z';

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function iso(ms) {
  return ms === null || ms === undefined ? ZERO_TIME : new Date(ms).toISOString();
}

export class FakeDocker {
  /** @type {Map<string, object>} id -> container record */
  containers = new Map();
  /** @type {Map<string, object>} name -> volume record */
  volumes = new Map();
  /** @type {Map<string, {ref: string, labels: object}>} */
  images = new Map();

  #server = null;
  #port = 0;
  #host = '127.0.0.1';
  #tenantScript;
  #baseEnv;

  constructor({ tenantScript = TENANT_SCRIPT, env = {} } = {}) {
    this.#tenantScript = tenantScript;
    this.#baseEnv = env;
  }

  async listen(port = 0, host = '127.0.0.1') {
    this.#host = host;
    this.#server = http.createServer((req, res) => {
      this.#route(req, res).catch((err) => {
        sendJson(res, 500, { message: String(err?.message ?? err) });
      });
    });
    await new Promise((resolve) => this.#server.listen(port, host, resolve));
    this.#port = this.#server.address().port;
    return this.#port;
  }

  url() {
    return `http://${this.#host}:${this.#port}`;
  }

  /** Stop all children and close the server. */
  async close() {
    for (const c of this.containers.values()) {
      this.#killChild(c);
    }
    if (this.#server) {
      await new Promise((resolve) => this.#server.close(resolve));
      this.#server = null;
    }
  }

  #killChild(c) {
    if (c.child && c.child.exitCode === null && !c.child.killed) {
      c.child.kill('SIGKILL');
    }
    c.child = null;
  }

  async #route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (method === 'GET' && pathname === '/_ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    if (method === 'POST' && pathname === '/v1.43/volumes/create') {
      const body = JSON.parse(await readBody(req));
      if (this.volumes.has(body.Name)) {
        sendJson(res, 409, { message: `volume ${body.Name} already exists` });
        return;
      }
      this.volumes.set(body.Name, {
        Name: body.Name,
        Labels: body.Labels ?? {},
        CreatedAt: new Date().toISOString(),
      });
      sendJson(res, 201, { Name: body.Name, Driver: 'local', Labels: body.Labels ?? {} });
      return;
    }

    let match = /^\/v1\.43\/containers\/create$/.exec(pathname);
    if (method === 'POST' && match) {
      const name = url.searchParams.get('name');
      const body = JSON.parse(await readBody(req));
      if (!name) {
        sendJson(res, 400, { message: 'query parameter "name" is required' });
        return;
      }
      for (const c of this.containers.values()) {
        if (c.name === name) {
          sendJson(res, 409, { message: `container name "${name}" is already in use` });
          return;
        }
      }
      const id = crypto.randomBytes(32).toString('hex');
      const env = {};
      for (const entry of body.Env ?? []) {
        const eq = entry.indexOf('=');
        env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      this.containers.set(id, {
        id,
        name,
        image: body.Image,
        env,
        labels: body.Labels ?? {},
        createdAt: Date.now(),
        state: 'created',
        exitCode: null,
        startedAt: null,
        finishedAt: null,
        child: null,
        hostPort: null,
        logBuffer: [],
      });
      sendJson(res, 201, { Id: id, Warnings: [] });
      return;
    }

    match = /^\/v1\.43\/containers\/([^/]+)\/start$/.exec(pathname);
    if (method === 'POST' && match) {
      const c = this.containers.get(match[1]);
      if (!c) {
        sendJson(res, 404, { message: 'no such container' });
        return;
      }
      if (c.state === 'running') {
        res.writeHead(304);
        res.end();
        return;
      }
      await this.#startChild(c);
      res.writeHead(204);
      res.end();
      return;
    }

    match = /^\/v1\.43\/containers\/([^/]+)\/stop$/.exec(pathname);
    if (method === 'POST' && match) {
      const c = this.containers.get(match[1]);
      if (!c) {
        sendJson(res, 404, { message: 'no such container' });
        return;
      }
      if (c.state !== 'running') {
        res.writeHead(304);
        res.end();
        return;
      }
      const timeoutSec = Number(url.searchParams.get('t') ?? '10');
      await this.#stopChild(c, timeoutSec);
      res.writeHead(204);
      res.end();
      return;
    }

    match = /^\/v1\.43\/containers\/([^/]+)$/.exec(pathname);
    if (method === 'DELETE' && match) {
      const c = this.containers.get(match[1]);
      if (!c) {
        sendJson(res, 404, { message: 'no such container' });
        return;
      }
      if (c.state === 'running') {
        if (url.searchParams.get('force') !== '1') {
          sendJson(res, 409, { message: 'container is running, use force' });
          return;
        }
        this.#killChild(c);
      }
      this.containers.delete(c.id);
      res.writeHead(204);
      res.end();
      return;
    }

    if (method === 'GET' && pathname === '/v1.43/containers/json') {
      const all = url.searchParams.get('all') === '1';
      let nameFilters = [];
      const filtersParam = url.searchParams.get('filters');
      if (filtersParam) {
        try {
          const parsed = JSON.parse(filtersParam);
          nameFilters = parsed.name ?? [];
        } catch {
          nameFilters = [];
        }
      }
      const items = [];
      for (const c of this.containers.values()) {
        if (c.state !== 'running' && !all) {
          continue;
        }
        if (nameFilters.length > 0 && !nameFilters.some((f) => c.name.includes(f))) {
          continue;
        }
        items.push({
          Id: c.id,
          Names: [`/${c.name}`],
          Image: c.image,
          Created: Math.floor(c.createdAt / 1000),
          State: c.state,
          Status: c.state === 'running' ? 'Up (fake)' : `Exited (${c.exitCode ?? 0}) (fake)`,
          Labels: c.labels,
        });
      }
      sendJson(res, 200, items);
      return;
    }

    match = /^\/v1\.43\/containers\/([^/]+)\/json$/.exec(pathname);
    if (method === 'GET' && match) {
      const c = this.containers.get(match[1]);
      if (!c) {
        sendJson(res, 404, { message: 'no such container' });
        return;
      }
      sendJson(res, 200, this.#inspect(c));
      return;
    }

    match = /^\/v1\.43\/containers\/([^/]+)\/logs$/.exec(pathname);
    if (method === 'GET' && match) {
      const c = this.containers.get(match[1]);
      if (!c) {
        sendJson(res, 404, { message: 'no such container' });
        return;
      }
      const sinceMs = Number(url.searchParams.get('since') ?? '0') * 1000;
      const text = c.logBuffer
        .filter((entry) => entry.t >= sinceMs)
        .map((entry) => entry.line)
        .join('');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(text);
      return;
    }

    match = /^\/v1\.43\/images\/(.+)\/json$/.exec(pathname);
    if (method === 'GET' && match) {
      const ref = decodeURIComponent(match[1]);
      const image = this.images.get(ref);
      if (!image) {
        sendJson(res, 404, { message: `no such image: ${ref}` });
        return;
      }
      sendJson(res, 200, {
        Id: `sha256:${crypto.createHash('sha256').update(ref).digest('hex')}`,
        Config: { Labels: image.labels },
        Os: 'linux',
        Architecture: 'arm64',
      });
      return;
    }

    if (method === 'POST' && pathname === '/fake/images') {
      const body = JSON.parse(await readBody(req));
      if (!body.ref) {
        sendJson(res, 400, { message: 'ref is required' });
        return;
      }
      this.images.set(body.ref, { ref: body.ref, labels: body.labels ?? {} });
      sendJson(res, 201, { ref: body.ref });
      return;
    }

    sendJson(res, 404, { message: `fake docker: no route for ${method} ${pathname}` });
  }

  #inspect(c) {
    return {
      Id: c.id,
      Name: `/${c.name}`,
      Created: iso(c.createdAt),
      Config: {
        Image: c.image,
        Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`),
        Labels: c.labels,
      },
      Image: c.image,
      State: {
        Status: c.state,
        Running: c.state === 'running',
        ExitCode: c.exitCode ?? 0,
        StartedAt: iso(c.startedAt),
        FinishedAt: iso(c.finishedAt),
      },
      NetworkSettings: {
        Networks: { bridge: { IPAddress: '' } },
        Ports:
          c.state === 'running' && c.hostPort !== null
            ? { '8790/tcp': [{ HostIp: '127.0.0.1', HostPort: String(c.hostPort) }] }
            : null,
      },
    };
  }

  async #startChild(c) {
    const env = { ...process.env, ...this.#baseEnv, ...c.env };
    delete env.IDBOTS_GATEWAY_PORT;
    env.IDBOTS_GATEWAY_PORT = '0';

    const child = spawn(process.execPath, [this.#tenantScript], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    c.child = child;
    c.startedAt = Date.now();
    c.finishedAt = null;
    c.exitCode = null;

    const onLine = (line) => {
      c.logBuffer.push({ t: Date.now(), line: `${line}\n` });
    };
    let stdoutTail = '';
    child.stdout.on('data', (chunk) => {
      const text = stdoutTail + chunk.toString('utf8');
      const lines = text.split('\n');
      stdoutTail = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) continue;
        onLine(line);
        try {
          const parsed = JSON.parse(line);
          if (parsed.msg === 'listening' && typeof parsed.port === 'number') {
            c.hostPort = parsed.port;
            c.state = 'running';
          }
        } catch {
          // non-JSON stdout: already recorded in the log buffer
        }
      }
    });
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      const text = stderrTail + chunk.toString('utf8');
      const lines = text.split('\n');
      stderrTail = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length > 0) onLine(line);
      }
    });

    child.on('exit', (code) => {
      c.state = 'exited';
      c.exitCode = code ?? 1;
      c.finishedAt = Date.now();
      c.child = null;
    });

    const deadline = Date.now() + 5000;
    while (c.state !== 'running') {
      if (Date.now() > deadline) {
        this.#killChild(c);
        c.state = 'exited';
        c.exitCode = 1;
        c.finishedAt = Date.now();
        throw new Error(`fake tenant ${c.name} did not report listening in time`);
      }
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }

  async #stopChild(c, timeoutSec) {
    const child = c.child;
    if (!child) {
      return;
    }
    child.kill('SIGTERM');
    const deadline = Date.now() + timeoutSec * 1000;
    while (c.state === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (c.state === 'running') {
      this.#killChild(c);
      const killDeadline = Date.now() + 3000;
      while (c.state === 'running' && Date.now() < killDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
}

export async function startFakeDocker(opts = {}) {
  const docker = new FakeDocker(opts);
  const port = await docker.listen(0);
  return { docker, port, url: docker.url(), close: () => docker.close() };
}
