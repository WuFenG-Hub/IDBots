import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isOriginAllowed } from '../src/origin.js';

const PUBLIC = 'https://app.idbots.example.com';

describe('origin checks (REQ-B-8)', () => {
  test('the exact deployment origin is allowed', () => {
    assert.equal(isOriginAllowed(PUBLIC, PUBLIC), true);
    assert.equal(isOriginAllowed('https://staging.idbots.example.com', 'https://staging.idbots.example.com'), true);
  });

  test('a different scheme, host, or port is rejected', () => {
    assert.equal(isOriginAllowed('http://app.idbots.example.com', PUBLIC), false);
    assert.equal(isOriginAllowed('https://evil.idbots.example.com', PUBLIC), false);
    assert.equal(isOriginAllowed('https://app.idbots.example.com:8443', PUBLIC), false);
    assert.equal(isOriginAllowed('https://app.idbots.example.com.evil.com', PUBLIC), false);
  });

  test('default ports normalize (browser Origin headers omit :443)', () => {
    assert.equal(isOriginAllowed('https://app.idbots.example.com:443', PUBLIC), true);
    assert.equal(isOriginAllowed('http://app.idbots.example.com:80', 'http://app.idbots.example.com'), true);
    assert.equal(isOriginAllowed('http://app.idbots.example.com:8080', 'http://app.idbots.example.com'), false);
  });

  test('missing or malformed origins are rejected', () => {
    assert.equal(isOriginAllowed(undefined, PUBLIC), false);
    assert.equal(isOriginAllowed('', PUBLIC), false);
    assert.equal(isOriginAllowed('not-a-url', PUBLIC), false);
  });
});
