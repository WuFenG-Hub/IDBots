import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  clearSessionCookie,
  parseCookieHeader,
  serializeSessionCookie,
  sessionTokenFromCookieHeader,
} from '../src/cookies.js';

const NOW = 1_800_000_000_000;
const TOKEN = 'session-token-abc123';

describe('idb_session cookie', () => {
  test('carries HttpOnly, Secure, SameSite=Strict, Path=/ and a 30-day expiry', () => {
    const cookie = serializeSessionCookie(TOKEN, NOW);
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE_NAME}=`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, new RegExp(`Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`));
    const expires = /Expires=([^;]+)/.exec(cookie)?.[1];
    assert.equal(Date.parse(expires ?? ''), NOW + SESSION_TTL_MS);
  });

  test('round-trips through parseCookieHeader', () => {
    const cookie = serializeSessionCookie(TOKEN, NOW);
    const pair = cookie.split(';')[0];
    const parsed = parseCookieHeader(`other=1; ${pair}; another=x`);
    assert.equal(parsed[SESSION_COOKIE_NAME], TOKEN);
    assert.equal(sessionTokenFromCookieHeader(`other=1; ${pair}`), TOKEN);
  });

  test('missing cookie header parses to an empty map', () => {
    assert.deepEqual(parseCookieHeader(undefined), {});
    assert.equal(sessionTokenFromCookieHeader(undefined), null);
  });

  test('sliding expiry refreshes on every issue', () => {
    const first = serializeSessionCookie(TOKEN, NOW);
    const later = serializeSessionCookie(TOKEN, NOW + 3_600_000);
    const firstExpires = /Expires=([^;]+)/.exec(first)?.[1];
    const laterExpires = /Expires=([^;]+)/.exec(later)?.[1];
    assert.notEqual(firstExpires, laterExpires);
    assert.equal(Date.parse(laterExpires ?? ''), Date.parse(firstExpires ?? '') + 3_600_000);
  });

  test('logout clear-cookie expires immediately', () => {
    const cleared = clearSessionCookie(NOW);
    assert.match(cleared, new RegExp(`^${SESSION_COOKIE_NAME}=`));
    assert.match(cleared, /Max-Age=0/);
    const expires = /Expires=([^;]+)/.exec(cleared)?.[1];
    assert.ok(Date.parse(expires ?? '') < NOW);
    assert.match(cleared, /HttpOnly/);
    assert.match(cleared, /SameSite=Strict/);
  });
});
