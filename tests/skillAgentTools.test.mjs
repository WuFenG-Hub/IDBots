import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildSkillAgentTools } = require('../dist-electron/main/libs/skillAgentTools.js');

function makeHarness(overrides = {}) {
  const calls = { extract: [], install: [], list: [], read: [] };
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
    installSkill: async (input, perspective) => {
      calls.install.push({ input, perspective });
      return overrides.installResult ?? {
        ok: true,
        name: 'video-maker',
        version: '1.0.0',
        dest: '/SKILLs/video-maker',
        skillId: 'video-maker',
        assignedToMetabotId: perspective.metabotId,
      };
    },
    listInstalledSkills: (perspective) => {
      calls.list.push(perspective);
      return overrides.listResult ?? [
        { id: 'official-core', name: 'Official Core', origin: 'bundled' },
        { id: 'video-maker', name: 'Video Maker', origin: 'assigned' },
      ];
    },
    readSkill: (nameOrId, perspective) => {
      calls.read.push({ nameOrId, perspective });
      return overrides.readResult ??
        { id: 'video-maker', name: 'Video Maker', directory: '/SKILLs/video-maker', skillPath: '/SKILLs/video-maker/SKILL.md', content: '# Video Maker' };
    },
  };
  const tools = buildSkillAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
    getWorkspaceDir: () => '/workspace',
    // Explicit null (bot-less session) must survive — `?? 42` would swallow it.
    getMetabotId: () => (Object.prototype.hasOwnProperty.call(overrides, 'metabotId') ? overrides.metabotId : 42),
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

const textOf = (result) => result.content[0].text;

test('registers skill_tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.skill_tool);
});

test('list_installed_skills shows the caller view with origin markers', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.skill_tool.handler({ action: 'list_installed_skills' });
  assert.equal(calls.list.length, 1);
  assert.deepEqual(calls.list[0], { metabotId: 42 });
  assert.match(textOf(res), /Official Core \(official-core, bundled\)/);
  assert.match(textOf(res), /Video Maker \(video-maker, assigned\)/);
});

test('read_skill passes the session perspective to the control', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.skill_tool.handler({ action: 'read_skill', name: 'video-maker' });
  assert.deepEqual(calls.read[0], { nameOrId: 'video-maker', perspective: { metabotId: 42 } });
  assert.match(textOf(res), /# Video Maker/);
  assert.match(textOf(res), /Skill directory: \/SKILLs\/video-maker/);
});

test('read_skill requires name', async () => {
  const { byName } = makeHarness();
  const res = await byName.skill_tool.handler({ action: 'read_skill' });
  assert.equal(res.isError, true);
});

test('bot-less sessions get a null-metabotId perspective', async () => {
  const { byName, calls } = makeHarness({ metabotId: null });
  await byName.skill_tool.handler({ action: 'list_installed_skills' });
  await byName.skill_tool.handler({ action: 'read_skill', name: 'video-maker' });
  await byName.skill_tool.handler({ action: 'install_skill', github: 'acme/video' });
  assert.deepEqual(calls.list[0], { metabotId: null });
  assert.deepEqual(calls.read[0].perspective, { metabotId: null });
  assert.deepEqual(calls.install[0].perspective, { metabotId: null });
});

test('extract_metaapp requires pinId and returns JSON', async () => {
  const { byName, calls } = makeHarness();
  const missing = await byName.skill_tool.handler({ action: 'extract_metaapp' });
  assert.equal(missing.isError, true);
  const res = await byName.skill_tool.handler({ action: 'extract_metaapp', pinId: 'metaapp://abc' });
  assert.deepEqual(calls.extract[0], { pinId: 'metaapp://abc', workspaceDir: '/workspace' });
  assert.match(textOf(res), /Install from github/);
});

test('install_skill forwards a single source with the session perspective', async () => {
  const { byName, calls } = makeHarness();
  const res = await byName.skill_tool.handler({ action: 'install_skill', github: 'acme/video' });
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.install[0].input, { zip: undefined, github: 'acme/video', 'skills.sh': undefined, npm: undefined });
  assert.deepEqual(calls.install[0].perspective, { metabotId: 42 });
  assert.match(textOf(res), /"ok": true/);
  assert.match(textOf(res), /"assignedToMetabotId": 42/);
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
