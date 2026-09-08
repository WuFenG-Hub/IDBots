import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMetawebLearningAgentTools } = require('../dist-electron/main/libs/metawebLearningAgentTools.js');

function makeHarness(searchResult) {
  const calls = { search: [] };
  const metawebLearning = {
    search: async (input) => {
      calls.search.push(input);
      return searchResult ?? { items: [], hasMore: false, nextCursor: null };
    },
    readPin: async () => {
      throw new Error('not used in this test');
    },
  };
  const tools = buildMetawebLearningAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    metawebLearning,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('search_metaweb empty results point to the ask path (post_simplequestion, non-blocking, self-answer)', async () => {
  const { byName } = makeHarness();
  const result = await byName.search_metaweb.handler({ query: 'hyperframes skill package' });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /No MetaWeb content matched "hyperframes skill package"\./);
  // The ask nudge: the moment of "chain lacks this" now carries the question path.
  assert.match(text, /post_simplequestion/);
  assert.match(text, /title ending in a question mark/);
  assert.match(text, /does not block your work/);
  assert.match(text, /answer your own question once you solve it/);
  // Honesty discipline stays.
  assert.match(text, /do NOT invent pins or content/);
});

test('search_metaweb with results keeps the honest-search flow (no ask nudge needed)', async () => {
  const { byName } = makeHarness({
    items: [
      {
        pinId: 'ab12i0', currentPinId: 'ab12i0', chainName: 'mvc', protocol: 'simplenote',
        path: '/protocols/simplenote', title: 'A relevant note', summary: 'covers it',
        publisher: { globalMetaId: 'gmid-1', metaid: 'mid-1', name: 'Author', address: '' },
        createdAt: 1755000000, score: 5, tags: [],
      },
    ],
    hasMore: false,
    nextCursor: null,
  });
  const result = await byName.search_metaweb.handler({ query: 'hyperframes' });
  assert.equal(result.isError, undefined);
  assert.doesNotMatch(result.content[0].text, /No MetaWeb content matched/);
});
