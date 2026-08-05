import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SkillManager } = require('../dist-electron/main/skillManager.js');

const BUILTIN_SKILLS_ROOT = path.resolve(process.cwd(), 'SKILLs');

class MemoryStore {
  constructor(initial = {}) {
    this.values = { ...initial };
  }

  get(key) {
    return this.values[key];
  }

  set(key, value) {
    this.values[key] = value;
  }
}

function createManager() {
  const store = new MemoryStore();
  return new SkillManager(() => store);
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(root, relative, content) {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function buildSkillPair() {
  const bundled = makeTempDir('idbots-skill-bundled-');
  const local = makeTempDir('idbots-skill-local-');
  const files = {
    'SKILL.md': '---\nname: metabot-demo\nofficial: true\n---\n\n# Demo\n',
    'scripts/index.js': 'console.log("v1");\n',
    'references/notes.md': '# notes\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    writeFile(bundled, relative, content);
    writeFile(local, relative, content);
  }
  return { bundled, local };
}

test('isSkillContentDifferent returns false for identical directories', () => {
  const manager = createManager();
  const { bundled, local } = buildSkillPair();

  assert.equal(manager.isSkillContentDifferent(bundled, local), false);
});

test('isSkillContentDifferent tolerates CRLF drift in SKILL.md only', () => {
  const manager = createManager();
  const { bundled, local } = buildSkillPair();
  writeFile(local, 'SKILL.md', '---\r\nname: metabot-demo\r\nofficial: true\r\n---\r\n\r\n# Demo\r\n');

  assert.equal(manager.isSkillContentDifferent(bundled, local), false);
});

test('isSkillContentDifferent detects script-only changes (SKILL.md unchanged)', () => {
  const manager = createManager();
  const { bundled, local } = buildSkillPair();
  writeFile(local, 'scripts/index.js', 'console.log("v0-old");\n');

  assert.equal(manager.isSkillContentDifferent(bundled, local), true);
});

test('isSkillContentDifferent detects files missing from the local copy', () => {
  const manager = createManager();
  const { bundled, local } = buildSkillPair();
  fs.rmSync(path.join(local, 'references', 'notes.md'));

  assert.equal(manager.isSkillContentDifferent(bundled, local), true);
});

test('isSkillContentDifferent detects extra files in the local copy', () => {
  const manager = createManager();
  const { bundled, local } = buildSkillPair();
  writeFile(local, 'scripts/obsolete.js', '// removed from bundle\n');

  assert.equal(manager.isSkillContentDifferent(bundled, local), true);
});

test('isSkillContentDifferent ignores OS noise files like .DS_Store', () => {
  const manager = createManager();
  const { bundled, local } = buildSkillPair();
  writeFile(local, '.DS_Store', 'junk');
  writeFile(local, 'scripts/.DS_Store', 'junk');

  assert.equal(manager.isSkillContentDifferent(bundled, local), false);
});

test('every bundled metabot-* skill is marked official so force-sync applies', () => {
  const entries = fs.readdirSync(BUILTIN_SKILLS_ROOT, { withFileTypes: true });
  const metabotDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('metabot-'))
    .map((entry) => entry.name);
  assert.ok(metabotDirs.length > 0, 'expected bundled metabot-* skills to exist');

  const missing = metabotDirs.filter((name) => {
    const skillFile = path.join(BUILTIN_SKILLS_ROOT, name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) return true;
    const raw = fs.readFileSync(skillFile, 'utf8');
    return !/^official:\s*true\s*$/m.test(raw);
  });
  assert.deepEqual(missing, []);
});

test('retireLegacySkillsFromUserData removes the legacy metabot-upload-largefile skill', () => {
  const manager = createManager();
  const userRoot = makeTempDir('idbots-skill-user-');
  writeFile(userRoot, 'metabot-upload-largefile/SKILL.md', '---\nname: metabot-upload-largefile\n---\n');
  writeFile(userRoot, 'metabot-upload-file/SKILL.md', '---\nname: metabot-upload-file\n---\n');
  writeFile(
    userRoot,
    'skills.config.json',
    JSON.stringify(
      {
        defaults: {
          'metabot-upload-largefile': { order: 16, version: '1.0.1', enabled: true },
          'metabot-upload-file': { order: 16, version: '1.1.0', enabled: true },
        },
      },
      null,
      2,
    ),
  );

  manager.retireLegacySkillsFromUserData(userRoot);

  assert.equal(fs.existsSync(path.join(userRoot, 'metabot-upload-largefile')), false);
  assert.equal(fs.existsSync(path.join(userRoot, 'metabot-upload-file')), true);
  const config = JSON.parse(fs.readFileSync(path.join(userRoot, 'skills.config.json'), 'utf8'));
  assert.equal('metabot-upload-largefile' in config.defaults, false);
  assert.equal('metabot-upload-file' in config.defaults, true);
});
