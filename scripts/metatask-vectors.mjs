#!/usr/bin/env node
/**
 * MetaTask engine conformance-vector runner + canonical sha256 printer.
 *
 * The vector set (tests/fixtures/metatask/conformance-vectors.json) is the
 * cross-engine artifact required by the v1.2.1 registration body
 * (conformance.fixtureSet): Python skill, metaso Go indexer and this TS
 * engine must all run the SAME set green before H_ACT2. This script runs the
 * set against the compiled IDBots TS engine and prints the set's
 * canonical-JSON sha256 (canonJ per Appendix A) — the value the registration
 * publisher announces alongside the pinned copy. Exit 1 on any failure.
 *
 * Usage: pnpm run metatask:vectors
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { replayMetaTask } = require('../dist-electron/main/services/metatask/engine.js');
const { innerHash, outerHash, canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const setPath = path.join(here, '..', 'tests', 'fixtures', 'metatask', 'conformance-vectors.json');
const set = JSON.parse(readFileSync(setPath, 'utf-8'));
const canonicalSha256 = sha256Hex(canonJ(set));

let failed = 0;
for (const vector of set.vectors) {
  if (vector.kind === 'hash') {
    const inner = innerHash(vector.input);
    const outer = outerHash({ ...vector.input, hash: inner });
    if (inner === vector.expectInner && outer === vector.expectOuter) {
      console.log(`PASS ${vector.id}`);
    } else {
      failed += 1;
      console.log(`FAIL ${vector.id} inner=${inner} outer=${outer}`);
    }
    continue;
  }
  try {
    const projection = replayMetaTask(vector.events, vector.options ?? {});
    const notes = [];
    let ok = true;
    for (const [node, status] of Object.entries(vector.expect.nodes ?? {})) {
      if (projection.nodeStates[node]?.status !== status) {
        ok = false;
        notes.push(`${node}=${projection.nodeStates[node]?.status ?? 'missing'} want ${status}`);
      }
    }
    if (vector.expect.taskComplete !== undefined && projection.taskComplete !== vector.expect.taskComplete) {
      ok = false;
      notes.push(`taskComplete=${projection.taskComplete} want ${vector.expect.taskComplete}`);
    }
    if (vector.expect.settlement === null && projection.settlement !== null) {
      ok = false;
      notes.push('expected no settlement');
    }
    if (vector.expect.settlementShareSumBP !== undefined) {
      const sum = (projection.settlement?.shares ?? []).reduce((acc, share) => acc + share.shareBP, 0);
      if (sum !== vector.expect.settlementShareSumBP) {
        ok = false;
        notes.push(`settlementSum=${sum} want ${vector.expect.settlementShareSumBP}`);
      }
    }
    if (vector.expect.ignoredContains) {
      const hit = projection.ignoredEvents.some(
        (entry) =>
          entry.pinId === vector.expect.ignoredContains.pinId &&
          entry.reason === vector.expect.ignoredContains.reason
      );
      if (!hit) {
        ok = false;
        notes.push(`missing ignored entry ${vector.expect.ignoredContains.reason}`);
      }
    }
    if (ok) {
      console.log(`PASS ${vector.id}`);
    } else {
      failed += 1;
      console.log(`FAIL ${vector.id}: ${notes.join('; ')}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${vector.id}: threw ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\nvectors: ${set.vectors.length}  failed: ${failed}`);
console.log(`protocol: ${set.protocolVersion}`);
console.log(`canonical sha256 (canonJ of the parsed vector set): ${canonicalSha256}`);
process.exit(failed > 0 ? 1 : 0);
