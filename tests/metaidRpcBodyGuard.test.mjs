/**
 * Regression coverage for the gateway-wide JSON object body guard.
 *
 * Every POST route on the local MetaID RPC gateway used to read its own body
 * inline and then read a property off `JSON.parse(body)`. `JSON.parse` accepts
 * `null`, arrays and scalars, so such a body reached a property read that threw
 * inside the async request handler: the caller received NO response (the
 * request hung until it timed out) and the process logged an unhandled
 * rejection. This file drives the real compiled gateway over real HTTP, one
 * request per route, and asserts the guard's contract instead.
 *
 * The route list is derived from the server source, so a newly added POST route
 * is covered without touching this file, and the only allowed exception is
 * asserted explicitly.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const RPC_SERVER_SOURCE = new URL('../src/main/services/metaidRpcServer.ts', import.meta.url);

/**
 * The one POST route this guard does not own: `/api/idbots/wallet/transfer`
 * gets the same treatment from the wallet-transfer field-contract change
 * (its rejections already carry a per-route contract), so keeping its inline
 * read here avoids two conflicting edits to the same hunk.
 */
const UNGUARDED_POST_ROUTES = ['/api/idbots/wallet/transfer'];

/**
 * Accepted body fields of the routes that advertise a field contract.
 *
 * Hard-coded from the routes' own validation logic on purpose: the test must
 * fail if the implementation's table drifts from what the routes actually read,
 * so it is not allowed to be derived from that table.
 */
const EXPECTED_FIELD_CONTRACTS = {
  '/api/idbots/resolve-metabot-id': ['name'],
  '/api/idbots/metabot/account-summary': ['metabot_id'],
  '/api/idbots/address/balance': ['addresses', 'metabot_id'],
  '/api/idbots/wallet/balance': ['address', 'chain', 'metabot_id', 'metabot_ids'],
  '/api/idbots/wallet/transfer/records': ['limit', 'metabot_id'],
  '/api/idbots/wallet/btc/sign-message': ['encoding', 'message', 'metabot_id'],
  '/api/idbots/wallet/mrc20/transfer': [
    'amount',
    'decimal',
    'fee_rate',
    'mrc20_id',
    'metabot_id',
    'symbol',
    'to_address',
  ],
  '/api/idbots/group-task/list': ['status'],
  '/api/idbots/group-task/show': ['before_id', 'limit', 'task_id', 'view'],
};

const unhandledRejections = [];
process.on('unhandledRejection', (reason) => {
  unhandledRejections.push(reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason));
});

function readRpcServerSource() {
  return fs.readFileSync(RPC_SERVER_SOURCE, 'utf8');
}

/** Every POST route the gateway dispatches, read out of its own source. */
function listPostRoutes(source) {
  const constants = new Map();
  for (const match of source.matchAll(/^const ([A-Z0-9_]+_PATH) = '([^']+)';$/gm)) {
    constants.set(match[1], match[2]);
  }

  const routes = [];
  for (const match of source.matchAll(/req\.method === 'POST' && pathname === ([A-Z0-9_]+)\)/g)) {
    const routePath = constants.get(match[1]);
    assert.ok(routePath, `unresolved route constant in source: ${match[1]}`);
    routes.push(routePath);
  }

  // `/api/metaid/create-pin` is the fall-through route (negative guard), so the
  // pattern above cannot see it.
  const createPin = source.match(/req\.method !== 'POST' \|\| pathname !== '([^']+)'/);
  assert.ok(createPin, 'create-pin fall-through guard not found in the gateway source');
  routes.push(createPin[1]);

  return routes;
}

const POST_ROUTES = listPostRoutes(readRpcServerSource());
const GUARDED_POST_ROUTES = POST_ROUTES.filter((route) => !UNGUARDED_POST_ROUTES.includes(route));

// Pin the bearer token for this process: the gateway mirrors its token into
// <userData>/metaid-rpc-token (userData is mocked to os.tmpdir() here) and
// adopts a leftover mirror, which would mismatch this run's client token.
process.env.IDBOTS_RPC_TOKEN = process.env.IDBOTS_RPC_TOKEN || 'test-rpc-token-body-guard';

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 1) return null;
      return {
        id: 1,
        name: 'Trader',
        mvc_address: '1MvcAddress',
        btc_address: '1BtcAddress',
        doge_address: 'DogeAddress',
        public_key: 'pub-key',
      };
    },
    getMetabotWalletByMetabotId(id) {
      if (id !== 1) return null;
      return { mnemonic: 'test mnemonic', path: "m/44'/10001'/0'/0/0" };
    },
  };
}

function resolveCompiledMetaidRpcServerPath() {
  return require.resolve('../dist-electron/main/services/metaidRpcServer.js');
}

function resolveCompiledMetaidRpcEndpointPath() {
  return require.resolve('../dist-electron/main/services/metaidRpcEndpoint.js');
}

const { getMetaidRpcToken } = require(resolveCompiledMetaidRpcEndpointPath());
const RPC_AUTH_HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${getMetaidRpcToken()}`,
};

async function startRpcServerForTest() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          getPath() {
            return os.tmpdir();
          },
          getAppPath() {
            return process.cwd();
          },
        },
        BrowserWindow: {
          getAllWindows() {
            return [];
          },
        },
      };
    }
    if (request === './httpListenWithRetry' || request.endsWith('/httpListenWithRetry')) {
      return {
        listenWithRetry(server, _port, host, options = {}) {
          server.listen(0, host, () => {
            if (typeof options.onListening === 'function') options.onListening();
          });
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  let startMetaidRpcServer;
  try {
    const compiledPath = resolveCompiledMetaidRpcServerPath();
    delete require.cache[compiledPath];
    ({ startMetaidRpcServer } = require(compiledPath));
  } finally {
    Module._load = originalLoad;
  }

  const server = startMetaidRpcServer(
    () => createMetabotStore(),
    () => ({
      getDatabase() {
        return {};
      },
      getSaveFunction() {
        return () => {};
      },
    }),
    () => ({
      listUserMemories() {
        return [];
      },
      createUserMemory() {
        throw new Error('memory routes are not exercised in this test');
      },
    }),
  );

  await new Promise((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : null;
  if (!port) {
    server.close();
    throw new Error('failed to resolve test server port');
  }

  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

let server;
let baseUrl;

before(async () => {
  ({ server, baseUrl } = await startRpcServerForTest());
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/**
 * POST a raw body. A request that never gets a response is reported as
 * `status: 0` instead of hanging the test run — that is exactly the failure
 * mode this file exists to catch.
 */
async function postRaw(route, rawBody) {
  try {
    const response = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: rawBody,
      signal: AbortSignal.timeout(4000),
    });
    return { status: response.status, json: await response.json() };
  } catch (err) {
    return { status: 0, json: null, transportError: `${err.name}: ${err.message}` };
  }
}

test('gateway exposes the expected POST routes', () => {
  assert.ok(POST_ROUTES.length >= 30, `expected a full route sweep, got ${POST_ROUTES.length}`);
  assert.deepEqual(
    POST_ROUTES.filter((route) => !GUARDED_POST_ROUTES.includes(route)),
    UNGUARDED_POST_ROUTES,
    'the set of routes outside the shared body guard changed',
  );
});

test('every POST route rejects a JSON null body with 400, a contract, and a response', async () => {
  const failures = [];
  for (const route of GUARDED_POST_ROUTES) {
    const { status, json } = await postRaw(route, 'null');
    if (status !== 400) {
      failures.push(`${route}: status ${status} (expected 400)`);
      continue;
    }
    if (json?.success !== false) failures.push(`${route}: success !== false`);
    if (!/expected a JSON object \(received null\)/.test(String(json?.error))) {
      failures.push(`${route}: error = ${JSON.stringify(json?.error)}`);
    }
    if (json?.contract?.path !== route) {
      failures.push(`${route}: contract.path = ${JSON.stringify(json?.contract?.path)}`);
    }
    if (json?.contract?.body !== 'JSON object') failures.push(`${route}: contract.body missing`);
  }
  assert.deepEqual(failures, [], `null-body sweep failures:\n${failures.join('\n')}`);
});

test('every POST route rejects non-object JSON literals instead of guessing fields', async () => {
  const cases = [
    { raw: '[1,2,3]', received: 'array' },
    { raw: '"a string"', received: 'string' },
    { raw: '42', received: 'number' },
    { raw: 'true', received: 'boolean' },
  ];
  const failures = [];
  for (const route of GUARDED_POST_ROUTES) {
    for (const { raw, received } of cases) {
      const { status, json } = await postRaw(route, raw);
      if (status !== 400) {
        failures.push(`${route} + ${raw}: status ${status} (expected 400)`);
        continue;
      }
      if (!new RegExp(`expected a JSON object \\(received ${received}\\)`).test(String(json?.error))) {
        failures.push(`${route} + ${raw}: error = ${JSON.stringify(json?.error)}`);
      }
      if (json?.contract?.path !== route) {
        failures.push(`${route} + ${raw}: contract.path = ${JSON.stringify(json?.contract?.path)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `non-object sweep failures:\n${failures.join('\n')}`);
});

test('malformed JSON keeps the historical "Invalid JSON body" message', async () => {
  for (const route of ['/api/idbots/wallet/balance', '/api/idbots/resolve-metabot-id', '/api/idbots/group-task/show']) {
    const { status, json } = await postRaw(route, '{"metabot_id": ');
    assert.equal(status, 400, `${route} should reject malformed JSON`);
    assert.equal(json.error, 'Invalid JSON body');
    assert.equal(json.contract.path, route);
  }
});

test('an empty body means {} — no route hangs and required fields are still reported', async () => {
  const resolveRoute = await postRaw('/api/idbots/resolve-metabot-id', '');
  assert.equal(resolveRoute.status, 400);
  assert.equal(resolveRoute.json.error, 'name is required');

  const showRoute = await postRaw('/api/idbots/group-task/show', '');
  assert.equal(showRoute.status, 400);
  assert.equal(showRoute.json.error, 'task_id is required');

  const balanceRoute = await postRaw('/api/idbots/wallet/balance', '');
  assert.equal(balanceRoute.status, 400);
  assert.match(String(balanceRoute.json.error), /metabot_id, metabot_ids, or address is required/);

  const stalled = [];
  for (const route of GUARDED_POST_ROUTES) {
    const { status } = await postRaw(route, '');
    if (status === 0) stalled.push(route);
  }
  assert.deepEqual(stalled, [], `routes that returned no response for an empty body:\n${stalled.join('\n')}`);
});

test('the ledger-named routes advertise the fields their validation actually reads', async () => {
  for (const [route, expectedFields] of Object.entries(EXPECTED_FIELD_CONTRACTS)) {
    assert.ok(POST_ROUTES.includes(route), `${route} is not a POST route of the gateway`);
    const { status, json } = await postRaw(route, 'null');
    assert.equal(status, 400, `${route} should reject a null body`);
    assert.deepEqual(
      Object.keys(json.contract.fields ?? {}).sort(),
      [...expectedFields].sort(),
      `${route} field contract drifted`,
    );
  }
});

test('no gateway route reads its request body inline any more', () => {
  const source = readRpcServerSource();
  const inlineLoops = (source.match(/for await \(const chunk of req\)/g) || []).length;
  assert.equal(
    inlineLoops,
    UNGUARDED_POST_ROUTES.length,
    `expected the inline body read to survive only for ${UNGUARDED_POST_ROUTES.join(', ')}`,
  );
  assert.match(source, /readRpcJsonObjectBody\(/, 'the shared body guard is not wired into the gateway');
});

test('the sweep raised no unhandled rejection', async () => {
  // Rejections surface on the next microtask turn; give them room to land.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(unhandledRejections, []);
});
