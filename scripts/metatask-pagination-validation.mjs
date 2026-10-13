/**
 * 2026-10-13 pagination-fix live validation (requirement ② + ③).
 *
 *   node scripts/metatask-pagination-validation.mjs
 *
 * ② RSI root 82aa4332… (competitive): the pool walk must now reach the deep
 *   submissions (N3/N4/N5) that the 100-page ceiling dropped; the projection
 *   must fold them in and the pending pass votes must count.
 * ③ No-regression: for the TLMC and JSP roots the collected event set (and
 *   eventSetHash) must be byte-identical between the old ceiling (maxPages
 *   = 100) and the fixed walk (default 1000) — those pools fit inside the old
 *   budget, so the fix must not change a single event byte for them.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { collectMetaTaskEvents } = require('../dist-electron/main/services/metatask/collector.js');
const { replayMetaTask, taskEventSet } = require('../dist-electron/main/services/metatask/engine.js');
const { canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');

const RSI = '82aa43326703f1702ba77d778c493c6334de450cc157df92c90b1885fe4a97d4i0';
const TLMC = '08cac496';
const JSP = 'a7548162';
const N3 = '0cb6fb3e55266ae84dadf3f977f9f3d91e063275a8c5ebdd1ae10b8fc8ace08fi0';
const N4 = '19f6fc3e3304e97b2157537caa68be30960efbeaea1b17bf97a4abbb962b36d7i0';
const N5 = '91fcd0df1c932231f88c6409f19ebcbe269e896c30bb3d6f1d4df7e5c268026ei0';
const PENDING_PASS = ['fc9d2c21', '96c29e11', '1b9e7024'];
const FIXED_TS = 1_791_857_000_000; // pinned clock so byte-compare is not clock noise

const main = async () => {
  console.log('== collecting event pools (fixed walk, default guard) ==');
  const fixed = await collectMetaTaskEvents({ timeoutMs: 8000 });
  console.log('perPath:', fixed.perPath.map((x) => `${x.path}=${x.count}`).join(' '));

  console.log('\n== collecting with the OLD ceiling (maxPages=100) for comparison ==');
  const legacy = await collectMetaTaskEvents({ timeoutMs: 8000, maxPages: 100 });
  console.log('perPath:', legacy.perPath.map((x) => `${x.path}=${x.count}`).join(' '));

  // ---- ② RSI root ----
  console.log('\n== ② RSI root', RSI, '==');
  const setFixed = taskEventSet(fixed.events, { rootPinId: RSI });
  const setLegacy = taskEventSet(legacy.events, { rootPinId: RSI });
  console.log('scoped events: legacy =', setLegacy.scoped.length, '/ fixed =', setFixed.scoped.length);
  const hashOf = (set) => sha256Hex(canonJ(set.hashEntries));
  console.log('legacy eventSetHash:', hashOf(setLegacy));
  console.log('fixed  eventSetHash:', hashOf(setFixed));
  for (const pin of [N3, N4, N5]) {
    const inFixed = setFixed.scoped.some((e) => e.pinId === pin);
    const inLegacy = setLegacy.scoped.some((e) => e.pinId === pin);
    console.log(`deep submission ${pin.slice(0, 8)}…: legacy=${inLegacy ? 'IN' : 'MISSING'} fixed=${inFixed ? 'IN' : 'MISSING'}`);
  }
  const proj = replayMetaTask(fixed.events, { rootPinId: RSI, evaluatedAtMs: FIXED_TS });
  const chain = proj.winningChain ?? proj.settlement?.winningChain ?? [];
  const allInChain = [N3, N4, N5].every((pin) => chain.includes(pin));
  console.log('taskComplete:', proj.taskComplete, '| progress:', JSON.stringify(proj.progress));
  console.log('winningChain contains N3/N4/N5:', allInChain, `(${chain.length} subs)`);
  console.log('settlement:', proj.settlement ? `produced (mode=${proj.settlement.mode})` : 'null');
  if (!(proj.taskComplete && allInChain && proj.settlement)) process.exitCode = 1;
  const votes = fixed.events.filter((e) => e.path === 'verify' && PENDING_PASS.some((p) => e.pinId.startsWith(p)));
  console.log('pending pass votes now in the event set:', votes.length, '/', PENDING_PASS.length);

  // ---- ③ no-regression roots ----
  for (const root of [TLMC, JSP]) {
    const rootPin = fixed.events.find((e) => e.path === 'task' && e.pinId.startsWith(root))?.pinId;
    if (!rootPin) { console.log(`\n== ③ root ${root}…: task pin not found in pool, SKIP`); continue; }
    const a = taskEventSet(legacy.events, { rootPinId: rootPin });
    const b = taskEventSet(fixed.events, { rootPinId: rootPin });
    const ha = sha256Hex(canonJ(a.hashEntries));
    const hb = sha256Hex(canonJ(b.hashEntries));
    const pa = replayMetaTask(legacy.events, { rootPinId: rootPin, evaluatedAtMs: FIXED_TS });
    const pb = replayMetaTask(fixed.events, { rootPinId: rootPin, evaluatedAtMs: FIXED_TS });
    const projSame = JSON.stringify(pa) === JSON.stringify(pb);
    const same = ha === hb && projSame;
    console.log(`\n== ③ root ${root}… (${rootPin.slice(0, 10)}…): scoped legacy=${a.scoped.length} fixed=${b.scoped.length}, eventSetHash ${ha === hb ? 'IDENTICAL ' + ha.slice(0, 12) : 'DIFFERS'}, projection ${projSame ? 'IDENTICAL' : 'DIFFERS'}`);
    if (!same) process.exitCode = 1;
  }
};

main().catch((e) => { console.error(e); process.exit(1); });
