#!/usr/bin/env node
/**
 * nft-trade-cli.mjs — STANDALONE MVC MetaContract NFT CLI for external bots.
 *
 * Five modes (same surface as the IDBots host tooling, verified live on MVC
 * mainnet during S1–S3, 2026-10-28/29; sell/cancel-sell added in v1.1.0):
 *   mode=sell-orders  list one address's on-chain NFT sell orders
 *                     (pure wallet-api read; zero npm dependencies).
 *   mode=transfer     transfer ONE held NFT (genesis/codehash/token_index) to
 *                     receiver_address. Requires `npm install` first
 *                     (meta-contract + @metalet/utxo-wallet-service). Builds
 *                     the single transfer tx locally (NftManager.transfer,
 *                     noBroadcast), then broadcasts via wallet-api
 *                     /v3/tx/broadcast with the same rebuild-excluding-spent
 *                     retry policy as the host. Pass dry=1 to build only.
 *   mode=sell         list ONE held NFT at price_sats (>= 22000, the
 *                     NftManager floor). The seller is the wallet derived
 *                     from the mnemonic. Two chained txs (contract funding,
 *                     then NFT into the listing), built locally via
 *                     NftManager.sell then broadcast stage 1 → stage 2 (the
 *                     same two-stage driver as buy). After the live run the
 *                     listing outpoint buyers quote is sell_txid=<txid of
 *                     stage 2> sell_output_index=0. dry=1 builds only.
 *   mode=cancel-sell  take down ONE of your own open listings with the
 *                     EXPLICIT four-tuple (sell_txid + sell_output_index +
 *                     seller_address + sell_price_sats) plus
 *                     genesis/codehash/token_index. Two chained txs
 *                     (unlock-check, then NFT back to the seller), built
 *                     locally via NftManager.cancelSell then broadcast
 *                     stage 1 → stage 2. dry=1 builds only.
 *   mode=buy          take one sell order with the EXPLICIT four-tuple
 *                     (sell_txid + sell_output_index + seller_address +
 *                     sell_price_sats) plus genesis/codehash/token_index.
 *                     Two chained txs (unlock-check, then purchase), built
 *                     locally then broadcast stage 1 → stage 2. dry=1 builds
 *                     only. Funding set is capped at 3 UTXOs (SDK limit;
 *                     applies to sell/cancel-sell/buy alike).
 *
 * Key discipline: the wallet mnemonic is read ONLY from the environment
 * variable IDBOTS_METABOT_MNEMONIC. It is never accepted as an argument and
 * never written anywhere. Derivation path comes from IDBOTS_METABOT_PATH
 * (default m/44'/10001'/0'/0/0, last index segment = address index).
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
 *
 * Full protocol (announcement formats, three chat-trade scenarios, escrow
 * rules, pitfall list): docs/nft-trade-protocol.md in this skill package.
 */

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
// Same retry policy as the IDBots host executeMvcNftTransfer/Trade
// (3 attempts, 750ms delay).
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 750;
// sell/cancelSell/buy all reject funding sets larger than 3 UTXOs (SDK limit).
const MAX_TRADE_FUNDING_UTXOS = 3;
// Hard page cap for wallet-api pagination loops (the NFT utxo-list endpoint
// can echo a truthy "0" cursor — see mvcNftService.ts; the cap is belt and
// braces so an unexpected wire shape can never loop forever).
const MAX_PAGES = 50;

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
    '     IDBOTS_METABOT_PATH (optional; default m/44\'/10001\'/0\'/0/0)',
    '',
    'Signing modes need the npm deps installed next to this skill:',
    '  npm install  (meta-contract@0.4.16 + @metalet/utxo-wallet-service@0.3.33-beta.5)',
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

// ---------------------------------------------------------------------------
// Wallet derivation (standalone replica of the host's getMvcWallet path:
// CoinType.MVC + AddressType.LegacyMvc on livenet, index from the path).
// ---------------------------------------------------------------------------

let walletLib = null;

async function loadWalletLib() {
  if (walletLib) return walletLib;
  try {
    walletLib = await import('@metalet/utxo-wallet-service');
  } catch {
    console.error('Missing dependency @metalet/utxo-wallet-service — run `npm install` in this skill directory first.');
    process.exit(1);
  }
  return walletLib;
}

async function deriveMvcWallet() {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  if (!mnemonic) {
    console.error('IDBOTS_METABOT_MNEMONIC is required in the environment for signing modes (transfer/sell/cancel-sell/buy); never pass it as an argument');
    process.exit(1);
  }
  const pathStr = (process.env.IDBOTS_METABOT_PATH || "m/44'/10001'/0'/0/0").trim();
  const match = pathStr.match(/\/0\/(\d+)$/);
  const addressIndex = match ? parseInt(match[1], 10) : 0;

  const { MvcWallet, CoinType, AddressType } = await loadWalletLib();
  const wallet = await new MvcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.LegacyMvc,
    addressIndex,
    network: 'livenet',
    mnemonic,
  });
  return { wif: wallet.getPrivateKey(), address: wallet.getAddress() };
}

// ---------------------------------------------------------------------------
// Funding UTXOs (wallet-api v4/mvc/address/utxo-list; value >= 600 dust floor;
// confirmed-first ordering, optional 3-UTXO cap for trade ops).
// ---------------------------------------------------------------------------

async function fetchMvcFundingUtxos(address) {
  const all = [];
  let flag;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const res = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const json = await res.json();
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    all.push(...list.filter((u) => u.value >= 600));
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
}

function selectFundingUtxos(utxos, maxCount = null) {
  const ordered = utxos.filter((utxo) => Number.isFinite(Number(utxo?.satoshis)) && Number(utxo.satoshis) > 0);
  const confirmed = ordered.filter((utxo) => {
    if (utxo.confirmed === false) return false;
    if (utxo.height == null) return true;
    return Number(utxo.height) > 0;
  });
  const prioritized = confirmed.length > 0
    ? confirmed.concat(ordered.filter((utxo) => !confirmed.includes(utxo)))
    : ordered;
  return maxCount == null ? prioritized : prioritized.slice(0, maxCount);
}

async function prepareFundingUtxos(address, wif, { maxCount = null, excludeOutpoints = new Set() } = {}) {
  const all = await fetchMvcFundingUtxos(address);
  const mapped = all
    .map((utxo) => ({
      txId: String(utxo.txid || '').trim(),
      outputIndex: Number(utxo.outIndex),
      satoshis: Number(utxo.value),
      height: Number(utxo.height),
      address,
    }))
    .filter((utxo) => {
      const key = `${utxo.txId.toLowerCase()}:${utxo.outputIndex}`;
      return /^[0-9a-f]{64}$/i.test(utxo.txId)
        && Number.isInteger(utxo.outputIndex)
        && utxo.outputIndex >= 0
        && utxo.satoshis > 600
        && !excludeOutpoints.has(key);
    })
    .map((utxo) => ({ ...utxo, wif }));
  return selectFundingUtxos(mapped, maxCount);
}

function normalizeExcludeOutpoints(input) {
  if (!Array.isArray(input)) return new Set();
  return new Set(input
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)));
}

// ---------------------------------------------------------------------------
// NftManager (meta-contract; API_NET.MAIN + API_TARGET.APIMVC per pitfall #5).
// ---------------------------------------------------------------------------

function spentOutpointsOf(metaContract, txHex) {
  const tx = new metaContract.mvc.Transaction(txHex);
  return tx.inputs.map((input) => `${input.prevTxId.toString('hex')}:${Number(input.outputIndex)}`);
}

// ---------------------------------------------------------------------------
// mode=sell-orders (zero-dep read)
// ---------------------------------------------------------------------------

function normalizeSellOrderRow(row) {
  const txId = String(row.txId ?? row.TxId ?? '').trim();
  const rawIndex = row.txIndex ?? row.TxIndex;
  // The wallet-api sell view carries no output index: the NftManager always
  // places the sell-contract output at vout 0 (cross-checked on-chain against
  // open-api-mvc during S2).
  const outputIndex = rawIndex != null ? Number(rawIndex) : 0;
  if (!/^[0-9a-fA-F]{64}$/.test(txId)) return null;
  const price = Number(row.Price);
  const satoshis = Number(row.satoshi ?? row.satoshiString);
  const tokenIndex = row.tokenIndex != null ? Number(row.tokenIndex) : undefined;
  const height = row.height != null ? Number(row.height) : undefined;
  return {
    address: String(row.address ?? row.Address ?? '').trim(),
    txId,
    outputIndex: Number.isInteger(outputIndex) && outputIndex >= 0 ? outputIndex : 0,
    codeHash: String(row.codeHash ?? '').trim() || undefined,
    genesis: String(row.genesis ?? '').trim() || undefined,
    tokenIndex: Number.isInteger(tokenIndex) ? tokenIndex : undefined,
    priceSats: Number.isFinite(price) && price > 0 ? Math.round(price) : undefined,
    satoshis: Number.isFinite(satoshis) && satoshis > 0 ? Math.round(satoshis) : undefined,
    height: Number.isFinite(height) && height > 0 ? height : undefined,
    name: String(row.name ?? '').trim() || undefined,
    seriesName: String(row.seriesName ?? '').trim() || undefined,
  };
}

async function modeSellOrders(address) {
  if (!address) {
    console.error('mode=sell-orders requires address=<mvc-address>');
    usageAndExit();
  }
  const url = `${METALET_HOST}/wallet-api/v4/mvc/address/contract/nft/sell/utxo-list?net=${NET}&address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  const json = await res.json();
  const rows = Array.isArray(json?.list) ? json.list : [];
  const orders = rows.map(normalizeSellOrderRow).filter(Boolean);
  console.log(`address: ${address}`);
  console.log(`open sell orders: ${orders.length}`);
  for (const order of orders) {
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
  console.log(JSON.stringify({ mode: 'sell-orders', address, count: orders.length }));
}

// ---------------------------------------------------------------------------
// mode=transfer (single tx)
// ---------------------------------------------------------------------------

async function modeTransfer(args) {
  const genesis = String(args.genesis || '').trim();
  const codehash = String(args.codehash || '').trim();
  const tokenIndex = String(args.token_index || '').trim();
  const receiverAddress = String(args.receiver_address || '').trim();
  const feeRate = args.fee_rate != null ? Number(args.fee_rate) : 1;

  // MVC MetaContract genesis/codehash are 20-byte script hashes → 40 hex.
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

  const metaContract = await import('meta-contract');
  const { wif, address: senderAddress } = await deriveMvcWallet();
  const manager = new metaContract.NftManager({
    network: metaContract.API_NET.MAIN,
    apiTarget: metaContract.API_TARGET.APIMVC,
    purse: wif,
    feeb: feeRate,
  });

  const buildTransfer = async (excludeOutpoints) => {
    const utxos = await prepareFundingUtxos(senderAddress, wif, { excludeOutpoints });
    if (utxos.length === 0) throw new Error('No spendable MVC UTXOs after exclusions');
    // Pitfall #4: NftManager.transfer does NOT check the caller holds the
    // token — verify on-chain first (utxo-list) before firing a live build.
    const result = await manager.transfer({
      genesis,
      codehash,
      tokenIndex,
      senderWif: wif,
      receiverAddress,
      utxos,
      noBroadcast: true,
    });
    return {
      txHex: result.txHex,
      txid: result.txid,
      spentOutpoints: spentOutpointsOf(metaContract, result.txHex),
    };
  };

  if (args.dry) {
    const built = await buildTransfer(new Set());
    console.log('DRY transfer built successfully (nothing was broadcast):');
    console.log(`- transfer txid: ${built.txid} (${built.txHex.length / 2} bytes)`);
    console.log(`- move: #${tokenIndex} → ${receiverAddress}`);
    console.log(JSON.stringify({ mode: 'transfer', dry: true, txid: built.txid }));
    return;
  }

  const excludedOutpoints = new Set();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const built = await buildTransfer(excludedOutpoints);
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

// ---------------------------------------------------------------------------
// Two-stage broadcast driver (shared by sell / cancel-sell / buy; the modes
// only differ in the NftManager call and their report lines)
// ---------------------------------------------------------------------------

// Stage-1 retryable failure → rebuild excluding spent wallet utxos; stage-2
// retryable failure → re-send the SAME hex (its inputs are the
// already-broadcast stage-1 outputs); stage-2 hard failure → surface the
// stage-1 txid + preserved stage-2 hex for manual recovery.
async function broadcastTwoStageTrade(mode, buildTrade) {
  const excludedOutpoints = new Set();
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const built = await buildTrade(excludedOutpoints);
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

// ---------------------------------------------------------------------------
// mode=sell (two chained txs: contract funding, then NFT into the listing)
// ---------------------------------------------------------------------------

async function modeSell(args) {
  const genesis = String(args.genesis || '').trim();
  const codehash = String(args.codehash || '').trim();
  const tokenIndex = String(args.token_index || '').trim();
  const price = Number(args.price_sats);
  const feeRate = args.fee_rate != null ? Number(args.fee_rate) : 1;

  if (!isHex(genesis, 40) || !isHex(codehash, 40) || !/^\d+$/.test(tokenIndex)) {
    console.error('sell requires genesis (40 hex), codehash (40 hex) and token_index (digits)');
    usageAndExit();
  }
  // Mirrors the NftManager.sell guard (and the host wallet_nft_sell tool):
  // listings below 22000 sats are rejected by the SDK outright.
  if (!Number.isInteger(price) || price < 22000) {
    console.error('sell requires price_sats (integer >= 22000; the NftManager sell floor. 0.001 SPACE = 100000 sats)');
    usageAndExit();
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    console.error('fee_rate must be a positive number');
    usageAndExit();
  }

  const metaContract = await import('meta-contract');
  const { wif, address: sellerAddress } = await deriveMvcWallet();
  const manager = new metaContract.NftManager({
    network: metaContract.API_NET.MAIN,
    apiTarget: metaContract.API_TARGET.APIMVC,
    purse: wif,
    feeb: feeRate,
  });

  const buildSell = async (excludeOutpoints) => {
    const utxos = await prepareFundingUtxos(sellerAddress, wif, {
      maxCount: MAX_TRADE_FUNDING_UTXOS,
      excludeOutpoints,
    });
    if (utxos.length === 0) throw new Error('No spendable MVC UTXOs after exclusions');
    // Same pitfall #4 discipline as transfer: NftManager.sell does not prove
    // the caller holds the token — verify holdings (utxo-list) before a live
    // run; a non-holder build would only be rejected by the node on broadcast.
    const result = await manager.sell({
      genesis,
      codehash,
      tokenIndex,
      sellerWif: wif,
      price,
      utxos,
      noBroadcast: true,
    });
    // sellTxHex funds the sell contract (stage 1); txHex moves the NFT into
    // the listing and carries the sell-contract output at vout 0 — that
    // outpoint (result.txid:0) is what buyers quote as sell_txid.
    const fundingSpentOutpoints = spentOutpointsOf(metaContract, result.sellTxHex);
    return {
      fundingTxHex: result.sellTxHex,
      fundingTxid: result.sellTxId,
      txHex: result.txHex,
      txid: result.txid,
      fundingSpentOutpoints,
    };
  };

  // Dry mode: build both txs, report, never touch the broadcast endpoint —
  // and remember a dry run creates NO listing (nothing was broadcast).
  if (args.dry) {
    const built = await buildSell(new Set());
    console.log('DRY sell built successfully (nothing was broadcast; no listing exists yet):');
    console.log(`- listing txid: ${built.txid} (${built.txHex.length / 2} bytes; quote as sell_txid=${built.txid} sell_output_index=0 after the live run)`);
    console.log(`- funding txid: ${built.fundingTxid} (${built.fundingTxHex.length / 2} bytes)`);
    console.log(`- order: #${tokenIndex} ask ${price} sats by ${sellerAddress}`);
    console.log(JSON.stringify({ mode: 'sell', dry: true, listingTxid: built.txid, fundingTxid: built.fundingTxid, priceSats: price }));
    return;
  }

  const built = await broadcastTwoStageTrade('sell', buildSell);
  console.log('NFT sell listed on-chain.');
  console.log(`- listing txid: ${built.txid} (quote as sell_txid=${built.txid} sell_output_index=0)`);
  console.log(`- funding txid: ${built.fundingTxid}`);
  console.log(`- order: #${tokenIndex} ask ${price} sats by ${sellerAddress}`);
  console.log(JSON.stringify({ mode: 'sell', dry: false, listingTxid: built.txid, fundingTxid: built.fundingTxid, listingOutpoint: `${built.txid}:0`, priceSats: price }));
}

// ---------------------------------------------------------------------------
// mode=cancel-sell (two chained txs: unlock check, then NFT back to seller)
// ---------------------------------------------------------------------------

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
  // rejected by the API ("please include address data").
  if (!isHex(sellTxid, 64) || !Number.isInteger(outputIndex) || outputIndex < 0 || !sellerAddress || !Number.isInteger(price) || price <= 0) {
    console.error('cancel-sell requires the explicit four-tuple: sell_txid (64 hex), sell_output_index (int >= 0), seller_address, sell_price_sats (int > 0)');
    usageAndExit();
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    console.error('fee_rate must be a positive number');
    usageAndExit();
  }

  const metaContract = await import('meta-contract');
  const { wif, address: cancellerAddress } = await deriveMvcWallet();
  const manager = new metaContract.NftManager({
    network: metaContract.API_NET.MAIN,
    apiTarget: metaContract.API_TARGET.APIMVC,
    purse: wif,
    feeb: feeRate,
  });

  const buildCancel = async (excludeOutpoints) => {
    const utxos = await prepareFundingUtxos(cancellerAddress, wif, {
      maxCount: MAX_TRADE_FUNDING_UTXOS,
      excludeOutpoints,
    });
    if (utxos.length === 0) throw new Error('No spendable MVC UTXOs after exclusions');
    // Only the original seller can take an order down: seller_address must be
    // your own derived address. A foreign order's cancel builds locally (same
    // pitfall #4 shape) but is rejected by the node on broadcast.
    const result = await manager.cancelSell({
      genesis,
      codehash,
      tokenIndex,
      sellerWif: wif,
      sellUtxo: { txId: sellTxid, outputIndex, sellerAddress, price },
      utxos,
      noBroadcast: true,
    });
    const checkSpentOutpoints = spentOutpointsOf(metaContract, result.unlockCheckTxHex);
    return {
      fundingTxHex: result.unlockCheckTxHex,
      fundingTxid: result.unlockCheckTxId,
      txHex: result.txHex,
      txid: result.txid,
      fundingSpentOutpoints: checkSpentOutpoints,
    };
  };

  // Dry mode: build both txs, report, never touch the broadcast endpoint —
  // the order stays open until the real run.
  if (args.dry) {
    const built = await buildCancel(new Set());
    console.log('DRY cancel-sell built successfully (nothing was broadcast; the order stays open):');
    console.log(`- cancel txid: ${built.txid} (${built.txHex.length / 2} bytes)`);
    console.log(`- check txid:  ${built.fundingTxid} (${built.fundingTxHex.length / 2} bytes)`);
    console.log(`- order: #${tokenIndex} ${sellTxid}:${outputIndex} ask ${price} sats from ${sellerAddress}`);
    console.log(JSON.stringify({ mode: 'cancel-sell', dry: true, cancelTxid: built.txid, checkTxid: built.fundingTxid }));
    return;
  }

  const built = await broadcastTwoStageTrade('cancel-sell', buildCancel);
  console.log('NFT sell cancelled on-chain.');
  console.log(`- cancel txid: ${built.txid}`);
  console.log(`- check txid:  ${built.fundingTxid}`);
  console.log(`- order: #${tokenIndex} ${sellTxid}:${outputIndex} ask ${price} sats from ${sellerAddress}`);
  console.log(JSON.stringify({ mode: 'cancel-sell', dry: false, cancelTxid: built.txid, checkTxid: built.fundingTxid }));
}

// ---------------------------------------------------------------------------
// mode=buy (two chained txs: unlock-check, then purchase)
// ---------------------------------------------------------------------------

async function modeBuy(args) {
  const genesis = String(args.genesis || '').trim();
  const codehash = String(args.codehash || '').trim();
  const tokenIndex = String(args.token_index || '').trim();
  const sellTxid = String(args.sell_txid || '').trim();
  const outputIndex = Number(args.sell_output_index);
  const sellerAddress = String(args.seller_address || '').trim();
  const price = Number(args.sell_price_sats);
  const feeRate = args.fee_rate != null ? Number(args.fee_rate) : 1;

  if (!isHex(genesis, 40) || !isHex(codehash, 40) || !/^\d+$/.test(tokenIndex)) {
    console.error('buy requires genesis (40 hex), codehash (40 hex) and token_index (digits)');
    usageAndExit();
  }
  // The four-tuple is mandatory: the bare-outpoint path is rejected by the
  // API ("please include address data"), so the CLI takes no shortcuts.
  if (!isHex(sellTxid, 64) || !Number.isInteger(outputIndex) || outputIndex < 0 || !sellerAddress || !Number.isInteger(price) || price <= 0) {
    console.error('buy requires the explicit four-tuple: sell_txid (64 hex), sell_output_index (int >= 0), seller_address, sell_price_sats (int > 0)');
    usageAndExit();
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    console.error('fee_rate must be a positive number');
    usageAndExit();
  }

  const metaContract = await import('meta-contract');
  const { wif, address: buyerAddress } = await deriveMvcWallet();
  const manager = new metaContract.NftManager({
    network: metaContract.API_NET.MAIN,
    apiTarget: metaContract.API_TARGET.APIMVC,
    purse: wif,
    feeb: feeRate,
  });

  const buildTrade = async (excludeOutpoints) => {
    const utxos = await prepareFundingUtxos(buyerAddress, wif, {
      maxCount: MAX_TRADE_FUNDING_UTXOS,
      excludeOutpoints,
    });
    if (utxos.length === 0) throw new Error('No spendable MVC UTXOs after exclusions');
    const result = await manager.buy({
      genesis,
      codehash,
      tokenIndex,
      buyerWif: wif,
      buyerAddress,
      sellUtxo: { txId: sellTxid, outputIndex, sellerAddress, price },
      utxos,
      noBroadcast: true,
    });
    const checkSpentOutpoints = spentOutpointsOf(metaContract, result.unlockCheckTxHex);
    return {
      fundingTxHex: result.unlockCheckTxHex,
      fundingTxid: result.unlockCheckTxId,
      txHex: result.txHex,
      txid: result.txid,
      fundingSpentOutpoints: checkSpentOutpoints,
    };
  };

  if (args.dry) {
    const built = await buildTrade(new Set());
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
