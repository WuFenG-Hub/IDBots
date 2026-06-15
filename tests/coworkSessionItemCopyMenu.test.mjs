import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const itemSource = readFileSync(
  new URL('../src/renderer/components/cowork/CoworkSessionItem.tsx', import.meta.url),
  'utf8',
);
const i18nSource = readFileSync(
  new URL('../src/renderer/services/i18n.ts', import.meta.url),
  'utf8',
);

test('CoworkSessionItem wires a copy session id menu action', () => {
  assert.match(
    itemSource,
    /import\s+\{[^}]*copyCoworkSessionLinkToClipboard[^}]*\}\s+from\s+['"]\.\/coworkSessionLink\.js['"]/s,
  );
  assert.match(itemSource, /\bcopyCoworkSessionLinkToClipboard\b/);
  assert.match(itemSource, /\bi18nService\.t\(['"]coworkCopySessionId['"]\)/);
  assert.match(
    itemSource,
    /import\s+\{[^}]*ClipboardDocumentIcon[^}]*\}\s+from\s+['"]@heroicons\/react\/24\/outline['"]/s,
  );
  assert.match(itemSource, /\bClipboardDocumentIcon\b/);
  assert.match(itemSource, /key:\s*['"]copy-session-id['"]/);
});

test('i18n defines the copy session id label in Chinese and English', () => {
  assert.match(i18nSource, /coworkCopySessionId:\s*['"]复制Session ID['"]/);
  assert.match(i18nSource, /coworkCopySessionId:\s*['"]Copy Session ID['"]/);
});
