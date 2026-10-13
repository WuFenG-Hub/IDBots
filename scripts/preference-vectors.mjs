#!/usr/bin/env node
/** Replays the frozen preference tally vectors against the compiled engine. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { checkScenario } from '../tests/fixtures/preference/scenarios.mjs';

const require = createRequire(import.meta.url);
const { tallyRound } = require('../dist-electron/main/services/preference/engine.js');
const { canonJ, sha256Hex } = require('../dist-electron/main/services/metatask/canon.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'tests', 'fixtures', 'preference', 'tally-vectors.json'), 'utf8'),
);

let failures = 0;
const outputs = [];
for (const vector of fixture.vectors) {
  const tally = tallyRound(vector.events, vector.round, { nowSec: vector.nowSec });
  if (!tally.ok) {
    failures += 1;
    console.log(`FAIL ${vector.id}: ${tally.reason}`);
    continue;
  }
  const problems = checkScenario(tally.result, vector.expect);
  if (problems.length > 0) {
    failures += 1;
    console.log(`FAIL ${vector.id}: ${problems.join('; ')}`);
  } else {
    console.log(`PASS ${vector.id}`);
  }
  outputs.push({ id: vector.id, output: tally.result.output, tallyHash: tally.result.tallyHash });
}

const digest = sha256Hex(canonJ(outputs));
console.log(`CANONICAL_SHA256 ${digest}`);
if (digest !== fixture.canonicalSha256) {
  failures += 1;
  console.log(`FAIL canonical digest differs from the fixture (${fixture.canonicalSha256})`);
}
if (failures > 0) {
  console.log(`${failures} FAILURE(S)`);
  process.exit(1);
}
console.log('ALL VECTORS PASS');
