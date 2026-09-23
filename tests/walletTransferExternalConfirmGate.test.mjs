/**
 * wallet_transfer external-transfer confirmation gate — regression suite for the
 * "owner approved, still refused" defect (2026-09-21).
 *
 * Root cause (source-verified at the pre-fix revision e4611ca4):
 *   1. src/main/libs/walletAgentTools.ts declared the wallet_transfer schema
 *      without `external_confirmed`, so the model could never send the flag the
 *      refusal text told it to send ("re-send with external_confirmed=true ...").
 *   2. src/main/main.ts:5641 registered `transfer: (params) => ...`, dropping the
 *      session's confirmExternal callback, so the service gate always fell into
 *      the "no dialog + no flag" branch — external transfers were structurally
 *      impossible from the tool surface.
 *
 * This suite drives the REAL compiled tool layer into the REAL compiled service
 * layer, so the three gate branches are exercised end to end:
 *   A. dialog available  -> interactive confirmation runs; the flag can never
 *      short-circuit it (callback precedence).
 *   B. no dialog + external_confirmed=true -> allowed (owner already approved).
 *   C. no dialog + no flag -> refused with external_transfer_confirmation_required,
 *      before anything reaches the chain.
 *
 * main.ts itself cannot be executed here (it boots Electron), so its wiring is
 * locked by a source assertion over the walletTools block. That assertion is
 * written to FAIL on the pre-fix revision — it is this suite's positive control
 * (a negative result without a red control only proves the probe was blind).
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Module, { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

function resolveCompiled(rel) {
  const candidates = [`../dist-electron/${rel}`, `../dist-electron/main/${rel}`];
  for (const candidate of candidates) {
    try {
      return require.resolve(candidate);
    } catch {
      // try the next compile output layout
    }
  }
  return require.resolve(candidates[0]);
}

/** Electron-averse loader: stub `electron`, and transferService when injected. */
function withStubbedLoad(stub, load) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => '/tmp', getAppPath: () => process.cwd() } };
    }
    const replacement = stub(request);
    if (replacement) return replacement;
    return originalLoad(request, parent, isMain);
  };
  try {
    return load();
  } finally {
    Module._load = originalLoad;
  }
}

function loadWalletAgentTools() {
  return withStubbedLoad(
    () => null,
    () => {
      const path = resolveCompiled('libs/walletAgentTools.js');
      delete require.cache[path];
      return require(path);
    },
  );
}

function loadWalletTransferService({ executeTransfer } = {}) {
  return withStubbedLoad(
    (request) =>
      executeTransfer && (request === './transferService' || request.endsWith('/transferService'))
        ? { executeTransfer }
        : null,
    () => {
      const path = resolveCompiled('services/walletTransferService.js');
      delete require.cache[path];
      return require(path);
    },
  );
}

// --- fixtures ---------------------------------------------------------------

const SESSION_METABOT_ID = 15;
const SESSION_MVC_ADDR = '1TwinSessionAddressXyz';
const WORKER_MVC_ADDR = '1WorkerRosterAddressAbc';
// 23 chars, base58-safe (no 0/O/I/l — note "External" would fail, it has an l):
// passes the tool's MVC-address shape check and misses the local roster.
const EXTERNAL_ADDR = '1ExtTargetAddressXYZabc';
const AMOUNT_SPACE = 0.001;
const AMOUNT_SATS = 100_000;
const ESTIMATED_FEE_SATS = 200; // 200 vB * feeRate 1

function createMetabotStore() {
  const metabots = [
    { id: SESSION_METABOT_ID, name: 'Twin', mvc_address: SESSION_MVC_ADDR },
    { id: 2, name: 'Worker', mvc_address: WORKER_MVC_ADDR },
  ];
  return {
    getMetabotById(id) {
      const found = metabots.find((bot) => bot.id === Number(id));
      if (!found) return null;
      return {
        ...found,
        btc_address: `1BtcAddr${found.id}`,
        doge_address: `DogeAddr${found.id}`,
        public_key: 'pk',
        globalmetaid: `idq-fixture-${found.id}`,
      };
    },
    listMetabots() {
      return metabots;
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

/**
 * Control adapter for the wallet_transfer tool. Its `transfer` mirrors the
 * production wiring in src/main/main.ts (walletTools.transfer) — including the
 * part under repair: the session's confirmExternal callback must be forwarded
 * into the service deps instead of being dropped.
 */
function createWalletControl({ executeTransfer, ledger, settings = {}, lastTransferCall }) {
  return {
    getBalances: async () => ({ entries: [], queried_at: '2026-09-21T00:00:00.000Z' }),
    getBalanceForAddress: async (chain, address) => ({
      chain,
      address,
      unit: 'SPACE',
      confirmed_sats: 0,
      unconfirmed_sats: 0,
      total_sats: 0,
      utxo_count: 0,
    }),
    resolveMetabotIdByName: (name) => (name === 'Worker' ? 2 : null),
    getMetabotMvcAddress: (id) => (Number(id) === 2 ? WORKER_MVC_ADDR : null),
    listTransfers: () => ledger.list(),
    transfer: (params, host) => {
      if (lastTransferCall) lastTransferCall.value = { params, host };
      return executeWalletMvcTransferRef.current(
        {
          metabotStore: createMetabotStore(),
          transferStore: ledger,
          settingsReader: { get: (key) => settings[key] },
          getFeeRate: () => 1,
          executeTransferImpl: executeTransfer,
          getBalanceSnapshotImpl: async () => ({
            chain: 'mvc',
            address: SESSION_MVC_ADDR,
            unit: 'SPACE',
            confirmed_sats: 10_000_000,
            unconfirmed_sats: 0,
            total_sats: 10_000_000,
            utxo_count: 1,
          }),
          confirmExternal: host?.confirmExternal,
        },
        params,
      );
    },
  };
}

/** Late-bound real service entrypoint, filled by loadGate() per test. */
const executeWalletMvcTransferRef = { current: null };

function loadGate({ executeTransfer, ledger, settings } = {}) {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  const { executeWalletMvcTransfer } = loadWalletTransferService({ executeTransfer });
  executeWalletMvcTransferRef.current = executeWalletMvcTransfer;

  const tools = [];
  const handlers = {};
  const tool = (name, description, schema, handler) => {
    tools.push(name);
    handlers[name] = { description, schema, handler };
    return { name };
  };
  const lastTransferCall = { value: null };
  const control = createWalletControl({ executeTransfer, ledger, settings, lastTransferCall });
  return { buildWalletAgentTools, tool, handlers, control, lastTransferCall };
}

function buildTransferTool({ deps = {}, executeTransfer, ledger, settings } = {}) {
  const gate = loadGate({ executeTransfer, ledger, settings });
  gate.buildWalletAgentTools({
    tool: gate.tool,
    control: gate.control,
    sessionId: 'session-1',
    resolveMetabotId: () => SESSION_METABOT_ID,
    ...deps,
  });
  return gate;
}

// --- 1. schema contract (defect 1) -----------------------------------------

test('wallet_transfer schema exposes the optional external_confirmed flag', () => {
  const fresh = buildTransferTool({ executeTransfer: async () => ({ success: true, txId: 'x' }) });
  const schema = fresh.handlers.wallet_transfer.schema;

  // Positive control first: a required field must still reject undefined, so a
  // passing optionality probe below cannot be a blind probe.
  assert.equal(schema.to.safeParse(undefined).success, false);
  assert.equal(schema.amount.safeParse(undefined).success, false);

  assert.ok(
    schema.external_confirmed,
    'wallet_transfer must declare external_confirmed (the refusal text tells the model to send it)',
  );
  assert.equal(schema.external_confirmed.safeParse(true).success, true);
  assert.equal(schema.external_confirmed.safeParse(false).success, true);
  assert.equal(schema.external_confirmed.safeParse(undefined).success, true, 'must stay optional');
  assert.equal(schema.external_confirmed.safeParse('yes').success, false, 'must stay boolean');
  assert.equal(schema.external_confirmed.safeParse(true).data, true, 'must not coerce/transform the value');
});

test('wallet_transfer forwards external_confirmed as params.externalConfirmed', async () => {
  const ledger = createTransferLedger();
  const execute = async () => ({ success: true, txId: 'tx-flag' });
  const fresh = buildTransferTool({ executeTransfer: execute, ledger });

  await fresh.handlers.wallet_transfer.handler({
    to: EXTERNAL_ADDR,
    amount: AMOUNT_SPACE,
    external_confirmed: true,
  });
  assert.equal(fresh.lastTransferCall.value.params.externalConfirmed, true);
  assert.equal(fresh.lastTransferCall.value.params.to, EXTERNAL_ADDR);

  await fresh.handlers.wallet_transfer.handler({ to: EXTERNAL_ADDR, amount: AMOUNT_SPACE });
  assert.equal(
    fresh.lastTransferCall.value.params.externalConfirmed,
    undefined,
    'omitting the flag must not fabricate an acknowledgement',
  );
});

// --- 2. the three gate branches, end to end --------------------------------

test('branch A: a dialog is available -> interactive confirmation runs and wins', async () => {
  const ledger = createTransferLedger();
  const calls = [];
  const execute = async (_store, params) => {
    calls.push(params);
    return { success: true, txId: 'tx-dialog' };
  };
  const dialogs = [];
  const fresh = buildTransferTool({
    executeTransfer: execute,
    ledger,
    deps: {
      confirmExternalTransfer: async (info) => {
        dialogs.push(info);
        return true;
      },
    },
  });

  const result = await fresh.handlers.wallet_transfer.handler({ to: EXTERNAL_ADDR, amount: AMOUNT_SPACE });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.equal(dialogs.length, 1, 'the owner dialog must be asked once');
  assert.deepEqual(dialogs[0], {
    metabotId: SESSION_METABOT_ID,
    fromAddress: SESSION_MVC_ADDR,
    toAddress: EXTERNAL_ADDR,
    amountSats: AMOUNT_SATS,
    estimatedFeeSats: ESTIMATED_FEE_SATS,
    memo: null,
  });
  assert.equal(calls.length, 1, 'approved transfer broadcasts exactly once');

  // Precedence: with a dialog wired, external_confirmed=true must NOT bypass it.
  dialogs.length = 0;
  calls.length = 0;
  const bypassAttempt = await buildTransferTool({
    executeTransfer: execute,
    ledger,
    deps: { confirmExternalTransfer: async (info) => { dialogs.push(info); return false; } },
  }).handlers.wallet_transfer.handler({
    to: EXTERNAL_ADDR,
    amount: AMOUNT_SPACE,
    external_confirmed: true,
  });
  assert.equal(bypassAttempt.isError, true);
  assert.match(bypassAttempt.content[0].text, /external_transfer_declined/);
  assert.equal(dialogs.length, 1, 'the dialog must still run when the flag is set');
  assert.equal(calls.length, 0, 'a declined transfer must not reach the chain');
});

test('branch B: no dialog + external_confirmed=true -> allowed (owner already approved)', async () => {
  const ledger = createTransferLedger();
  const calls = [];
  const fresh = buildTransferTool({
    executeTransfer: async (_store, params) => {
      calls.push(params);
      return { success: true, txId: 'tx-confirmed' };
    },
    ledger,
  });

  const result = await fresh.handlers.wallet_transfer.handler({
    to: EXTERNAL_ADDR,
    amount: AMOUNT_SPACE,
    external_confirmed: true,
  });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.match(result.content[0].text, /txid: tx-confirmed/);
  assert.match(result.content[0].text, /channel: external/);
  assert.equal(calls.length, 1, 'the acknowledged transfer must broadcast');
  assert.equal(fresh.lastTransferCall.value.host, undefined, 'no dialog callback exists on this surface');
});

test('branch C: no dialog + no flag -> refused pre-chain with the actionable error code', async () => {
  const ledger = createTransferLedger();
  const calls = [];
  const fresh = buildTransferTool({
    executeTransfer: async () => {
      calls.push('called');
      return { success: true, txId: 'never' };
    },
    ledger,
  });

  const result = await fresh.handlers.wallet_transfer.handler({ to: EXTERNAL_ADDR, amount: AMOUNT_SPACE });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /external_transfer_confirmation_required/);
  assert.equal(calls.length, 0, 'refused transfers must never reach the chain');
  assert.equal(ledger.records.length, 1);
  assert.equal(ledger.records[0].status, 'refused');
  assert.equal(ledger.records[0].channel, 'external');

  // The refusal must now be satisfiable: the flag it asks for is in the schema.
  const schema = fresh.handlers.wallet_transfer.schema;
  assert.equal(schema.external_confirmed.safeParse(true).success, true);
});

// --- 3. local channel unaffected -------------------------------------------

test('channel A (local roster) is untouched: no dialog, no acknowledgement needed', async () => {
  const ledger = createTransferLedger();
  const calls = [];
  let dialogs = 0;
  const fresh = buildTransferTool({
    executeTransfer: async (_store, params) => {
      calls.push(params);
      return { success: true, txId: 'tx-local' };
    },
    ledger,
    deps: {
      confirmExternalTransfer: async () => {
        dialogs++;
        return false;
      },
    },
  });

  const result = await fresh.handlers.wallet_transfer.handler({ to: '2', amount: AMOUNT_SPACE });
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.match(result.content[0].text, /channel: local/);
  assert.equal(dialogs, 0, 'local-roster transfers must not ask the owner');
  assert.equal(calls.length, 1);
});

// --- 4. main.ts wiring (static lock; red on the pre-fix revision) ----------

function extractWalletToolsBlock(source) {
  const start = source.indexOf('walletTools: {');
  assert.notEqual(start, -1, 'src/main/main.ts must still register a walletTools control block');
  const end = source.indexOf('// send_private_chat tool backend', start);
  assert.notEqual(end, -1, 'walletTools block end marker not found — update this assertion');
  return source.slice(start, end);
}

test('main.ts walletTools.transfer forwards the session confirmExternal callback', () => {
  const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const block = extractWalletToolsBlock(mainSource);

  // Probe control: the same regex must match a shape we know is present, so a
  // "0 matches" result below cannot be a broken regular expression.
  assert.match(block, /listTransfers:\s*\(limit,\s*metabotId\)/, 'probe control failed');

  assert.equal(
    /transfer:\s*\(params\)\s*=>/.test(block),
    false,
    'walletTools.transfer must not drop the host callback argument (pre-fix defect)',
  );
  assert.match(
    block,
    /transfer:\s*\(params,\s*host\)\s*=>[\s\S]{0,800}?confirmExternal:\s*host\?\.confirmExternal/,
    'walletTools.transfer must forward host.confirmExternal into executeWalletMvcTransfer deps',
  );
});

test('main.ts keeps the external-transfer confirmation gate wired, not bypassed', () => {
  const mainSource = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  const block = extractWalletToolsBlock(mainSource);
  assert.equal(
    /wallet_transfer_external_confirm_enabled|skipExternalConfirm/.test(block),
    false,
    'the tool surface must not switch the gate off by construction',
  );
  assert.match(block, /withChainWriteBudget\(\s*'wallet_transfer'/, 'the chain-write budget wrapper must stay');
});
