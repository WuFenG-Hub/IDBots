import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('App wires Bot Browser callbacks into Bot Home entry surfaces', () => {
  const source = read('src/renderer/App.tsx');

  assert.match(source, /<GigSquareView\s+onOpenRemoteBotInBrowser=\{botBrowserShell\.openRemoteBot\}\s*\/>/);
  assert.match(source, /<MetaAppsView[\s\S]*onOpenMetaAppInBrowser=\{botBrowserShell\.openMetaApp\}/);
  assert.match(source, /<MetabotsView[\s\S]*onOpenMetabotInBrowser=\{botBrowserShell\.openLocalMetabot\}/);
});

test('Metabots prop chain keeps card edit click while adding avatar browser-open callback', () => {
  const viewSource = read('src/renderer/components/metabots/MetabotsView.tsx');
  const managerSource = read('src/renderer/components/metabots/MetabotsManager.tsx');
  const cardSource = read('src/renderer/components/metabots/MetaBotListCard.tsx');

  assert.match(viewSource, /onOpenMetabotInBrowser\?:\s*\(metabot:\s*Metabot\)\s*=>\s*void;/);
  assert.match(viewSource, /<MetabotsManager[\s\S]*onOpenMetabotInBrowser=\{onOpenMetabotInBrowser\}/);

  assert.match(managerSource, /onOpenMetabotInBrowser\?:\s*\(metabot:\s*Metabot\)\s*=>\s*void/);
  assert.match(managerSource, /<MetaBotListCard[\s\S]*onOpenMetabotInBrowser=\{onOpenMetabotInBrowser\}/);

  assert.match(cardSource, /onClick=\{onEdit\}/);
  assert.match(cardSource, /onOpenMetabotInBrowser\?:\s*\(metabot:\s*Metabot\)\s*=>\s*void;/);
  assert.match(cardSource, /title="Open in Bot Browser"/);
  assert.match(cardSource, /aria-label="Open in Bot Browser"/);
  assert.match(cardSource, /onClick=\{\(e\)\s*=>\s*\{[\s\S]*e\.stopPropagation\(\);[\s\S]*onOpenMetabotInBrowser\?\.?\(metabot\);[\s\S]*\}\}/);
});

test('GigSquare remote provider browser entry uses confirmed globalMetaId and separate provider button', () => {
  const viewSource = read('src/renderer/components/gigSquare/GigSquareView.tsx');
  const cardSource = read('src/renderer/components/gigSquare/GigSquareServiceCard.tsx');

  assert.match(viewSource, /onOpenRemoteBotInBrowser\?:/);
  assert.match(viewSource, /globalMetaId:\s*string;/);
  assert.match(viewSource, /name\?:\s*string;/);
  assert.match(viewSource, /avatar\?:\s*string;/);
  assert.match(viewSource, /const providerLookupId = providerGlobalMetaId \|\| service\.providerMetaId;/);
  assert.match(viewSource, /const providerGlobalMetaId = \(service\.providerGlobalMetaId \|\| ''\)\.trim\(\);/);
  assert.match(
    viewSource,
    /onOpenProviderInBrowser=\{providerGlobalMetaId\s*\?\s*\(\)\s*=>\s*onOpenRemoteBotInBrowser\?\.\(\{\s*globalMetaId:\s*providerGlobalMetaId,\s*name:\s*providerName,\s*avatar:\s*providerAvatarSrc,\s*\}\)\s*:\s*undefined\}/,
  );

  assert.match(cardSource, /onClick=\{onOpen\}/);
  assert.match(cardSource, /onOpenProviderInBrowser\?:\s*\(\)\s*=>\s*void;/);
  assert.match(cardSource, /disabled=\{!onOpenProviderInBrowser\}/);
  assert.match(cardSource, /onClick=\{\(event\)\s*=>\s*\{[\s\S]*event\.stopPropagation\(\);[\s\S]*onOpenProviderInBrowser\?\.?\(\);[\s\S]*\}\}/);

  const providerButtonStart = cardSource.indexOf('disabled={!onOpenProviderInBrowser}');
  const actionButtonStart = cardSource.indexOf('className="btn-idchat-primary-filled', providerButtonStart);
  assert.ok(providerButtonStart > 0, 'provider browser button should be present');
  assert.ok(actionButtonStart > providerButtonStart, 'service action button should follow provider button');
  const providerButtonSource = cardSource.slice(providerButtonStart, actionButtonStart);
  assert.match(providerButtonSource, /onKeyDown=\{\(event\)\s*=>\s*\{[\s\S]*event\.stopPropagation\(\);[\s\S]*\}\}/);
});

test('MetaApps run path tries Browser first and falls back to existing task launch', () => {
  const viewSource = read('src/renderer/components/metaapps/MetaAppsView.tsx');
  const managerSource = read('src/renderer/components/metaapps/MetaAppsManager.tsx');

  assert.match(viewSource, /onOpenMetaAppInBrowser\?:\s*\(app:\s*MetaAppRecord\)\s*=>\s*Promise<boolean>\s*\|\s*boolean;/);
  assert.match(viewSource, /<MetaAppsManager[\s\S]*onOpenMetaAppInBrowser=\{onOpenMetaAppInBrowser\}/);

  assert.match(managerSource, /onOpenMetaAppInBrowser\?:\s*\(app:\s*MetaAppRecord\)\s*=>\s*Promise<boolean>\s*\|\s*boolean;/);
  assert.match(
    managerSource,
    /const openedInBrowser = onOpenMetaAppInBrowser \?\s*await onOpenMetaAppInBrowser\(app\)\s*:\s*false;/,
  );
  assert.match(managerSource, /if \(openedInBrowser\) \{\s*return;\s*\}/);
  assert.match(managerSource, /await onStartTaskWithMetaApp\(app\);/);
});

test('MetaApp Browser hook only reports unsupported MetaApps and leaves fallback to manager', () => {
  const appSource = read('src/renderer/App.tsx');
  const shellSource = read('src/renderer/features/botBrowser/useBotBrowserShell.ts');

  assert.doesNotMatch(appSource, /fallbackOpenMetaApp/);
  assert.doesNotMatch(shellSource, /fallbackOpenMetaApp/);
  assert.match(shellSource, /if \(!canOpenMetaAppInBrowser\(app\)\) \{\s*return false;\s*\}/);
  assert.match(shellSource, /if \(!uri\) \{\s*return false;\s*\}/);
});
