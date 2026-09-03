import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function jsonResponse(body) {
  return { ok: true, status: 200, async json() { return body; } };
}

const MVC_ADDR_1 = '1RpcMvcOne';
const MVC_ADDR_2 = '1RpcMvcTwo';
const EXTERNAL_ADDR = '1RpcExternal';

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 1 && id !== 2) return null;
      return {
        id,
        name: id === 1 ? 'Twin' : 'Worker',
        mvc_address: id === 1 ? MVC_ADDR_1 : MVC_ADDR_2,
        btc_address: `1RpcBtc${id}`,
        doge_address: `DogeRpc${id}`,
        public_key: 'pk',
      };
    },
    listMetabots() {
      return [
        { id: 1, mvc_address: MVC_ADDR_1 },
        { id: 2, mvc_address: MVC_ADDR_2 },
      ];
    },
  };
}

/** Minimal kv + bot_wallet_transfers fake backing the RPC handlers. */
function createSqlStoreFake() {
  const kv = new Map();
  const rows = [];
  let nextId = 1;
  return {
    get: (key) => kv.get(key),
    set: (key, value) => kv.set(key, value),
    getDatabase() {
      const db = {
        run(sql, params) {
          if (String(sql).startsWith('INSERT INTO bot_wallet_transfers')) {
            rows.push({ id: nextId++, raw: params });
            return;
          }
          if (/CREATE (TABLE|INDEX)/i.test(String(sql))) return;
          throw new Error(`unexpected db.run in test: ${String(sql).slice(0, 60)}`);
        },
        exec(sql, params) {
          if (/SELECT \* FROM bot_wallet_transfers/i.test(String(sql))) {
            return [{
              columns: ['id'],
              values: rows.map((row) => [row.id]),
            }];
          }
          if (/CREATE (TABLE|INDEX)/i.test(String(sql))) return [];
          throw new Error(`unexpected db.exec in test: ${String(sql).slice(0, 60)}`);
        },
      };
      return db;
    },
    getSaveFunction() {
      return () => {};
    },
  };
}

function resolveCompiledMetaidRpcServerPath() {
  const candidates = [
    '../dist-electron/services/metaidRpcServer.js',
    '../dist-electron/main/services/metaidRpcServer.js',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // try next layout
    }
  }
  return require.resolve(candidates[0]);
}

function resolveCompiledMetaidRpcEndpointPath() {
  const candidates = [
    '../dist-electron/services/metaidRpcEndpoint.js',
    '../dist-electron/main/services/metaidRpcEndpoint.js',
  ];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // try next layout
    }
  }
  return require.resolve(candidates[0]);
}

const { getMetaidRpcToken } = require(resolveCompiledMetaidRpcEndpointPath());
const RPC_TOKEN = getMetaidRpcToken();
const RPC_AUTH_HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${RPC_TOKEN}` };

async function startRpcServerForTestWithOverrides({ transferService = null } = {}) {
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
        BrowserWindow: { getAllWindows() { return []; } },
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
    if (transferService && (request === './transferService' || request.endsWith('/transferService'))) {
      return transferService;
    }
    return originalLoad(request, parent, isMain);
  };

  let startMetaidRpcServer;
  try {
    const compiledRpcServerPath = resolveCompiledMetaidRpcServerPath();
    delete require.cache[compiledRpcServerPath];
    // walletTransferService captures the (possibly stubbed) transferService
    // at load time — drop it too so each test re-binds the stub.
    try {
      delete require.cache[require.resolve('../dist-electron/main/services/walletTransferService.js')];
    } catch {
      // first run: not cached yet
    }
    ({ startMetaidRpcServer } = require(compiledRpcServerPath));
  } finally {
    Module._load = originalLoad;
  }

  const sqliteFake = createSqlStoreFake();
  const server = startMetaidRpcServer(
    () => createMetabotStore(),
    () => sqliteFake,
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
  return { server, baseUrl: `http://127.0.0.1:${port}`, sqliteFake };
}

/** Metalet stub: fixed UTXO sums per address so assertions stay exact. */
function installMetaletFetchStub({ mvcTotal = 1_000_000 } = {}) {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const href = String(url);
    // Requests to the local test RPC server pass through untouched.
    if (href.startsWith('http://127.0.0.1:')) {
      return originalFetch(url, options);
    }
    if (href.includes('/wallet-api/v4/mvc/address/utxo-list')) {
      if (href.includes(encodeURIComponent(MVC_ADDR_1))) {
        return jsonResponse({
          code: 0,
          data: { list: [{ txid: 'a', outIndex: 0, value: mvcTotal - 100, height: 5 }, { txid: 'b', outIndex: 1, value: 100, height: -1 }] },
        });
      }
      return jsonResponse({ code: 0, data: { list: [{ txid: 'c', outIndex: 0, value: 300, height: 5 }] } });
    }
    if (href.includes('/wallet-api/v4/doge/address/utxo-list')) {
      return jsonResponse({ code: 0, data: { list: [] } });
    }
    if (href.includes('/wallet-api/v3/address/btc-utxo')) {
      return jsonResponse({ code: 0, data: [] });
    }
    throw new Error(`unexpected fetch in rpc wallet tools test: ${href}`);
  };
  return () => {
    global.fetch = originalFetch;
  };
}

test('wallet/balance returns confirmed/unconfirmed/total per chain for one bot', async () => {
  const restore = installMetaletFetchStub();
  const { server, baseUrl } = await startRpcServerForTestWithOverrides();
  try {
    const response = await fetch(`${baseUrl}/api/idbots/wallet/balance`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ metabot_id: 1 }),
    });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.ok(json.queried_at);
    const entry = json.results[0];
    assert.equal(entry.metabot_id, 1);
    assert.equal(entry.balances.mvc.confirmed_sats, 999_900);
    assert.equal(entry.balances.mvc.unconfirmed_sats, 100);
    assert.equal(entry.balances.mvc.total_sats, 1_000_000);
    assert.equal(entry.balances.btc.total_sats, 0);
    assert.equal(entry.balances.doge.total_sats, 0);
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('wallet/balance batches metabot_ids and honors chain filter; validates input', async () => {
  const restore = installMetaletFetchStub();
  const { server, baseUrl } = await startRpcServerForTestWithOverrides();
  try {
    const batch = await fetch(`${baseUrl}/api/idbots/wallet/balance`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ metabot_ids: [1, 2], chain: 'mvc' }),
    });
    const batchJson = await batch.json();
    assert.equal(batch.status, 200);
    assert.equal(batchJson.results.length, 2);
    assert.ok(batchJson.results[0].balances.mvc);
    assert.equal(batchJson.results[0].balances.btc, undefined);

    const addressOnly = await fetch(`${baseUrl}/api/idbots/wallet/balance`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ address: MVC_ADDR_2, chain: 'mvc' }),
    });
    const addressJson = await addressOnly.json();
    assert.equal(addressJson.results[0].address, MVC_ADDR_2);
    assert.equal(addressJson.results[0].balances.mvc.total_sats, 300);

    const badChain = await fetch(`${baseUrl}/api/idbots/wallet/balance`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ metabot_id: 1, chain: 'eth' }),
    });
    assert.equal(badChain.status, 400);

    const empty = await fetch(`${baseUrl}/api/idbots/wallet/balance`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(empty.status, 400);
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('wallet/mvc/transfer channel A executes via executeTransfer and returns txid+audit', async () => {
  const restore = installMetaletFetchStub({ mvcTotal: 10_000_000 });
  const calls = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    transferService: {
      executeTransfer: async (_store, params) => {
        calls.push(params);
        return { success: true, txId: 'rpc-tx-local' };
      },
    },
  });
  try {
    const response = await fetch(`${baseUrl}/api/idbots/wallet/mvc/transfer`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ metabot_id: 1, to: MVC_ADDR_2, amount_sats: 100_000, memo: 'topup' }),
    });
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.success, true);
    assert.equal(json.txid, 'rpc-tx-local');
    assert.equal(json.channel, 'local');
    assert.equal(json.to_metabot_id, 2);
    assert.ok(json.audit_id > 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].chain, 'mvc');
    assert.equal(calls[0].amountSpaceOrDoge, '0.00100000');

    const records = await fetch(`${baseUrl}/api/idbots/wallet/transfer/records`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({}),
    });
    const recordsJson = await records.json();
    assert.equal(records.status, 200);
    assert.equal(recordsJson.records.length, 1);
    assert.equal(recordsJson.records[0].id, json.audit_id);
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('wallet/mvc/transfer external target without acknowledgement is refused with no chain call', async () => {
  const restore = installMetaletFetchStub({ mvcTotal: 10_000_000 });
  const calls = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    transferService: {
      executeTransfer: async () => {
        calls.push('called');
        return { success: true, txId: 'never' };
      },
    },
  });
  try {
    const response = await fetch(`${baseUrl}/api/idbots/wallet/mvc/transfer`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ metabot_id: 1, to: EXTERNAL_ADDR, amount_sats: 100_000 }),
    });
    const json = await response.json();
    assert.equal(response.status, 400);
    assert.equal(json.success, false);
    assert.equal(json.error_code, 'external_transfer_confirmation_required');
    assert.equal(calls.length, 0);
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('wallet/mvc/transfer insufficient balance returns structured have/need and no chain call', async () => {
  const restore = installMetaletFetchStub({ mvcTotal: 500 });
  const calls = [];
  const { server, baseUrl } = await startRpcServerForTestWithOverrides({
    transferService: {
      executeTransfer: async () => {
        calls.push('called');
        return { success: true, txId: 'never' };
      },
    },
  });
  try {
    const response = await fetch(`${baseUrl}/api/idbots/wallet/mvc/transfer`, {
      method: 'POST',
      headers: RPC_AUTH_HEADERS,
      body: JSON.stringify({ metabot_id: 1, to: MVC_ADDR_2, amount_sats: 100_000 }),
    });
    const json = await response.json();
    assert.equal(response.status, 400);
    assert.equal(json.error_code, 'insufficient_balance');
    assert.equal(json.have_sats, 500);
    assert.ok(json.need_sats > 100_000);
    assert.match(json.error, /insufficient balance: have 500 sats/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
    await new Promise((resolve) => server.close(resolve));
  }
});
