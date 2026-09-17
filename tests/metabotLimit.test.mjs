import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const limitPath = path.join(projectRoot, 'src', 'main', 'shared', 'metabotLimit.ts');
const managerPath = path.join(projectRoot, 'src', 'renderer', 'components', 'metabots', 'MetabotsManager.tsx');
const mainPath = path.join(projectRoot, 'src', 'main', 'main.ts');

test('MetaBot creation limit is shared at 100 across renderer and main create paths', () => {
  assert.ok(fs.existsSync(limitPath), 'shared metabot limit module should exist');

  const limitSource = fs.readFileSync(limitPath, 'utf8');
  assert.match(limitSource, /DEFAULT_METABOT_LIMIT\s*=\s*100/);
  assert.match(limitSource, /METABOT_LIMIT_REACHED_ERROR/);

  const managerSource = fs.readFileSync(managerPath, 'utf8');
  assert.match(managerSource, /DEFAULT_METABOT_LIMIT/);
  assert.doesNotMatch(managerSource, /METABOT_LIMIT\s*=\s*10/);

  const mainSource = fs.readFileSync(mainPath, 'utf8');
  const manageServicePath = path.join(projectRoot, 'src', 'main', 'services', 'metabotManageService.ts');
  const manageServiceSource = fs.readFileSync(manageServicePath, 'utf8');
  // The on-chain create IPC path was extracted into createMetaBotOnChainCore
  // (refactor a5377040), so its guard call lives in metabotManageService.ts;
  // main.ts keeps the direct guards on the mock/dev, wallet-create, and
  // restore-mnemonic paths.
  const guardCalls =
    (mainSource.match(/assertCanCreateMetabot\(store\)/g) ?? []).length +
    (manageServiceSource.match(/assertCanCreateMetabot\(store\)/g) ?? []).length;
  assert.ok(
    guardCalls >= 4,
    'main create/restore IPC paths should enforce the shared MetaBot limit',
  );
});
