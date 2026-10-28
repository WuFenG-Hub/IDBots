#!/usr/bin/env node
/**
 * nft-trade-cli.mjs — standalone MVC MetaContract NFT buyer CLI.
 *
 * Two modes:
 *   mode=sell-orders  list one address's on-chain NFT sell orders
 *                     (reuses the compiled mvcNftService wire-shape parser).
 *   mode=buy          take one sell order with the EXPLICIT four-tuple
 *                     (sell_txid + sell_output_index + seller_address +
 *                     sell_price_sats) plus genesis/codehash/token_index.
 *                     Builds the two chained txs by spawning the compiled
 *                     buildMvcNftTradeRawTxWorker.js (env mnemonic + stdin
 *                     JSON + last-stdout-line JSON), then broadcasts stage 1
 *                     and stage 2 via wallet-api /v3/tx/broadcast. Pass
 *                     dry=1 to build only (no broadcast).
 *
 * Key discipline: the wallet mnemonic is read ONLY from the environment
 * variable IDBOTS_METABOT_MNEMONIC (passed to the worker through its env).
 * It is never accepted as an argument and never written anywhere.
 *
 * Usage:
 *   node scripts/nft-trade-cli.mjs mode=sell-orders address=<mvc-address>
 *   node scripts/nft-trade-cli.mjs mode=buy \
 *     genesis=<40hex> codehash=<40hex> token_index=<digits> \
 *     sell_txid=<64hex> sell_output_index=<n> seller_address=<addr> \
 *     sell_price_sats=<n> [fee_rate=<n>] [dry=1]
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
// Same retry policy as executeMvcNftTrade in src/main/services/mvcNftService.ts.
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 750;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(SCRIPT_DIR, '../dist-electron/main/libs/buildMvcNftTradeRawTxWorker.js');
const NFT_SERVICE_PATH = path.resolve(SCRIPT_DIR, '../dist-electron/main/services/mvcNftService.js');

const KNOWN_KEYS = new Set([
  'mode',
  'address',
  'genesis',
  'codehash',
  'token_index',
  'sell_txid',
  'sell_output_index',
  'seller_address',
  'sell_price_sats',
  'fee_rate',
  'dry',
]);

function usageAndExit(code = 1) {
  const lines = [
    'Usage:',
    '  node scripts/nft-trade-cli.mjs mode=sell-orders address=<mvc-address>',
    '  node scripts/nft-trade-cli.mjs mode=buy \\',
    '      genesis=<40hex> codehash=<40hex> token_index=<digits> \\',
    '      sell_txid=<64hex> sell_output_index=<n> seller_address=<addr> sell_price_sats=<n> \\',
    '      [fee_rate=<n>] [dry=1]',
    '',
    'Env: IDBOTS_METABOT_MNEMONIC (required for buy; never passed as an argument)',
    '     IDBOTS_METABOT_PATH (optional; worker default m/44\'/10001\'/0\'/0/0)',
  ];
  console.error(lines.join('\n'));
  process.exit(code);
}

function parseArgs(argv) {
  const args = { dry: false };
  for (const raw of argv) {
    const token = raw.startsWith('--') ? raw.slice(2) : raw;
    const eq = token.indexOf('=');
    if (eq >= 0) {
      const key = token.slice(0, eq);
      if (!KNOWN_KEYS.has(key)) {
        console.error(`Unknown argument: ${key} (allowed: ${Array.from(KNOWN_KEYS).join(', ')})`);
        usageAndExit();
      }
      args[key] = token.slice(eq + 1);
    } else if (KNOWN_KEYS.has(token)) {
      if (token === 'dry') args.dry = true;
      else { console.error(`Argument ${token} needs a value: ${token}=<value>`); usageAndExit(); }
    } else {
      console.error(`Unknown argument: ${raw}`);
      usageAndExit();
    }
  }
  if (String(args.dry) === '1' || String(args.dry) === 'true') args.dry = true;
  return args;
}

function isHex(value, length) {
  return typeof value === 'string' && new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value);
}

function isRetryableBroadcastError(message) {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('missing inputs')
    || normalized.includes('missingorspent')
    || normalized.includes('inputs missing/spent')
    || normalized.includes('inputs missing or spent')
    || normalized.includes('txn-mempool-conflict')
  );
}

function isTxnAlreadyKnown(message) {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('txn-already-known') || normalized.includes('already known');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Broadcast one raw tx; returns the txid (code 0 → data, already-known → the id the worker computed). */
async function broadcastTx(rawTx, expectedTxid) {
  const response = await fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: NET, rawTx }),
  });
  const json = await response.json();
  if (json?.code === 0) return json.data ?? expectedTxid;
  if (isTxnAlreadyKnown(json?.message || '')) return expectedTxid;
  throw new Error(json?.message || 'Broadcast failed');
}

/**
 * Spawn the compiled trade worker exactly the way the Electron host does
 * (env mnemonic + stdin JSON payload), except under the plain node binary
 * (the compiled worker's require graph has no electron dependency; the
 * subprocess isolation that matters is the separate process).
 * Returns the worker's last stdout line parsed as JSON.
 */
function runTradeWorker(payload) {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error('IDBOTS_METABOT_MNEMONIC is required in the environment for buy (never pass it as an argument)');
  }
  if (!existsSync(WORKER_PATH)) {
    throw new Error(`Worker not found (run the electron build first): ${WORKER_PATH}`);
  }

  const env = { ...process.env };
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_PATH;
  env.IDBOTS_METABOT_MNEMONIC = mnemonic;
  if (process.env.IDBOTS_METABOT_PATH?.trim()) {
    env.IDBOTS_METABOT_PATH = process.env.IDBOTS_METABOT_PATH.trim();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER_PATH], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
    child.once('close', () => {
      const output = stdout.trim() || stderr.trim();
      if (!output) {
        reject(new Error(`Worker returned empty output (stderr: ${stderr.trim() || 'none'})`));
        return;
      }
      const lines = output.split('\n').map((line) => line.trim()).filter(Boolean);
      let parsed;
      try {
        parsed = JSON.parse(lines[lines.length - 1]);
      } catch {
        reject(new Error(output));
        return;
      }
      if (!parsed.success) {
        reject(new Error(parsed.error || 'Worker failed'));
        return;
      }
      if (!parsed.fundingTxHex || typeof parsed.fundingTxHex !== 'string' || !parsed.txHex || typeof parsed.txHex !== 'string') {
        reject(new Error('Worker did not return both tx hex blobs'));
        return;
      }
      resolve(parsed);
    });
    child.stdin.write(JSON.stringify(payload), () => child.stdin.end());
  });
}

async function modeSellOrders(address) {
  if (!address) {
    console.error('mode=sell-orders requires address=<mvc-address>');
    usageAndExit();
  }
  const mvcNftService = require(NFT_SERVICE_PATH);
  const result = await mvcNftService.getMvcNftSellOrders(address);
  console.log(`address: ${result.address}`);
  console.log(`open sell orders: ${result.count}`);
  for (const order of result.orders) {
    const facts = [
      `#${order.tokenIndex ?? '?'}`,
      order.name || 'unnamed',
      order.seriesName ? `(${order.seriesName})` : '',
      `outpoint ${order.txId}:${order.outputIndex}`,
      order.priceSats ? `ask ${order.priceSats} sats` : 'ask on-chain (not exposed by this endpoint)',
    ].filter(Boolean);
    console.log(`- ${facts.join(' · ')}`);
    console.log(`    genesis=${order.genesis ?? ''} codehash=${order.codeHash ?? ''}${order.height ? ` height=${order.height}` : ' (unconfirmed)'}`);
  }
  console.log(JSON.stringify({ mode: 'sell-orders', address: result.address, count: result.count }));
}

async function modeBuy(args) {
  const genesis = String(args.genesis || '').trim();
  const codehash = String(args.codehash || '').trim();
  const tokenIndex = String(args.token_index || '').trim();
  const sellTxid = String(args.sell_txid || '').trim();
  const outputIndex = Number(args.sell_output_index);
  const sellerAddress = String(args.seller_address || '').trim();
  const price = Number(args.sell_price_sats);
  const feeRate = args.fee_rate != null ? Number(args.fee_rate) : 1;

  // MVC MetaContract genesis/codehash are 20-byte script hashes → 40 hex
  // (the live MetaBot Avatar series genesis is 40 hex; verified against the
  // S2 live-fire fixture and the wallet-api rows).
  if (!isHex(genesis, 40) || !isHex(codehash, 40) || !/^\d+$/.test(tokenIndex)) {
    console.error('buy requires genesis (40 hex), codehash (40 hex) and token_index (digits)');
    usageAndExit();
  }
  // The four-tuple is mandatory here: the bare-outpoint path is rejected by
  // the API ("please include address data"), so the CLI takes no shortcuts.
  if (!isHex(sellTxid, 64) || !Number.isInteger(outputIndex) || outputIndex < 0 || !sellerAddress || !Number.isInteger(price) || price <= 0) {
    console.error('buy requires the explicit four-tuple: sell_txid (64 hex), sell_output_index (int >= 0), seller_address, sell_price_sats (int > 0)');
    usageAndExit();
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    console.error('fee_rate must be a positive number');
    usageAndExit();
  }

  const buildTrade = (excludeOutpoints) => runTradeWorker({
    action: 'buy',
    genesis,
    codehash,
    tokenIndex,
    sellUtxo: { txId: sellTxid, outputIndex, sellerAddress, price },
    feeRate,
    excludeOutpoints,
  });

  // Dry mode: build both txs, report, never touch the broadcast endpoint.
  if (args.dry) {
    const built = await buildTrade([]);
    console.log('DRY buy built successfully (nothing was broadcast):');
    console.log(`- purchase txid: ${built.txid} (${built.txHex.length / 2} bytes)`);
    console.log(`- check txid:    ${built.fundingTxid} (${built.fundingTxHex.length / 2} bytes)`);
    console.log(`- order: #${tokenIndex} ${sellTxid}:${outputIndex} ask ${price} sats from ${sellerAddress}`);
    console.log(JSON.stringify({ mode: 'buy', dry: true, purchaseTxid: built.txid, fundingTxid: built.fundingTxid }));
    return;
  }

  // Two-stage broadcast with the same retry policy as executeMvcNftTrade:
  // stage-1 retryable failure → rebuild excluding the spent wallet utxos;
  // stage-2 retryable failure → re-send the SAME hex (its inputs are the
  // already-broadcast stage-1 outputs); stage-2 hard failure → surface the
  // funding txid + preserved stage-2 hex for manual recovery.
  const excludedOutpoints = new Set();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const built = await buildTrade(Array.from(excludedOutpoints));
    try {
      await broadcastTx(built.fundingTxHex, built.fundingTxid);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_ATTEMPTS && isRetryableBroadcastError(message)) {
        for (const outpoint of built.fundingSpentOutpoints || []) {
          excludedOutpoints.add(String(outpoint).toLowerCase());
        }
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }

    for (let stage2Attempt = 1; stage2Attempt <= MAX_ATTEMPTS; stage2Attempt += 1) {
      try {
        await broadcastTx(built.txHex, built.txid);
        console.log('NFT purchase broadcast on-chain.');
        console.log(`- purchase txid: ${built.txid}`);
        console.log(`- check txid:    ${built.fundingTxid}`);
        console.log(`- order: #${tokenIndex} ${sellTxid}:${outputIndex} ask ${price} sats from ${sellerAddress}`);
        console.log(JSON.stringify({ mode: 'buy', dry: false, purchaseTxid: built.txid, fundingTxid: built.fundingTxid }));
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (stage2Attempt < MAX_ATTEMPTS && isRetryableBroadcastError(message)) {
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        throw new Error(
          `${message} [stage-1 tx ${built.fundingTxid} is already broadcast; stage-2 raw tx preserved for manual recovery: ${built.txHex}]`,
        );
      }
    }
  }
  throw new Error('MVC NFT buy failed after retries');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || '');
  if (mode === 'sell-orders') {
    await modeSellOrders(String(args.address || '').trim());
  } else if (mode === 'buy') {
    await modeBuy(args);
  } else {
    console.error('mode must be sell-orders or buy');
    usageAndExit();
  }
}

main().catch((error) => {
  console.error(`nft-trade-cli failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
