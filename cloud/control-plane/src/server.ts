import http from 'node:http';
import type Database from 'better-sqlite3';
import type { DockerClient } from './docker/client.js';

/**
 * Minimal node:http server (no web framework, per REQ-B-2): JSON error
 * envelope, a 404 handler, C3 `GET /health`, and a stub metrics listener on
 * the internal port. Auth endpoints, the WebSocket proxy, and static hosting
 * land in later phases.
 */

export interface ServerDeps {
  db: Database.Database;
  docker: DockerClient;
}

export function writeJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

export function writeError(res: http.ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { code, message } });
}

function checkDb(db: Database.Database): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

async function handleHealth(deps: ServerDeps, res: http.ServerResponse): Promise<void> {
  const dbOk = checkDb(deps.db);
  let dockerOk = false;
  try {
    dockerOk = await deps.docker.ping();
  } catch {
    dockerOk = false;
  }
  const ok = dbOk && dockerOk;
  writeJson(res, ok ? 200 : 503, { ok, db: dbOk, docker: dockerOk });
}

export function createRequestHandler(deps: ServerDeps): http.RequestListener {
  return (req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (method === 'GET' && url.pathname === '/health') {
      void handleHealth(deps, res);
      return;
    }

    writeError(res, 404, 'NOT_FOUND', `no route for ${method} ${url.pathname}`);
  };
}

export function createPublicServer(deps: ServerDeps): http.Server {
  return http.createServer(createRequestHandler(deps));
}

/** Stub metrics endpoint (REQ-B-20 fills in real Prometheus series later). */
export function createMetricsServer(): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end('# cp_metrics placeholder\n');
  });
}
