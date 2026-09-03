import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveCompiled(rel) {
  const candidates = [`../dist-electron/${rel}`, `../dist-electron/main/${rel}`];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // try next compile output layout
    }
  }
  return require.resolve(candidates[0]);
}


/**
 * walletTransferService imports transferService (which pulls Electron), so
 * the loader stubs both modules the same way the RPC route tests do.
 */
function loadWalletTransferService({ executeTransfer } = {}) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: { getPath: () => '/tmp', getAppPath: () => process.cwd() },
      };
    }
    if (executeTransfer && (request === './transferService' || request.endsWith('/transferService'))) {
      return { executeTransfer };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const path = resolveCompiled('services/walletTransferService.js');
    delete require.cache[path];
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

const MVC_ADDR_1 = '1MvcBotOne';
const MVC_ADDR_2 = '1MvcBotTwo';
const EXTERNAL_ADDR = '1ExternalTarget';

function createMetabotStore() {
  return {
    getMetabotById(id) {
      if (id !== 1 && id !== 2) return null;
      return {
        id,
        name: id === 1 ? 'Twin' : 'Worker',
        mvc_address: id === 1 ? MVC_ADDR_1 : MVC_ADDR_2,
        btc_address: `1BtcAddr${id}`,
        doge_address: `DogeAddr${id}`,
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

function createTransferLedger() {
  const records = [];
  let nextId = 1;
  return {
    records,
    record(input) {
      const created = { id: nextId++, ...input };
      records.push(created);
      return created;
    },
    list(limit = 50, metabotId) {
      return records
        .filter((record) => metabotId == null || record.metabotId === metabotId)
        .slice(-limit)
        .reverse();
    },
  };
}

function snapshotWith(totalSats) {
  return async () => ({
    chain: 'mvc',
    address: MVC_ADDR_1,
    unit: 'SPACE',
    confirmed_sats: totalSats,
    unconfirmed_sats: 0,
    total_sats: totalSats,
    utxo_count: 1,
  });
}

function baseDeps({ balanceSats = 10_000_000, settings, confirmExternal, executeTransfer } = {}) {
  const ledger = createTransferLedger();
  return {
    ledger,
    deps: {
      metabotStore: createMetabotStore(),
      transferStore: ledger,
      ...(confirmExternal ? { confirmExternal } : {}),
      ...(settings != null ? { settingsReader: { get: (key) => settings[key] } } : {}),
      getFeeRate: () => 1,
      executeTransferImpl: executeTransfer,
      getBalanceSnapshotImpl: snapshotWith(balanceSats),
    },
  };
}

test('channel A: local-roster target transfers without confirmation and audits the broadcast', async () => {
  const calls = [];
  const { executeWalletMvcTransfer } = loadWalletTransferService({
    executeTransfer: async (_store, params) => {
      calls.push(params);
      return { success: true, txId: 'tx-local-1' };
    },
  });
  let confirmAsked = 0;
  const { deps, ledger } = baseDeps({
    confirmExternal: async () => {
      confirmAsked++;
      return true;
    },
    executeTransfer: async (_store, params) => {
      calls.push(params);
      return { success: true, txId: 'tx-local-1' };
    },
  });

  const result = await executeWalletMvcTransfer(deps, {
    metabotId: 1,
    to: MVC_ADDR_2,
    amountSats: 100_000,
    memo: 'topup',
    sessionId: 'session-1',
  });

  assert.equal(result.success, true);
  assert.equal(result.txid, 'tx-local-1');
  assert.equal(result.channel, 'local');
  assert.equal(result.to_metabot_id, 2);
  assert.ok(result.audit_id > 0);
  assert.equal(confirmAsked, 0, 'local transfers must not trigger the owner dialog');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].chain, 'mvc');
  assert.equal(calls[0].toAddress, MVC_ADDR_2);
  assert.equal(calls[0].amountSpaceOrDoge, '0.00100000');
  assert.equal(calls[0].feeRate, 1);

  const record = ledger.records[0];
  assert.equal(record.status, 'broadcast');
  assert.equal(record.txid, 'tx-local-1');
  assert.equal(record.channel, 'local');
  assert.equal(record.toMetabotId, 2);
  assert.equal(record.amountSats, 100_000);
  assert.equal(record.feeSats, 200);
  assert.equal(record.sessionId, 'session-1');
});

test('channel B default: external target without owner approval is refused pre-chain', async () => {
  const calls = [];
  const { executeWalletMvcTransfer } = loadWalletTransferService({
    executeTransfer: async () => {
      calls.push('called');
      return { success: true, txId: 'should-not-happen' };
    },
  });
  const { deps, ledger } = baseDeps({ executeTransfer: async () => { calls.push('called'); return { success: true, txId: 'x' }; } });

  const result = await executeWalletMvcTransfer(deps, {
    metabotId: 1,
    to: EXTERNAL_ADDR,
    amountSats: 100_000,
  });

  assert.equal(result.success, false);
  assert.equal(result.error_code, 'external_transfer_confirmation_required');
  assert.equal(calls.length, 0, 'refused transfers must never reach the chain');
  assert.equal(ledger.records[0].status, 'refused');
  assert.equal(ledger.records[0].channel, 'external');
});

test('channel B dialog: approved external transfer executes; declined does not', async () => {
  const calls = [];
  const execute = async () => {
    calls.push('called');
    return { success: true, txId: 'tx-ext-1' };
  };
  const { executeWalletMvcTransfer } = loadWalletTransferService({ executeTransfer: execute });

  const approved = await executeWalletMvcTransfer(
    baseDeps({ confirmExternal: async () => true, executeTransfer: execute }).deps,
    { metabotId: 1, to: EXTERNAL_ADDR, amountSats: 100_000 },
  );
  assert.equal(approved.success, true);
  assert.equal(approved.channel, 'external');
  assert.equal(approved.to_metabot_id, null);
  assert.equal(calls.length, 1);

  const declined = await executeWalletMvcTransfer(
    baseDeps({ confirmExternal: async () => false, executeTransfer: execute }).deps,
    { metabotId: 1, to: EXTERNAL_ADDR, amountSats: 100_000 },
  );
  assert.equal(declined.success, false);
  assert.equal(declined.error_code, 'external_transfer_declined');
  assert.equal(calls.length, 1, 'declined transfers must not execute');
});

test('channel B gate disabled in settings: external transfer goes straight through', async () => {
  const calls = [];
  const execute = async () => {
    calls.push('called');
    return { success: true, txId: 'tx-ext-2' };
  };
  const { executeWalletMvcTransfer } = loadWalletTransferService({ executeTransfer: execute });
  let confirmAsked = 0;

  const result = await executeWalletMvcTransfer(
    baseDeps({
      settings: { wallet_transfer_external_confirm_enabled: false },
      confirmExternal: async () => {
        confirmAsked++;
        return false;
      },
      executeTransfer: execute,
    }).deps,
    { metabotId: 1, to: EXTERNAL_ADDR, amountSats: 100_000, externalConfirmed: false },
  );

  assert.equal(result.success, true);
  assert.equal(result.channel, 'external');
  assert.equal(confirmAsked, 0, 'disabled gate must not render the dialog');
  assert.equal(calls.length, 1);
});

test('RPC acknowledgement flag satisfies the channel B gate without a dialog', async () => {
  const calls = [];
  const execute = async () => {
    calls.push('called');
    return { success: true, txId: 'tx-ext-3' };
  };
  const { executeWalletMvcTransfer } = loadWalletTransferService({ executeTransfer: execute });

  const result = await executeWalletMvcTransfer(baseDeps({ executeTransfer: execute }).deps, {
    metabotId: 1,
    to: EXTERNAL_ADDR,
    amountSats: 100_000,
    externalConfirmed: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.channel, 'external');
  assert.equal(calls.length, 1);
});

test('insufficient balance: structured have/need error, no chain call, audit refused', async () => {
  const calls = [];
  const execute = async () => {
    calls.push('called');
    return { success: true, txId: 'nope' };
  };
  const { executeWalletMvcTransfer } = loadWalletTransferService({ executeTransfer: execute });
  const { deps, ledger } = baseDeps({ balanceSats: 500, executeTransfer: execute });

  const result = await executeWalletMvcTransfer(deps, {
    metabotId: 1,
    to: MVC_ADDR_2,
    amountSats: 100_000,
  });

  assert.equal(result.success, false);
  assert.equal(result.error_code, 'insufficient_balance');
  assert.equal(result.have_sats, 500);
  // need = amount + estimated fee (200 vB * feeRate 1)
  assert.equal(result.need_sats, 100_200);
  assert.match(result.error, /insufficient balance: have 500 sats/);
  assert.match(result.error, /need 100200 sats/);
  assert.equal(calls.length, 0, 'insufficient balance must fail before signing');
  assert.equal(ledger.records[0].status, 'refused');
  assert.equal(ledger.records[0].error, result.error);
});

test('worker raising "not enough balance" maps to the structured error with audit', async () => {
  const { executeWalletMvcTransfer } = loadWalletTransferService({
    executeTransfer: async () => ({ success: false, error: 'not enough balance' }),
  });
  const { deps, ledger } = baseDeps({
    executeTransfer: async () => ({ success: false, error: 'not enough balance' }),
  });

  const result = await executeWalletMvcTransfer(deps, { metabotId: 1, to: MVC_ADDR_2, amountSats: 100_000 });
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'insufficient_balance');
  assert.equal(result.have_sats, 10_000_000);
  assert.match(result.error, /insufficient balance: have 10000000 sats/);
  assert.equal(ledger.records[0].status, 'failed');

  const thrown = await executeWalletMvcTransfer(
    baseDeps({ executeTransfer: async () => { throw new Error('not enough balance'); } }).deps,
    { metabotId: 1, to: MVC_ADDR_2, amountSats: 100_000 },
  );
  assert.equal(thrown.success, false);
  assert.equal(thrown.error_code, 'insufficient_balance');
});

test('non-balance worker failure maps to transfer_failed with audit', async () => {
  const { executeWalletMvcTransfer } = loadWalletTransferService({
    executeTransfer: async () => ({ success: false, error: 'broadcast timeout' }),
  });
  const { deps, ledger } = baseDeps({
    executeTransfer: async () => ({ success: false, error: 'broadcast timeout' }),
  });
  const result = await executeWalletMvcTransfer(deps, { metabotId: 1, to: MVC_ADDR_2, amountSats: 100_000 });
  assert.equal(result.success, false);
  assert.equal(result.error_code, 'transfer_failed');
  assert.equal(ledger.records[0].status, 'failed');
  assert.equal(ledger.records[0].error, 'broadcast timeout');
});

test('invalid params: missing id/to, dust amount, unknown bot', async () => {
  const { executeWalletMvcTransfer } = loadWalletTransferService();
  const { deps } = baseDeps({});

  const noBot = await executeWalletMvcTransfer(deps, { metabotId: 0, to: MVC_ADDR_2, amountSats: 1000 });
  assert.equal(noBot.error_code, 'invalid_params');

  const noTo = await executeWalletMvcTransfer(deps, { metabotId: 1, to: '', amountSats: 1000 });
  assert.equal(noTo.error_code, 'invalid_params');

  const dust = await executeWalletMvcTransfer(deps, { metabotId: 1, to: MVC_ADDR_2, amountSats: 599 });
  assert.equal(dust.error_code, 'invalid_params');
  assert.match(dust.error, /600/);

  const unknown = await executeWalletMvcTransfer(deps, { metabotId: 9, to: MVC_ADDR_2, amountSats: 1000 });
  assert.equal(unknown.error_code, 'invalid_params');
  assert.match(unknown.error, /MetaBot not found: 9/);
});

test('self-transfer resolves as local channel', async () => {
  const { executeWalletMvcTransfer } = loadWalletTransferService({
    executeTransfer: async () => ({ success: true, txId: 'tx-self' }),
  });
  const { deps } = baseDeps({ executeTransfer: async () => ({ success: true, txId: 'tx-self' }) });
  const result = await executeWalletMvcTransfer(deps, { metabotId: 1, to: MVC_ADDR_1, amountSats: 100_000 });
  assert.equal(result.success, true);
  assert.equal(result.channel, 'local');
  assert.equal(result.to_metabot_id, 1);
});
