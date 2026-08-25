import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(projectRoot, rel), 'utf8');

test('host pins workspaceInstructions.dshHome to a controlled userData dir', () => {
  // The runtime config must carry the instruction-discovery controls whenever
  // a workspace is mounted, pinning the user-global AGENTS.md home under
  // userData so ~/.dsh (left over from another harness) never leaks in.
  const source = read('src/main/libs/coworkDshTurn.ts');
  assert.match(source, /workspaceInstructions: \{ dshHome: join\(app\.getPath\('userData'\), 'dsh-home'\) \}/);
  assert.match(source, /slot\.workspaceSeen \?\? input\.workspace/);
});

test('DshRuntimeConfigInput declares the workspaceInstructions controls', () => {
  const source = read('src/main/libs/dshKernel/types.ts');
  assert.match(source, /workspaceInstructions\?: \{ maxBytes\?: number; dshHome\?: string \}/);
});

test('git branch probe timeout stays below the 3s poll interval', () => {
  // A hung git probe must settle before the next poll fires, or probes pile
  // up faster than they finish.
  const source = read('src/main/libs/gitWorkspace.ts');
  assert.match(source, /const GIT_PROBE_TIMEOUT_MS = 2000;/);
  assert.match(source, /timeout: GIT_PROBE_TIMEOUT_MS/);
});

test('folder selector popover shows the ancestor-discovery hint', () => {
  // Product decision: ancestor discovery is intentional; users must see that
  // sessions follow conventions from the folder AND its parent git repos
  // (including symlinked files).
  const popover = read('src/renderer/components/cowork/FolderSelectorPopover.tsx');
  assert.match(popover, /workspaceInstructionsHint/);
  assert.match(popover, /its ancestor git repositories/);
  assert.match(popover, /symlinked files/);
  const i18n = read('src/renderer/services/i18n.ts');
  assert.match(i18n, /workspaceInstructionsHint: 'Sessions follow AGENTS\.md \/ CLAUDE\.md conventions from this folder, its parent Git repos, and symlinked files'/);
  assert.match(i18n, /workspaceInstructionsHint: '会话将遵循所选目录、其上级 Git 仓库及符号链接指向文件中的 AGENTS\.md \/ CLAUDE\.md 约定'/);
});

test('CLAUDE.md documents the boundary and the disabled user-global home', () => {
  const doc = read('CLAUDE.md');
  assert.match(doc, /Boundary \(product decision\): ancestor discovery is intentional/);
  assert.match(doc, /dsh-home/);
  assert.match(doc, /never enters IDBots sessions/);
});
