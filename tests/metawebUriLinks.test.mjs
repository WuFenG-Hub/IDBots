import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  buildPinBrowserUri,
  buildSearchItemBrowserUri,
  buildMetaIdBrowserUri,
  markdownSelfLink,
  METAWEB_CITATION_RULE,
} = require('../dist-electron/main/libs/metawebUri.js');
const {
  buildMetawebLearningAgentTools,
  formatMetawebSearchBullets,
  formatMetawebPinDetail,
} = require('../dist-electron/main/libs/metawebLearningAgentTools.js');

const PIN = '1efcf89496d74d839012d65feb00634b60cc791bd593cb0699d3ac6e99edefa7i0';

// ---------------------------------------------------------------------------
// metawebUri helper
// ---------------------------------------------------------------------------

test('buildPinBrowserUri picks the scheme from the on-chain path first', () => {
  assert.equal(buildPinBrowserUri({ pinId: PIN, path: '/protocols/metaapp' }), `metaapp://${PIN}`);
  assert.equal(buildPinBrowserUri({ pinId: PIN, path: '/file' }), `metafile://${PIN}`);
  assert.equal(buildPinBrowserUri({ pinId: PIN, path: '/protocols/simplenote' }), `pin://${PIN}`);
  assert.equal(buildPinBrowserUri({ pinId: PIN }), `pin://${PIN}`);
});

test('buildPinBrowserUri falls back to the protocol key and normalizes the pinId', () => {
  assert.equal(buildPinBrowserUri({ pinId: PIN, protocol: 'metaapp' }), `metaapp://${PIN}`);
  assert.equal(buildPinBrowserUri({ pinId: PIN, protocol: 'file' }), `metafile://${PIN}`);
  assert.equal(buildPinBrowserUri({ pinId: `  ${PIN.toUpperCase()}  ` }), `pin://${PIN}`);
  assert.equal(buildPinBrowserUri({ pinId: '' }), '');
});

test('buildSearchItemBrowserUri prefers the current (latest) pin of the chain', () => {
  assert.equal(
    buildSearchItemBrowserUri({ pinId: 'old0000i0', currentPinId: PIN, protocol: 'metaapp' }),
    `metaapp://${PIN}`,
  );
  assert.equal(
    buildSearchItemBrowserUri({ pinId: PIN }),
    `pin://${PIN}`,
  );
});

test('buildMetaIdBrowserUri and markdownSelfLink shape', () => {
  assert.equal(buildMetaIdBrowserUri(' idq1alice123 '), 'metaid://idq1alice123');
  assert.equal(buildMetaIdBrowserUri(''), '');
  assert.equal(markdownSelfLink(`pin://${PIN}`), `[pin://${PIN}](pin://${PIN})`);
  assert.equal(markdownSelfLink(''), '');
});

test('METAWEB_CITATION_RULE forbids Web2 viewer URLs', () => {
  assert.match(METAWEB_CITATION_RULE, /pin:\/\//);
  assert.match(METAWEB_CITATION_RULE, /metaapp:\/\//);
  assert.match(METAWEB_CITATION_RULE, /metafile:\/\//);
  assert.match(METAWEB_CITATION_RULE, /NEVER construct Web2 viewer URLs/i);
});

// ---------------------------------------------------------------------------
// metawebLearningAgentTools output shapes
// ---------------------------------------------------------------------------

const SAMPLE_ITEM = {
  protocol: 'metabot-skill',
  pinId: PIN,
  currentPinId: PIN,
  chainName: 'mvc',
  title: 'auto-editor 技能包',
  summary: '一键剪掉视频静音段',
  tags: ['video'],
  publisher: { globalMetaId: 'idq1eleven42', metaid: 'legacy1', name: 'eleven', address: '', avatar: '' },
  createdAt: 1786122527,
  score: 1,
  extra: {},
};

const APP_PIN = `ab${PIN.slice(2)}`;
const SAMPLE_METAAPP_ITEM = { ...SAMPLE_ITEM, protocol: 'metaapp', pinId: APP_PIN, currentPinId: APP_PIN, title: 'Skill Market' };

const SAMPLE_PIN = {
  pinId: PIN,
  currentPinId: PIN,
  protocol: 'simplenote',
  path: '/protocols/simplenote',
  chainName: 'mvc',
  operation: 'create',
  creator: { globalMetaId: 'idq1eleven42', metaid: 'legacy1', name: 'eleven', address: '' },
  createdAt: 1786122527,
  contentType: 'text/markdown',
  payload: null,
  text: 'body',
  truncated: false,
  totalLength: 4,
  meta: { title: 'auto-editor 亲测', summary: '', tags: [] },
  attachments: [
    { uri: `metafile://att1i0.png`, url: `https://file.metaid.io/metafile-indexer/api/v1/files/content/att1i0`, contentType: 'image/png', size: 10 },
  ],
  source: 'local',
};

test('search bullets quote titles as protocol-aware MetaWeb URI links', () => {
  const bullets = formatMetawebSearchBullets([SAMPLE_ITEM, SAMPLE_METAAPP_ITEM]);
  assert.match(bullets, new RegExp(`\\*\\[auto-editor 技能包\\]\\(pin://${PIN}\\)\\*\\*`));
  assert.match(bullets, new RegExp(`\\*\\[Skill Market\\]\\(metaapp://${APP_PIN}\\)\\*\\*`));
  // The plain pin: id stays available for read_metaweb_pin calls.
  assert.match(bullets, new RegExp(`pin: ${PIN}`));
});

test('read_metaweb_pin detail sheet carries a ready-to-quote view link and prefers metafile:// attachments', () => {
  const sheet = formatMetawebPinDetail(SAMPLE_PIN);
  assert.match(sheet, new RegExp(`- view: \\[pin://${PIN}\\]\\(pin://${PIN}\\)`));
  assert.match(sheet, /- attachments: metafile:\/\/att1i0\.png/);
  assert.doesNotMatch(sheet, /file\.metaid\.io/);
  // metaapp path upgrades the view link scheme.
  const appSheet = formatMetawebPinDetail({ ...SAMPLE_PIN, path: '/protocols/metaapp', protocol: 'metaapp' });
  assert.match(appSheet, new RegExp(`- view: \\[metaapp://${PIN}\\]\\(metaapp://${PIN}\\)`));
});

function makeHarness(overrides = {}) {
  const calls = { search: [], readPin: [] };
  const metawebLearning = {
    search: async (input) => {
      calls.search.push(input);
      return overrides.searchResult ?? { items: [], hasMore: false };
    },
    readPin: async (pinId) => {
      calls.readPin.push(pinId);
      if (overrides.readPinError) throw overrides.readPinError;
      return overrides.pinResult ?? SAMPLE_PIN;
    },
  };
  const tools = buildMetawebLearningAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    metawebLearning,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('search_metaweb result embeds the citation rule and clickable URIs', async () => {
  const { byName } = makeHarness({ searchResult: { items: [SAMPLE_ITEM], hasMore: false } });
  const result = await byName.search_metaweb.handler({ query: 'auto-editor' });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.match(text, new RegExp(`\\[auto-editor 技能包\\]\\(pin://${PIN}\\)`));
  assert.match(text, /NEVER construct Web2 viewer URLs/);
});

test('read_metaweb_pin result appends the citation rule', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.read_metaweb_pin.handler({ pinId: PIN });
  assert.deepEqual(calls.readPin, [PIN]);
  const text = result.content[0].text;
  assert.match(text, new RegExp(`- view: \\[pin://${PIN}\\]\\(pin://${PIN}\\)`));
  assert.match(text, /NEVER construct Web2 viewer URLs/);
});
