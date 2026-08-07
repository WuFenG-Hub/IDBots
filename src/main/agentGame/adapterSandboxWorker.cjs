/**
 * Adapter sandbox Worker entry (CommonJS, runs under worker_threads).
 *
 * Loads the third-party `adapter.js` (ESM) via dynamic import, validates the
 * frozen ABI shape, and exposes the 10 functions over message RPC. The host
 * thread enforces timeouts and the canonical output-size cap; this Worker also
 * applies a secondary cap as defense in depth.
 *
 * The Worker intentionally exposes NO host capabilities: no network, fs,
 * wallet, host bridge, or access to other groups. Adapter functions are
 * required to be deterministic and side-effect free.
 */

'use strict';

const { parentPort, workerData } = require('worker_threads');

/** Secondary output cap (the authoritative cap lives on the main thread). */
const WORKER_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

const REQUIRED_EXPORTS = [
  'createMatch',
  'initialState',
  'reduce',
  'getTurn',
  'getObservation',
  'getActionSchema',
  'parseAction',
  'validateAction',
  'serializeState',
  'getResult',
];

function fail(id, message, code) {
  parentPort.postMessage({ id, ok: false, error: { message, code } });
}

function ok(id, result) {
  parentPort.postMessage({ id, ok: true, result });
}

function boundOutput(result) {
  if (result === undefined) return result;
  const json = JSON.stringify(result);
  if (Buffer.byteLength(json, 'utf8') > WORKER_MAX_OUTPUT_BYTES) {
    throw new Error(`adapter output exceeded ${WORKER_MAX_OUTPUT_BYTES} bytes`);
  }
  return result;
}

(async () => {
  const { adapterPath } = workerData;
  let mod;
  try {
    // Dynamic import supports both ESM .js and .mjs adapters.
    mod = await import(adapterPath.startsWith('file://') ? adapterPath : `file://${adapterPath}`);
  } catch (err) {
    parentPort.postMessage({
      id: '__load__',
      ok: false,
      error: { message: `failed to import adapter: ${err && err.message ? err.message : String(err)}`, code: 'adapter_invalid' },
    });
    return;
  }

  const missing = REQUIRED_EXPORTS.filter((fn) => typeof mod[fn] !== 'function');
  if (missing.length > 0) {
    parentPort.postMessage({
      id: '__load__',
      ok: false,
      error: { message: `adapter missing exports: ${missing.join(', ')}`, code: 'adapter_invalid' },
    });
    return;
  }

  ok('__load__', { loaded: true });

  parentPort.on('message', async (req) => {
    const { id, fn, args } = req;
    const handler = mod[fn];
    if (typeof handler !== 'function') {
      fail(id, `adapter has no function '${fn}'`, 'adapter_error');
      return;
    }
    try {
      const result = await Promise.resolve().then(() => handler(...args));
      ok(id, boundOutput(result));
    } catch (err) {
      fail(id, err && err.message ? err.message : String(err), 'adapter_error');
    }
  });
})().catch((err) => {
  parentPort.postMessage({
    id: '__load__',
    ok: false,
    error: { message: `worker bootstrap failed: ${err && err.message ? err.message : String(err)}`, code: 'adapter_invalid' },
  });
});
