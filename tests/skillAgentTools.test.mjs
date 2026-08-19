import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildSkillAgentTools } = require('../dist-electron/main/libs/skillAgentTools.js');

function makeHarness(overrides = {}) {
  const calls = { extract: [], install: [], list: 0 };
  const control = {
    extractMetaApp: async (input) => {
      calls.extract.push(input);
      return overrides.extractResult ?? {
        ok: true,
        files: ['APP.md', 'index.html'],
        appMd: 'Install from github: acme/video',
        extractedDir: '/tmp/extract',
      };
    },
    installSkill: async (input) => {
      calls.install.push(input);
      return overrides.installResult ?? { ok: true, name: 'video-maker', version: '1.0.0', dest: '/SKILLs/video-maker' };
    },
    listInstalledSkills: () => {
      calls.list += 1;
      return overrides.listResult ?? [{ name: 'video-maker', version: '1.0.0' }];
    },
  };
  const tools = buildSkillAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
    getWorkspaceDir: () => '/workspace',
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

const textOf = (result) => result.content[0].text;

test('registers skill_tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.skill_tool);
});

test('list_installed_skills returns name + version', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.skill_tool.handler({ action: 'list_installed_skills' });
  assert.equal(calls.list, 1);
  assert.match(textOf(res), /video-maker \(1\.0\.0\)/);
});

test('extract_metaapp requires pinId and returns JSON', async () => {
  const { byName, calls } = makeHarness();
  const missing = await byName.skill_tool.handler({ action: 'extract_metaapp' });
  assert.equal(missing.isError, true);
  const res = await byName.skill_tool.handler({ action: 'extract_metaapp', pinId: 'metaapp://abc' });
  assert.deepEqual(calls.extract[0], { pinId: 'metaapp://abc', workspaceDir: '/workspace' });
  assert.match(textOf(res), /Install from github/);
});

test('install_skill forwards a single source and does not ask for confirmation', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.skill_tool.handler({ action: 'install_skill', github: 'acme/video' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.install[0], { zip: undefined, github: 'acme/video', 'skills.sh': undefined, npm: undefined });
  assert.match(textOf(res), /"ok": true/);
  assert.doesNotMatch(byName.skill_tool.description, /AskUserQuestion|confirm/i);
});

test('install_skill surfaces a failure as isError', async () => {
  const { byName } = makeHarness({
    installResult: { ok: false, error: 'not a valid skill package' },
  });
  const res = await byName.skill_tool.handler({ action: 'install_skill', zip: '/tmp/x.zip' });
  assert.equal(res.isError, true);
  assert.match(textOf(res), /not a valid skill package/);
});
