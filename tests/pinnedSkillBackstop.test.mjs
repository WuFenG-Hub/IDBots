import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative) => readFileSync(join(here, relative), 'utf8');

const mainSource = readSource('../src/main/main.ts');
const skillManagerSource = readSource('../src/main/skillManager.ts');
const submissionSource = readSource('../src/main/services/coworkTurnSubmission.ts');
const skillsPopoverSource = readSource('../src/renderer/components/skills/SkillsPopover.tsx');
const folderPopoverSource = readSource('../src/renderer/components/cowork/FolderSelectorPopover.tsx');

test('SkillManager exposes the pinned-skill filter over the per-bot visible set', () => {
  assert.ok(
    skillManagerSource.includes('filterSkillIdsForMetabotView(skillIds: readonly string[], metabotId: number | null)'),
    'filter method must exist with the (ids, metabotId|null) contract',
  );
  assert.match(
    skillManagerSource,
    /filterSkillIdsForMetabotView[\s\S]*?listSkillsForMetabot\(metabotId\)/,
    'the filter must delegate to listSkillsForMetabot (null → bundled+global, never an empty set)',
  );
});

test('cowork session:start/continue sanitize renderer-supplied pinned skills at the IPC boundary', () => {
  assert.ok(
    mainSource.includes('function sanitizePinnedSkillIds('),
    'main.ts must define the boundary sanitizer',
  );
  assert.match(
    mainSource,
    /filterSkillIdsForMetabotView\(skillIds, metabotId\)/,
    'the sanitizer must intersect via SkillManager.filterSkillIdsForMetabotView',
  );
  const startBranch = mainSource.slice(mainSource.indexOf("'cowork:session:start'"));
  assert.ok(
    startBranch.includes("sanitizePinnedSkillIds(\n        options.activeSkillIds,\n        options.metabotId ?? null,"),
    'session:start must sanitize with the starting bot binding',
  );
  assert.ok(
    startBranch.includes('sanitizedSkillIds,\n        options.metabotId ?? null'),
    'createSession must receive the sanitized ids',
  );
  assert.ok(
    startBranch.includes('skillIds: sanitizedSkillIds'),
    'runner.startSession must receive the sanitized ids',
  );
  const continueBranch = mainSource.slice(mainSource.indexOf("'cowork:session:continue'"));
  assert.ok(
    continueBranch.includes('sanitizePinnedSkillIds('),
    'session:continue must sanitize with the session bot binding',
  );
  assert.match(
    continueBranch,
    /skillIds: sanitizedSkillIds/,
    'continueSession must receive the sanitized ids',
  );
});

test('submitInput chokepoint sanitizes via an injected dependency (undefined stays undefined)', () => {
  assert.ok(
    submissionSource.includes('sanitizeSkillIds?: (skillIds: string[] | undefined, metabotId: number | null) => string[] | undefined'),
    'the controller dependency must keep the undefined "no pins this turn" signal',
  );
  assert.match(
    submissionSource,
    /this\.sanitizeSkillIds\(input\.activeSkillIds, currentSession\.metabotId \?\? null\)/,
    'the controller must call the sanitizer with the session bot binding',
  );
  assert.ok(
    mainSource.includes("sanitizePinnedSkillIds(skillIds, metabotId, 'cowork:session:submitInput')"),
    'main.ts must wire the sanitizer into the submitInput controller',
  );
});

test('sidebar popovers re-place when their anchor moves', () => {
  assert.ok(
    skillsPopoverSource.includes('useAnchorMoveWatcher(anchorRef, isOpen, updatePlacement)'),
    'SkillsPopover must watch its anchor',
  );
  assert.ok(
    folderPopoverSource.includes('useAnchorMoveWatcher(anchorRef, isOpen, updatePlacement)'),
    'FolderSelectorPopover must watch its anchor',
  );
});
