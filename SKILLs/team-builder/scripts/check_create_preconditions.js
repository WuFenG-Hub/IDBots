#!/usr/bin/env node
/**
 * team-builder skill script: run the CREATE pre-checks before calling
 * metabot_create (FR4 discipline — never "run first, discover partial later").
 *
 * Usage:
 *   node check_create_preconditions.js --name '热点选题官'            # name-uniqueness check
 *   node check_create_preconditions.js --mvc-address <addr> --estimate-sats 3000   # balance check
 *   node check_create_preconditions.js --name 'X' --mvc-address <addr> --estimate-sats 3000
 *
 * Checks:
 *   1. Name uniqueness — metabots.name is UNIQUE. Lists local bots through the
 *      IDBots RPC gateway (same gateway as metabot-group-task) and reports
 *      exact + case-insensitive collisions, with suggested suffixed names.
 *   2. Wallet balance — queries the Metalet public balance API for an MVC
 *      address (the fresh wallet's address after creation, or a bot wallet
 *      before a re-sync) and compares it against the estimated fee.
 *
 * Notes:
 *   - The main process ALSO hard-gates creation (createMetaBotOnChainCore
 *     refuses with INSUFFICIENT_BALANCE when the subsidized fresh wallet is
 *     below the minimum). This script gives the Twin a pre-flight read so the
 *     cost message reaches the user BEFORE any confirm dialog.
 *   - RPC base: process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200'
 *     RPC auth: IDBOTS_RPC_TOKEN, or IDBOTS_RPC_AUTHFILE mirror file.
 *
 * Output: one JSON object on stdout; exit 0 when checks ran (see .pass flags),
 * exit 1 only on operational failure (RPC unreachable, bad args).
 */
'use strict';

const fs = require('fs');

const RPC_URL = (process.env.IDBOTS_RPC_URL || 'http://127.0.0.1:31200').replace(/\/$/, '');
const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

function resolveRpcToken(env) {
  const fromEnv = String(env.IDBOTS_RPC_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const authFile = String(env.IDBOTS_RPC_AUTHFILE || '').trim();
  if (!authFile) return '';
  try {
    return fs.readFileSync(authFile, 'utf-8').trim();
  } catch {
    return '';
  }
}
const RPC_TOKEN = resolveRpcToken(process.env);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--name' && argv[i + 1]) {
      out.name = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--mvc-address' && argv[i + 1]) {
      out.mvcAddress = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--estimate-sats' && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) out.estimateSats = Math.floor(n);
      i += 1;
    }
  }
  return out;
}

async function listLocalBots() {
  const headers = { 'Content-Type': 'application/json' };
  if (RPC_TOKEN) headers.Authorization = `Bearer ${RPC_TOKEN}`;
  const res = await fetch(`${RPC_URL}/api/idbots/list-metabots`, {
    method: 'POST',
    headers,
    body: JSON.stringify({}),
  });
  if (!res.ok) throw new Error(`RPC list-metabots HTTP ${res.status}`);
  const json = await res.json();
  if (!json || json.success !== true) {
    throw new Error(`RPC list-metabots failed: ${JSON.stringify(json).slice(0, 200)}`);
  }
  const bots = Array.isArray(json.metabots) ? json.metabots : (Array.isArray(json.bots) ? json.bots : []);
  return bots;
}

async function getMvcBalanceSatoshis(address) {
  const url = `${METALET_HOST}/wallet-api/v4/mvc/address/balance-info?net=${NET}&address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Metalet balance HTTP ${res.status}`);
  const json = await res.json();
  if (json.code !== 0) throw new Error(json.message || 'Failed to fetch MVC balance');
  return Number(json.data?.confirmed ?? 0);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.name && !args.mvcAddress) {
    console.error('Nothing to check: pass --name and/or --mvc-address.');
    process.exit(1);
  }

  const report = { ok: true, checks: {} };

  if (args.name) {
    const wanted = args.name.trim();
    try {
      const bots = await listLocalBots();
      const exact = bots.find((b) => String(b.name ?? '').trim() === wanted);
      // metabots.name is byte-UNIQUE; the case-insensitive scan is an early
      // courtesy warning so the Twin can restyle before the DB ever rejects.
      const ci = bots.find(
        (b) => b !== exact && String(b.name ?? '').trim().toLowerCase() === wanted.toLowerCase(),
      );
      report.checks.name = {
        pass: !exact,
        wanted,
        conflict: exact ? { id: exact.id, name: exact.name } : null,
        case_insensitive_conflict: ci ? { id: ci.id, name: ci.name } : null,
        suggestions: exact
          ? [`${wanted}2`, `${wanted}-II`, `${wanted}·副手`]
          : [],
      };
    } catch (err) {
      report.checks.name = { pass: null, error: err.message, hint: 'RPC gateway unavailable; metabot_create still hard-checks uniqueness.' };
    }
  }

  if (args.mvcAddress) {
    try {
      const satoshis = await getMvcBalanceSatoshis(args.mvcAddress);
      const estimate = args.estimateSats ?? null;
      report.checks.balance = {
        pass: estimate == null ? null : satoshis >= estimate,
        address: args.mvcAddress,
        satoshis,
        estimate_sats: estimate,
        shortfall_sats: estimate != null ? Math.max(0, estimate - satoshis) : null,
      };
    } catch (err) {
      report.checks.balance = { pass: null, error: err.message };
    }
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
