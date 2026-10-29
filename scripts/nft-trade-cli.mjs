#!/usr/bin/env node
/**
 * nft-trade-cli.mjs — standalone MVC MetaContract NFT CLI (sell-order
 * queries, direct transfers, explicit-four-tuple buys).
 *
 * Five modes:
 *   mode=sell-orders  list one address's on-chain NFT sell orders
 *                     (reuses the compiled mvcNftService wire-shape parser).
 *   mode=transfer     transfer ONE held NFT (genesis/codehash/token_index)
 *                     to receiver_address. Builds the single transfer tx by
 *                     spawning the compiled buildMvcNftTransferRawTxWorker.js
 *                     (env mnemonic + stdin JSON + last-stdout-line JSON),
 *                     then broadcasts it via wallet-api /v3/tx/broadcast with
 *                     the same rebuild-excluding-spent-outpoints retry policy
 *                     as the host's executeMvcNftTransfer. Pass dry=1 to
 *                     build only (no broadcast).
 *   mode=sell         list ONE held NFT at price_sats (>= 22000, the
 *                     NftManager floor); the seller is the session wallet.
 *                     Two chained txs via the compiled
 *                     buildMvcNftTradeRawTxWorker.js (stage 1 funds the sell
 *                     contract, stage 2 moves the NFT into the listing — the
 *                     listing outpoint buyers quote is stage-2 txid vout 0),
 *                     broadcast stage 1 then stage 2. Pass dry=1 to build
 *                     only (no broadcast).
 *   mode=cancel-sell  take down ONE of your own listings with the EXPLICIT
 *                     four-tuple (sell_txid + sell_output_index +
 *                     seller_address + sell_price_sats) plus
 *                     genesis/codehash/token_index. Two chained txs (unlock
 *                     check, then NFT back to the seller) via the same trade
 *                     worker, broadcast stage 1 then stage 2. dry=1 builds
 *                     only.
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
 *   node scripts/nft-trade-cli.mjs mode=transfer \
 *     genesis=<40hex> codehash=<40hex> token_index=<digits> \
 *     receiver_address=<mvc-addr> [fee_rate=<n>] [dry=1]
 *   node scripts/nft-trade-cli.mjs mode=sell \
 *     genesis=<40hex> codehash=<40hex> token_index=<digits> \
 *     price_sats=<n> [fee_rate=<n>] [dry=1]
 *   node scripts/nft-trade-cli.mjs mode=cancel-sell \
 *     genesis=<40hex> codehash=<40hex> token_index=<digits> \
 *     sell_txid=<64hex> sell_output_index=<n> seller_address=<addr> \
 *     sell_price_sats=<n> [fee_rate=<n>] [dry=1]
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
// Same retry policy as executeMvcNftTrade/executeMvcNftTransfer in
// src/main/services/mvcNftService.ts (3 attempts, 750ms delay).
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 750;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.resolve(SCRIPT_DIR, '../dist-electron/main/libs/buildMvcNftTradeRawTxWorker.js');
const TRANSFER_WORKER_PATH = path.resolve(SCRIPT_DIR, '../dist-electron/main/libs/buildMvcNftTransferRawTxWorker.js');
const NFT_SERVICE_PATH = path.resolve(SCRIPT_DIR, '../dist-electron/main/services/mvcNftService.js');

const KNOWN_KEYS = new Set([
  'mode',
  'address',
  'genesis',
  'codehash',
  'token_index',
  'receiver_address',
  'sell_txid',
  'sell_output_index',
  'seller_address',
  'sell_price_sats',
  'price_sats',
  'fee_rate',
  'dry',
]);

function usageAndExit(code = 1) {
  const lines = [
    'Usage:',
    '  node scripts/nft-trade-cli.mjs mode=sell-orders address=<mvc-address>',
    '  node scripts/nft-trade-cli.mjs mode=transfer \\',
    '      genesis=<40hex> codehash=<40hex> token_index=<digits> receiver_address=<mvc-addr> \\',
    '      [fee_rate=<n>] [dry=1]',
    '  node scripts/nft-trade-cli.mjs mode=sell \\',
    '      genesis=<40hex> codehash=<40hex> token_index=<digits> price_sats=<n> \\',
    '      [fee_rate=<n>] [dry=1]   (price_sats >= 22000; seller = your derived wallet)',
    '  node scripts/nft-trade-cli.mjs mode=cancel-sell \\',
    '      genesis=<40hex> codehash=<40hex> token_index=<digits> \\',
    '      sell_txid=<64hex> sell_output_index=<n> seller_address=<addr> sell_price_sats=<n> \\',
    '      [fee_rate=<n>] [dry=1]',
    '  node scripts/nft-trade-cli.mjs mode=buy \\',
    '      genesis=<40hex> codehash=<40hex> token_index=<digits> \\',
    '      sell_txid=<64hex> sell_output_index=<n> seller_address=<addr> sell_price_sats=<n> \\',
    '      [fee_rate=<n>] [dry=1]',
    '',
    'Env: IDBOTS_METABOT_MNEMONIC (required for transfer/sell/cancel-sell/buy; never passed as an argument)',
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
 * Spawn one compiled wallet worker exactly the way the Electron host does
 * (env mnemonic + stdin JSON payload), except under the plain node binary
 * (the compiled workers' require graphs have no electron dependency; the
 * subprocess isolation that matters is the separate process).
 * Returns the worker's last stdout line parsed as JSON (success objects only).
 */
async function runWalletWorker(workerPath, payload) {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error('IDBOTS_METABOT_MNEMONIC is required in the environment for signing modes (transfer/sell/cancel-sell/buy); never pass it as an argument');
  }
  if (!existsSync(workerPath)) {
    throw new Error(`Worker not found (run the electron build first): ${workerPath}`);
  }

  const env = { ...process.env };
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  delete env.NODE_PATH;
  env.IDBOTS_METABOT_MNEMONIC = mnemonic;
  if (process.env.IDBOTS_METABOT_PATH?.trim()) {
    env.IDBOTS_METABOT_PATH = process.env.IDBOTS_METABOT_PATH.trim();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
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
      resolve(parsed);
    });
    child.stdin.write(JSON.stringify(payload), () => child.stdin.end());
  });
}

/** Trade worker (sell/cancelSell/buy): must return the two chained tx hex blobs. */
async function runTradeWorker(payload) {
  const parsed = await runWalletWorker(WORKER_PATH, payload);
  if (!parsed.fundingTxHex || typeof parsed.fundingTxHex !== 'string' || !parsed.txHex || typeof parsed.txHex !== 'string') {
    throw new Error('Worker did not return both tx hex blobs');
  }
  return parsed;
}

/** Transfer worker: one tx, returns its hex + the worker-computed txid. */
async function runTransferWorker(payload) {
  const parsed = await runWalletWorker(TRANSFER_WORKER_PATH, payload);
  if (!parsed.txHex || typeof parsed.txHex !== 'string' || !parsed.txid || typeof parsed.txid !== 'string') {
    throw new Error('Worker did not return the transfer tx hex + txid');
  }
  return parsed;
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

// Two-stage broadcast driver (shared by sell / cancel-sell / buy): stage-1
// retryable failure → rebuild excluding the spent wallet utxos; stage-2
// retryable failure → re-send the SAME hex (its inputs are the
// already-broadcast stage-1 outputs); stage-2 hard failure → surface the
// funding txid + preserved stage-2 hex for manual recovery.
async function broadcastTwoStageTrade(mode, buildTrade) {
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
        return built;
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
  throw new Error(`MVC NFT ${mode} failed after retries`);
}

async function modeSell(args) {
  const genesis = String(args.genesis || '').trim();
  const codehash = String(args.codehash || '').trim();
  const tokenIndex = String(args.token_index || '').trim();
  const price = Number(args.price_sats);
  const feeRate = args.fee_rate != null ? Number(args.fee_rate) : 1;

  // MVC MetaContract genesis/codehash are 20-byte script hashes → 40 hex.
  if (!isHex(genesis, 40) || !isHex(codehash, 40) || !/^\d+$/.test(tokenIndex)) {
    console.error('sell requires genesis (40 hex), codehash (40 hex) and token_index (digits)');
    usageAndExit();
  }
  // Mirrors the NftManager.sell guard inside the trade worker (and the host
  // wallet_nft_sell tool): listings below 22000 sats are rejected outright.
  if (!Number.isInteger(price) || price < 22000) {
    console.error('sell requires price_sats (integer >= 22000; the NftManager sell floor. 0.001 SPACE = 100000 sats)');
    usageAndExit();
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    console.error('fee_rate must be a positive number');
    usageAndExit();
  }

  const buildSell = (excludeOutpoints) => runTradeWorker({
    action: 'sell',
    genesis,
    codehash,
    tokenIndex,
    price,
    feeRate,
    excludeOutpoints,
  });

  // Dry mode: build both txs, report, never touch the broadcast endpoint —
  // a dry run creates NO listing. The worker signs with the session wallet;
  // NftManager.sell does not prove the caller holds the token (pitfall #4
  // discipline: verify holdings via utxo-list before a live run).
  if (args.dry) {
    const built = await buildSell([]);
    console.log('DRY sell built successfully (nothing was broadcast; no listing exists yet):');
    console.log(`- listing txid: ${built.txid} (${built.txHex.length / 2} bytes; quote as sell_txid=${built.txid} sell_output_index=0 after the live run)`);
    console.log(`- funding txid: ${built.fundingTxid} (${built.fundingTxHex.length / 2} bytes)`);
    console.log(JSON.stringify({ mode: 'sell', dry: true, listingTxid: built.txid, fundingTxid: built.fundingTxid, priceSats: price }));
    return;
  }

  // Stage 1 funds the sell contract; stage 2 moves the NFT into the listing
  // and carries the sell-contract output at vout 0 — that outpoint
  // (stage-2 txid:0) is what buyers quote as sell_txid.
  const built = await broadcastTwoStageTrade('sell', buildSell);
  console.log('NFT sell listed on-chain.');
  console.log(`- listing txid: ${built.txid} (quote as sell_txid=${built.txid} sell_output_index=0)`);
  console.log(`- funding txid: ${built.fundingTxid}`);
  console.log(JSON.stringify({ mode: 'sell', dry: false, listingTxid: built.txid, fundingTxid: built.fundingTxid, listingOutpoint: `${built.txid}:0`, priceSats: price }));
}

async function modeCancelSell(args) {
  const genesis = String(args.genesis || '').trim();
  const codehash = String(args.codehash || '').trim();
  const tokenIndex = String(args.token_index || '').trim();
  const sellTxid = String(args.sell_txid || '').trim();
  const outputIndex = Number(args.sell_output_index);
  const sellerAddress = String(args.seller_address || '').trim();
  const price = Number(args.sell_price_sats);
  const feeRate = args.fee_rate != null ? Number(args.fee_rate) : 1;

  if (!isHex(genesis, 40) || !isHex(codehash, 40) || !/^\d+$/.test(tokenIndex)) {
    console.error('cancel-sell requires genesis (40 hex), codehash (40 hex) and token_index (digits)');
    usageAndExit();
  }
  // Explicit four-tuple, same discipline as buy: the bare-outpoint path is
  // rejected by the API ("please include address data"). Only the original
  // seller can take an order down — seller_address is your own address.
  if (!isHex(sellTxid, 64) || !Number.isInteger(outputIndex) || outputIndex < 0 || !sellerAddress || !Number.isInteger(price) || price <= 0) {
    console.error('cancel-sell requires the explicit four-tuple: sell_txid (64 hex), sell_output_index (int >= 0), seller_address, sell_price_sats (int > 0)');
    usageAndExit();
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    console.error('fee_rate must be a positive number');
    usageAndExit();
  }

  const buildCancel = (excludeOutpoints) => runTradeWorker({
    action: 'cancelSell',
    genesis,
    codehash,
    tokenIndex,
    sellUtxo: { txId: sellTxid, outputIndex, sellerAddress, price },
    feeRate,
    excludeOutpoints,
  });

  // Dry mode: build both txs, report, never touch the broadcast endpoint —
  // the order stays open until the real run.
  if (args.dry) {
    const built = await buildCancel([]);
    console.log('DRY cancel-sell built successfully (nothing was broadcast; the order stays open):');
    console.log(`- cancel txid: ${built.txid} (${built.txHex.length / 2} bytes)`);
    console.log(`- check txid:  ${built.fundingTxid} (${built.fundingTxHex.length / 2} bytes)`);
    console.log(`- order: #${tokenIndex} ${sellTxid}:${outputIndex} ask ${price} sats from ${sellerAddress}`);
    console.log(JSON.stringify({ mode: 'cancel-sell', dry: true, cancelTxid: built.txid, checkTxid: built.fundingTxid }));
    return;
  }

  // Stage 1 is the unlock check; stage 2 cancels the listing (NFT back to
  // the seller).
  const built = await broadcastTwoStageTrade('cancel-sell', buildCancel);
  console.log('NFT sell cancelled on-chain.');
  console.log(`- cancel txid: ${built.txid}`);
  console.log(`- check txid:  ${built.fundingTxid}`);
  console.log(`- order: #${tokenIndex} ${sellTxid}:${outputIndex} ask ${price} sats from ${sellerAddress}`);
  console.log(JSON.stringify({ mode: 'cancel-sell', dry: false, cancelTxid: built.txid, checkTxid: built.fundingTxid }));
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

  // Two-stage broadcast via the shared driver (see broadcastTwoStageTrade).
  const built = await broadcastTwoStageTrade('buy', buildTrade);
  console.log('NFT purchase broadcast on-chain.');
  console.log(`- purchase txid: ${built.txid}`);
  console.log(`- check txid:    ${built.fundingTxid}`);
  console.log(`- order: #${tokenIndex} ${sellTxid}:${outputIndex} ask ${price} sats from ${sellerAddress}`);
  console.log(JSON.stringify({ mode: 'buy', dry: false, purchaseTxid: built.txid, fundingTxid: built.fundingTxid }));
}

async function modeTransfer(args) {
  const genesis = String(args.genesis || '').trim();
  const codehash = String(args.codehash || '').trim();
  const tokenIndex = String(args.token_index || '').trim();
  const receiverAddress = String(args.receiver_address || '').trim();
  const feeRate = args.fee_rate != null ? Number(args.fee_rate) : 1;

  // MVC MetaContract genesis/codehash are 20-byte script hashes → 40 hex
  // (verified against the live MetaBot Avatar series and wallet-api rows).
  if (!isHex(genesis, 40) || !isHex(codehash, 40) || !/^\d+$/.test(tokenIndex)) {
    console.error('transfer requires genesis (40 hex), codehash (40 hex) and token_index (digits)');
    usageAndExit();
  }
  // Mainnet MVC pay-to-pubkey-hash addresses (base58, no 0/O/I/l).
  if (!/^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/.test(receiverAddress)) {
    console.error('transfer requires receiver_address (mainnet MVC base58 address)');
    usageAndExit();
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    console.error('fee_rate must be a positive number');
    usageAndExit();
  }

  const buildTransfer = (excludeOutpoints) => runTransferWorker({
    genesis,
    codehash,
    tokenIndex,
    toAddress: receiverAddress,
    feeRate,
    excludeOutpoints,
  });

  // Dry mode: build the tx, report, never touch the broadcast endpoint.
  if (args.dry) {
    const built = await buildTransfer([]);
    console.log('DRY transfer built successfully (nothing was broadcast):');
    console.log(`- transfer txid: ${built.txid} (${built.txHex.length / 2} bytes)`);
    console.log(`- move: #${tokenIndex} → ${receiverAddress}`);
    console.log(JSON.stringify({ mode: 'transfer', dry: true, txid: built.txid }));
    return;
  }

  // Single-stage broadcast with the same retry policy as executeMvcNftTransfer:
  // a retryable (stale-input) failure rebuilds the tx excluding the wallet
  // utxos the previous build tried to spend.
  const excludedOutpoints = new Set();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const built = await buildTransfer(Array.from(excludedOutpoints));
    try {
      await broadcastTx(built.txHex, built.txid);
      console.log('NFT transfer broadcast on-chain.');
      console.log(`- transfer txid: ${built.txid}`);
      console.log(`- move: #${tokenIndex} → ${receiverAddress}`);
      console.log(JSON.stringify({ mode: 'transfer', dry: false, txid: built.txid }));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt < MAX_ATTEMPTS && isRetryableBroadcastError(message)) {
        for (const outpoint of built.spentOutpoints || []) {
          excludedOutpoints.add(String(outpoint).toLowerCase());
        }
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }
  throw new Error('MVC NFT transfer failed after retries');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || '');
  if (mode === 'sell-orders') {
    await modeSellOrders(String(args.address || '').trim());
  } else if (mode === 'transfer') {
    await modeTransfer(args);
  } else if (mode === 'sell') {
    await modeSell(args);
  } else if (mode === 'cancel-sell') {
    await modeCancelSell(args);
  } else if (mode === 'buy') {
    await modeBuy(args);
  } else {
    console.error('mode must be sell-orders, transfer, sell, cancel-sell or buy');
    usageAndExit();
  }
}

main().catch((error) => {
  console.error(`nft-trade-cli failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
