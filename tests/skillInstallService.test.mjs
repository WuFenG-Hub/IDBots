import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const {
  MAX_SKILL_PACKAGE_BYTES,
  INVALID_SKILL_PACKAGE_MESSAGE,
  NOT_A_ZIP_REASON,
  extractMetaApp,
  installSkill,
  listInstalledSkills,
  findSkillRoot,
  extractTarBuffer,
  extractTarGzBuffer,
} = require('../dist-electron/main/services/skillInstallService.js');
const { isZipPayload, extractMetafilePinId } = require('../dist-electron/main/libs/metafileDownload.js');

const PIN_ID = `${'a'.repeat(64)}i0`;

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeSkillMd(dir, name, version = '1.0.0') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    `description: ${name} skill`,
    `version: ${version}`,
    '---',
    '',
    `# ${name}`,
    '',
    'Do the thing.',
    '',
  ].join('\n'));
}

function zipSkill(name, version = '1.0.0', extraFiles = {}) {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from([
    '---',
    `name: ${name}`,
    `description: ${name} skill`,
    `version: ${version}`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n')));
  for (const [fileName, content] of Object.entries(extraFiles)) {
    zip.addFile(fileName, Buffer.from(content));
  }
  return zip.toBuffer();
}

function zipMetaApp({ withAppMd = true, wrap = false } = {}) {
  const zip = new AdmZip();
  const prefix = wrap ? 'app/' : '';
  zip.addFile(`${prefix}index.html`, Buffer.from('<html></html>'));
  if (withAppMd) {
    zip.addFile(`${prefix}APP.md`, Buffer.from('Install from github: example/video-skill\n'));
  }
  return zip.toBuffer();
}

function makeTar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    header.write(entry.name, 0);
    const content = Buffer.from(entry.content);
    const sizeOctal = content.length.toString(8).padStart(11, '0');
    header.write(`${sizeOctal}\0`, 124, 12, 'utf8');
    header.write(entry.dir ? '5' : '0', 156, 1, 'utf8');
    blocks.push(header);
    if (!entry.dir) {
      blocks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('extractMetafilePinId strips scheme and optional extension', () => {
  assert.equal(extractMetafilePinId(`metafile://${PIN_ID}.zip`), PIN_ID);
  assert.equal(extractMetafilePinId(`metafile://${PIN_ID}`), PIN_ID);
  assert.equal(extractMetafilePinId(PIN_ID), PIN_ID);
});

test('isZipPayload uses contentType or PK magic, not a .zip suffix', () => {
  const pk = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
  assert.equal(isZipPayload(pk, 'text/plain'), true);
  assert.equal(isZipPayload(Buffer.from('not-zip'), 'application/zip'), true);
  assert.equal(isZipPayload(Buffer.from('not-zip'), 'text/html'), false);
});

test('findSkillRoot accepts a wrapping folder with SKILL.md', () => {
  const root = makeTempDir('idbots-skill-root-');
  writeSkillMd(path.join(root, 'pkg'), 'demo-skill');
  assert.equal(findSkillRoot(root), path.join(root, 'pkg'));
  assert.equal(findSkillRoot(path.join(root, 'pkg')), path.join(root, 'pkg'));
});

test('extractMetaApp returns not-a-zip when the payload is not a zip', async () => {
  const workspace = makeTempDir('idbots-extract-ws-');
  const result = await extractMetaApp(PIN_ID, {
    fetchPin: async () => ({
      contentSummary: JSON.stringify({ content: `metafile://${PIN_ID}`, contentType: 'text/html' }),
    }),
    downloadBytes: async () => ({ buffer: Buffer.from('<html>nope</html>'), contentType: 'text/html' }),
    getSkillsRoot: () => workspace,
    workspaceDir: workspace,
  });
  assert.deepEqual(result, { ok: false, reason: NOT_A_ZIP_REASON });
});

test('extractMetaApp unpacks APP.md even when the content ref has no .zip suffix', async () => {
  const workspace = makeTempDir('idbots-extract-ws-');
  const buffer = zipMetaApp({ withAppMd: true, wrap: true });
  const result = await extractMetaApp(`metaapp://${PIN_ID}`, {
    fetchPin: async () => ({
      contentType: 'application/zip',
      contentSummary: JSON.stringify({ content: `metafile://${PIN_ID}`, contentType: 'application/zip' }),
    }),
    downloadBytes: async () => ({ buffer, contentType: 'application/zip' }),
    getSkillsRoot: () => workspace,
    workspaceDir: workspace,
  });
  assert.equal(result.ok, true);
  assert.match(result.appMd, /Install from github/);
  assert.ok(result.files.some((file) => file.endsWith('APP.md')));
  assert.ok(result.extractedDir.includes(PIN_ID));
});

test('installSkill from a local zip uses SKILL.md name as the directory', async () => {
  const skillsRoot = makeTempDir('idbots-skills-root-');
  const zipPath = path.join(makeTempDir('idbots-skill-zip-'), 'pack.zip');
  fs.writeFileSync(zipPath, zipSkill('video-maker', '2.1.0', { 'scripts/run.js': 'console.log(1)' }));
  let reloaded = 0;
  const result = await installSkill({ zip: zipPath }, {
    fetchPin: async () => ({}),
    getSkillsRoot: () => skillsRoot,
    reloadSkills: () => { reloaded += 1; },
    workspaceDir: skillsRoot,
  });
  assert.equal(result.ok, true);
  assert.equal(result.name, 'video-maker');
  assert.equal(result.version, '2.1.0');
  assert.equal(reloaded, 1);
  assert.equal(fs.existsSync(path.join(skillsRoot, 'video-maker', 'SKILL.md')), true);
  const listed = listInstalledSkills({ getSkillsRoot: () => skillsRoot });
  assert.deepEqual(listed, [{ name: 'video-maker', version: '2.1.0' }]);
});

test('installSkill rejects a zip without SKILL.md', async () => {
  const skillsRoot = makeTempDir('idbots-skills-root-');
  const zip = new AdmZip();
  zip.addFile('README.md', Buffer.from('no skill here'));
  const zipPath = path.join(makeTempDir('idbots-skill-zip-'), 'bad.zip');
  fs.writeFileSync(zipPath, zip.toBuffer());
  const result = await installSkill({ zip: zipPath }, {
    fetchPin: async () => ({}),
    getSkillsRoot: () => skillsRoot,
    workspaceDir: skillsRoot,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, INVALID_SKILL_PACKAGE_MESSAGE);
});

test('installSkill rejects packages over 4MB', async () => {
  const skillsRoot = makeTempDir('idbots-skills-root-');
  const result = await installSkill({ zip: 'metafile://big' }, {
    fetchPin: async () => ({}),
    downloadBytes: async () => ({
      buffer: Buffer.alloc(MAX_SKILL_PACKAGE_BYTES + 1, 1),
      contentType: 'application/zip',
    }),
    getSkillsRoot: () => skillsRoot,
    workspaceDir: skillsRoot,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /4MB/);
});

test('installSkill requires exactly one source', async () => {
  const skillsRoot = makeTempDir('idbots-skills-root-');
  const none = await installSkill({}, {
    fetchPin: async () => ({}),
    getSkillsRoot: () => skillsRoot,
    workspaceDir: skillsRoot,
  });
  assert.equal(none.ok, false);
  const both = await installSkill({ zip: 'a.zip', github: 'o/r' }, {
    fetchPin: async () => ({}),
    getSkillsRoot: () => skillsRoot,
    workspaceDir: skillsRoot,
  });
  assert.equal(both.ok, false);
});

test('installSkill from github downloads the archive via injected fetch', async () => {
  const skillsRoot = makeTempDir('idbots-skills-root-');
  const buffer = zipSkill('gh-skill', '0.4.0');
  const result = await installSkill({ github: 'acme/video-tools' }, {
    fetchPin: async () => ({}),
    downloadBytes: async (url) => {
      assert.match(url, /github\.com\/acme\/video-tools|api\.github\.com\/repos\/acme\/video-tools/);
      return { buffer, contentType: 'application/zip' };
    },
    getSkillsRoot: () => skillsRoot,
    workspaceDir: skillsRoot,
  });
  assert.equal(result.ok, true);
  assert.equal(result.name, 'gh-skill');
});

test('extractTarGzBuffer unpacks an npm-style package/ SKILL.md', () => {
  const dest = makeTempDir('idbots-tar-');
  const tar = makeTar([
    { name: 'package/', dir: true, content: '' },
    { name: 'package/SKILL.md', content: '---\nname: npm-skill\nversion: 3.0.0\n---\n' },
  ]);
  extractTarGzBuffer(zlib.gzipSync(tar), dest);
  assert.equal(fs.existsSync(path.join(dest, 'package', 'SKILL.md')), true);
  extractTarBuffer(tar, dest);
  assert.equal(findSkillRoot(dest), path.join(dest, 'package'));
});
