import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import type Database from 'better-sqlite3';
import { FakeDocker } from './fake-docker/index.mjs';
import { api, freshDb, insertInvite, sessionCookieFrom, startTestApp, type TestApp } from './helpers.js';
import { TenantPoller } from '../src/services/poller.js';

const PLACEHOLDER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../static-login');

async function signup(t: {
  db: Database.Database;
  app: TestApp;
  cpBase: string;
  phone: string;
}): Promise<string> {
  insertInvite(t.db, { code: 'LOGIN-1', maxUses: 5, now: Date.now() });
  await api(t.cpBase, '/api/v1/auth/sms/send', {
    method: 'POST',
    body: { phone: t.phone, purpose: 'login' },
  });
  const verify = await api(t.cpBase, '/api/v1/auth/sms/verify', {
    method: 'POST',
    body: { phone: t.phone, code: '246810', inviteCode: 'LOGIN-1' },
  });
  assert.equal(verify.status, 200);
  return sessionCookieFrom(verify.setCookie);
}

describe('login bundle (REQ-B-19)', () => {
  let db: Database.Database;
  let fake: FakeDocker;
  let app: TestApp;
  let poller: TenantPoller;
  let bundleDir: string;
  let cpBase: string;
  let cookie: string;

  before(async () => {
    db = freshDb();
    fake = new FakeDocker();
    await fake.listen(0);
    bundleDir = mkdtempSync(path.join(tmpdir(), 'cp-login-bundle-'));
    writeFileSync(path.join(bundleDir, 'index.html'), '<!doctype html><title>fixture login</title><h1>fixture login bundle</h1>');
    mkdirSync(path.join(bundleDir, 'assets'));
    writeFileSync(path.join(bundleDir, 'assets', 'app.fake123.js'), 'console.log("fixture");');

    app = await startTestApp({
      db,
      dockerUrl: fake.url(),
      fakeSmsNumbers: ['+8613900009101'],
      loginBundleDir: bundleDir,
    });
    cpBase = app.baseUrl;
    poller = new TenantPoller(app.app, { tickFastMs: 50, tickSlowMs: 100 });
    poller.start();
    cookie = await signup({ db, app, cpBase, phone: '+8613900009101' });
  });

  after(async () => {
    await poller.stop();
    await app.close();
    await fake.close();
    db.close();
  });

  test('no cookie: / and /login serve the bundle; assets are immutable', async () => {
    const root = await fetch(`${cpBase}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /fixture login bundle/);
    assert.equal(root.headers.get('cache-control'), 'no-cache');

    const login = await fetch(`${cpBase}/login`);
    assert.equal(login.status, 200);
    assert.match(await login.text(), /fixture login bundle/);

    const asset = await fetch(`${cpBase}/assets/app.fake123.js`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    const missing = await fetch(`${cpBase}/nope.txt`);
    assert.equal(missing.status, 404);
  });

  test('a ready tenant redirects the visitor to /app/', async () => {
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const row = db.prepare("SELECT status FROM tenants WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+8613900009101')").get() as
          | { status: string }
          | undefined;
        if (row?.status === 'ready') {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
    const res = await fetch(`${cpBase}/`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/app/');
  });

  test('a non-ready tenant still gets the bundle (the JS shows preparing)', async () => {
    db.prepare("UPDATE tenants SET status = 'provisioning' WHERE user_id = (SELECT id FROM users WHERE phone_e164 = '+8613900009101')").run();
    const res = await fetch(`${cpBase}/`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /fixture login bundle/);
  });

  test('the placeholder serves when no bundle dir is configured', async () => {
    const app2 = await startTestApp({
      db: freshDb(),
      dockerUrl: fake.url(),
      loginBundleDir: PLACEHOLDER_DIR,
    });
    try {
      const res = await fetch(`${app2.baseUrl}/`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /Preparing your Bot/);
    } finally {
      await app2.close();
    }
  });
});
