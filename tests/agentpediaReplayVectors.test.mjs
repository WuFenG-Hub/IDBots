// Mechanical harness for the Agentpedia adoption-algo-v1 replay vectors.
// Run: node --test tests/agentpediaReplayVectors.test.mjs
//
// G2 contract: this harness and the MetaSo implementation must consume the SAME
// vectors file (src/agentpedia-core/replay-vectors.v1.json) and produce the same
// view for the same event stream.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replay, ALGO_VERSION } from '../src/agentpedia-core/adoption-algo-v1.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(
  readFileSync(join(here, '../src/agentpedia-core/replay-vectors.v1.json'), 'utf8'),
);

const PATHS = {
  rev: '/protocols/agentpedia/rev',
  challenge: '/protocols/agentpedia/challenge',
  ruling: '/protocols/agentpedia/ruling',
  review: '/protocols/agentpedia/review',
  editor: '/protocols/agentpedia/editor',
  constitution: '/protocols/agentpedia/constitution',
  'param-proposal': '/protocols/agentpedia/param-proposal',
};

function buildEvents(vec) {
  const d = vectors.defaults;
  const founders = vec.founders ?? d.founders;
  const params = { ...d.params, ...(vec.paramOverrides ?? {}) };
  const genesis = {
    pin: 'genesis',
    path: PATHS.constitution,
    sender: founders[0],
    height: 1,
    txIndex: 0,
    payload: {
      v: 1,
      revision: 0,
      prevConstitution: null,
      proposalPin: null,
      founders,
      params,
      algoVersions: {
        adoption: 'adoption-algo-v1',
        reputation: 'reputation-algo-v1',
        arbiterDraw: 'arbiter-draw-v1',
      },
    },
  };
  const rest = vec.events.map((e) => ({ ...e, path: PATHS[e.path], txIndex: 0 }));
  return [genesis, ...rest];
}

function buildOptions(vec) {
  const d = vectors.defaults;
  const arbiterOverrides = {};
  for (const e of vec.events) {
    if (e.path === 'ruling' && e.payload?.action === 'proposal') {
      arbiterOverrides[e.pin] = e.arbiters ?? d.arbiters;
    }
  }
  return {
    blocksPerHour: d.blocksPerHour,
    blocksPerDay: d.blocksPerDay,
    arbiterOverrides,
    frozenArbiterOverrides: vec.frozenArbiterOverrides ?? {},
    editorsRep: vec.editorsRep ?? {},
    clusterAliases: vec.clusterAliases ?? {},
  };
}

function resolve(view, dottedPath) {
  let cur = view;
  for (const seg of dottedPath.split('.')) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

// jsonAbsent reports whether a resolved view value is the JS shape of "not
// there": undefined (the path does not exist), null, or the empty string (the
// form an omitempty-dropped value or a never-written plate takes). Twin of
// jsonAbsent in the Go harness (internal/agentpedia/vectors_test.go): both sides
// must judge the same path identically.
function jsonAbsent(value) {
  return value === undefined || value === null || value === '';
}

function assertExpect(view, expect) {
  for (const [path, expected] of Object.entries(expect)) {
    if (path.endsWith('.$absent')) {
      // `<path>.$absent` passes when the path does not exist at all, or resolves
      // to null / '' — the only way to assert a non-existence with this
      // vocabulary (the declared view contract carries no `redirect` field, so
      // `redirect` is always an existence question).
      const actual = resolve(view, path.slice(0, -'.$absent'.length));
      assert.ok(
        jsonAbsent(actual),
        `${path}: expected absent, got ${JSON.stringify(actual)}`,
      );
    } else if (path.endsWith('.$contains')) {
      const parentPath = path.slice(0, -'.$contains'.length);
      const parent = resolve(view, parentPath);
      if (!Array.isArray(parent)) {
        throw new Error(`${parentPath} is not an array: ${JSON.stringify(parent)}`);
      }
      const ok =
        expected !== null && typeof expected === 'object'
          ? parent.some(
              (el) =>
                el !== null &&
                typeof el === 'object' &&
                Object.entries(expected).every(([k, v]) => el[k] === v),
            )
          : parent.includes(expected);
      assert.ok(ok, `${path}: expected to contain ${JSON.stringify(expected)}, got ${JSON.stringify(parent)}`);
    } else {
      const indexed = path.match(/^(.*)\.\$contains\.(\d+)$/);
      if (indexed) {
        const parent = resolve(view, indexed[1]);
        if (!Array.isArray(parent)) {
          throw new Error(`${indexed[1]} is not an array: ${JSON.stringify(parent)}`);
        }
        assert.deepStrictEqual(
          parent[Number(indexed[2])],
          expected,
          `${path}: expected graveyard[${indexed[2]}] to equal ${JSON.stringify(expected)}, got ${JSON.stringify(parent[Number(indexed[2])])}`,
        );
      } else {
        const actual = resolve(view, path);
        assert.deepStrictEqual(
          actual,
          expected,
          `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        );
      }
    }
  }
}

function runVector(vec) {
  const events = buildEvents(vec);
  const checkpoints =
    vec.checkpoints ??
    [{ pins: null, expect: vec.expect }];
  for (const cp of checkpoints) {
    const slice = cp.pins ? events.filter((e) => cp.pins.includes(e.pin)) : events;
    const view = replay(slice, buildOptions(vec));
    assertExpect(view, cp.expect);
  }
}

test('vectors file declares 25 pipeline + supplementary sets for adoption-algo-v1', () => {
  assert.equal(vectors.meta.algoVersion, ALGO_VERSION);
  assert.equal(vectors.vectors.length, 25);
  assert.ok(Array.isArray(vectors.supplementary) && vectors.supplementary.length > 0);
});

for (const vec of vectors.vectors) {
  test(`pipeline ${vec.id}: ${vec.title}`, () => {
    runVector(vec);
  });
}

for (const vec of vectors.supplementary) {
  test(`supplementary ${vec.id}: ${vec.title}`, () => {
    runVector(vec);
  });
}

test('headline: replay vectors 25/25 pass', () => {
  const failures = [];
  for (const vec of vectors.vectors) {
    try {
      runVector(vec);
    } catch (err) {
      failures.push(`${vec.id}: ${err.message}`);
    }
  }
  assert.deepStrictEqual(failures, [], `failing vectors:\n${failures.join('\n')}`);
});
