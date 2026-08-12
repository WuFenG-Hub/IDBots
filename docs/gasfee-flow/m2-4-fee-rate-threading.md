# M2.4 — Fee Rate Threading Through All createPin Call Sites

Status: ready to start (only open milestone of Phase 2).
Roadmap ref: `roadmap.md` Phase 2, M2.4.

## Why this matters

- Backend billing is **by actual `txSize` bytes**, so the fee rate does not
  change how much traffic a user is charged. But the rate still decides:
  1. the miner fee baked into every self-pay transaction;
  2. the `saved_fee` figure shown in the traffic journal ("what the pool paid
     for you");
  3. whether ops-side dynamic rate changes (backend admin console) are
     reflected consistently in the client's own transactions.
- Today the rate is passed explicitly at *most* call sites, but `createPin`
  itself still accepts an omitted rate and silently falls back to a hard-coded
  constant — an invisible default we want to eliminate.

## Current architecture (verified 2026-08-11)

- `src/main/services/feeRateStore.ts` — main-process singleton. Loads fee
  tiers from the Metalet API (`FEE_APIS`), persists the user's tier selection
  per chain in the kv store (`fee_rate_selection`), exposes
  `getRate(chain)` / `getAllTiers()`. Defaults: mvc = 1 sat/byte.
- `src/main/services/metaidCore.ts` — `createPin(...)` accepts
  `options.feeRate`; when omitted it falls back to
  `FALLBACK_FEE_RATES[network] ?? 1` (see ~line 573 and ~line 799).
- `src/main/main.ts` — ~20 `createPin(...)` call sites; most already pass
  `{ feeRate: getGlobalFeeRate('mvc') }`, one uses
  `getGlobalFeeRate(resolveCreatePinNetwork(options?.network))` (~line 2714).
  This is an audit list, not proof of completeness.
- `src/main/services/metaidRpcServer.ts` — external RPC callers may pass
  `fee_rate` per request (validated as positive number, ~lines 508–1115).
  Behavior when `fee_rate` is absent needs to be pinned down (currently
  inherits the createPin silent fallback).
- `src/main/services/mvcSponsorCreatePin.ts` / `mvcSponsorUpload.ts` —
  traffic/sponsor path; the backend selects and applies its own rate when
  assembling the funded transaction (dynamic `CurrentFeeRate` server-side).
- `src/main/libs/createPinWorker.ts` — worker receives `feeRate` in its
  payload (~line 134) and uses it for UTXO selection + change output.

## Work items

1. **Audit**: enumerate every `createPin(` call (main.ts, metaidRpcServer.ts,
   im/cowork handlers, anywhere else grep finds) and classify:
   explicit rate / RPC-provided rate / silent fallback.
2. **Single resolution helper**: introduce one function (e.g.
   `resolveCreatePinFeeRate(network, explicit?)`) that every call site uses:
   explicit RPC value if present and valid → otherwise `feeRateStore.getRate`.
   Remove reliance on `FALLBACK_FEE_RATES` inside `createPin` (keep the
   constant only as a last-resort safety net inside the helper, logged).
3. **RPC server**: when `fee_rate` is absent, resolve via the same helper so
   external bots get the user's selected tier, not a hidden constant.
4. **Consistency check vs sponsor path**: confirm the self-pay rate shown in
   Settings (tier list) and the rate used for `saved_fee` accounting are
   coherent; document any intentional divergence.
5. **Tests**: extend the createPin fallback matrix tests; add a case for the
   RPC path without `fee_rate`; keep
   `tests/trafficAccountService.test.mjs` green.

## Verification

- `npm run compile:electron` **first** (tests import `dist-electron/`), then
  `npx tsx --test tests/trafficAccountService.test.mjs` plus the createPin /
  metaidCore test files, `npx tsc --noEmit` and
  `npx tsc --noEmit -p tsconfig.node.json`.

## Out of scope

- Changing the fee-tier UI or tier source (Metalet API).
- Backend dynamic-rate logic (already delivered: admin-adjustable rate).
