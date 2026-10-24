import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { writeError, type RequestCtx, type Route } from '../http.js';
import { resolveSession } from '../routes/auth.js';

/**
 * Mobile login bundle at `/` and `/login` (REQ-B-19).
 *
 * - A visitor with a valid cookie and a ready/degraded tenant is redirected
 *   to `/app/`; a valid cookie with a non-ready tenant gets the bundle (its
 *   JS shows the "preparing your Bot" state via /api/v1/me); no cookie gets
 *   the bundle for signing in.
 * - Static serving: index.html with `Cache-Control: no-cache`, hashed assets
 *   with `Cache-Control: public, max-age=31536000, immutable`.
 * - The bundle directory comes from config: WS-E's `dist-mobile-login/`
 *   build when present, else the built-in placeholder in `static-login/`.
 */

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

async function serveLoginBundle(app: AppContext, reqCtx: RequestCtx): Promise<void> {
  const session = resolveSession(app, reqCtx.cookieHeader);
  if (session) {
    const tenant = app.db
      .prepare('SELECT status FROM tenants WHERE user_id = ?')
      .get(session.user.id) as { status: string } | undefined;
    if (tenant && (tenant.status === 'ready' || tenant.status === 'degraded')) {
      reqCtx.res.writeHead(302, { Location: '/app/' });
      reqCtx.res.end();
      return;
    }
  }

  const base = path.resolve(app.config.loginBundleDir);
  const rel =
    reqCtx.path === '/' || reqCtx.path === '/login' ? 'index.html' : reqCtx.path.slice(1);
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base + path.sep)) {
    writeError(reqCtx.res, 404, 'NOT_FOUND', 'not found');
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    writeError(reqCtx.res, 404, 'NOT_FOUND', 'not found');
    return;
  }

  const ext = path.extname(file).toLowerCase();
  const isHtml = ext === '.html';
  reqCtx.res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(file).pipe(reqCtx.res);
}

export const loginRoutes: Route[] = [
  { method: 'GET', path: '/', handler: serveLoginBundle },
  { method: 'GET', path: '/login', handler: serveLoginBundle },
  { method: 'GET', path: '/*', handler: serveLoginBundle },
];
