import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AppContext } from './context.js';
import { HttpError, writeError, writeJson, type RequestCtx, type Route } from './http.js';
import { isOriginAllowed } from './origin.js';
import { authRoutes } from './routes/auth.js';
import { requireUser } from './routes/auth.js';

/**
 * Minimal node:http server (no web framework, per REQ-B-2): a tiny
 * method+path router, JSON bodies (64 KiB cap), the C3 error envelope, a
 * per-request id (echoed in x-request-id), REQ-B-8 Origin checks on every
 * state-changing request, and cookie auth for routes that ask for it.
 */

const BODY_LIMIT = 64 * 1024;

function readBodyLimited(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function clientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  const remote = req.socket.remoteAddress ?? 'unknown';
  return remote === '::1' ? '127.0.0.1' : remote.replace(/^::ffff:/, '');
}

async function handleHealth(app: AppContext, res: http.ServerResponse): Promise<void> {
  let dbOk = false;
  try {
    app.db.prepare('SELECT 1').get();
    dbOk = true;
  } catch {
    dbOk = false;
  }
  let dockerOk = false;
  try {
    dockerOk = await app.docker.ping();
  } catch {
    dockerOk = false;
  }
  const ok = dbOk && dockerOk;
  writeJson(res, ok ? 200 : 503, { ok, db: dbOk, docker: dockerOk });
}

async function handle(
  app: AppContext,
  routes: Route[],
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const incomingId = req.headers['x-request-id'];
  const requestId = typeof incomingId === 'string' && incomingId.length > 0 ? incomingId : randomUUID();
  res.setHeader('x-request-id', requestId);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const reqCtx: RequestCtx = {
    requestId,
    method,
    path: url.pathname,
    ip: clientIp(req),
    userAgent: String(req.headers['user-agent'] ?? ''),
    cookieHeader: req.headers.cookie,
    res,
    log: (level, msg, extra) =>
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level,
          requestId,
          method,
          path: url.pathname,
          msg,
          ...(extra ?? {}),
        }),
      ),
  };

  try {
    if (method === 'GET' && url.pathname === '/health') {
      await handleHealth(app, res);
      return;
    }

    if (method !== 'GET') {
      const origin = req.headers.origin;
      if (!isOriginAllowed(typeof origin === 'string' ? origin : undefined, app.config.publicOrigin)) {
        reqCtx.log('warn', 'origin not allowed');
        throw new HttpError(403, 'ORIGIN_NOT_ALLOWED', 'the Origin header does not match the deployment origin');
      }
    }

    const route = routes.find((r) => r.method === method && r.path === url.pathname);
    if (!route) {
      throw new HttpError(404, 'NOT_FOUND', `no route for ${method} ${url.pathname}`);
    }

    let body: unknown = null;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBodyLimited(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'INVALID_BODY', 'the request body is not valid JSON');
        }
      }
    }

    if (route.auth) {
      requireUser(app, reqCtx);
    }
    await route.handler(app, reqCtx, body);
  } catch (err) {
    if (err instanceof HttpError) {
      writeError(res, err.status, err.code, err.message);
      return;
    }
    reqCtx.log('error', 'unhandled error', {
      error: err instanceof Error ? err.message : String(err),
    });
    if (!res.headersSent) {
      writeError(res, 500, 'INTERNAL', `internal error (request ${requestId})`);
    } else {
      res.end();
    }
  }
}

export function createRequestHandler(app: AppContext): http.RequestListener {
  const routes: Route[] = [...authRoutes];
  return (req, res) => {
    handle(app, routes, req, res).catch((err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'request handler crashed', error: String(err) }));
      if (!res.headersSent) {
        writeError(res, 500, 'INTERNAL', 'internal error');
      } else {
        res.end();
      }
    });
  };
}

export function createPublicServer(app: AppContext): http.Server {
  return http.createServer(createRequestHandler(app));
}

/** Stub metrics endpoint (REQ-B-20 fills in real Prometheus series later). */
export function createMetricsServer(): http.Server {
  return http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end('# cp_metrics placeholder\n');
  });
}
