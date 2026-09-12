import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(
  new URL('../src/main/services/metaFileUploadService.ts', import.meta.url),
  'utf8',
);

// 2026-09-12 routing unification: the dedicated MVC sponsor direct upload
// must only run when the global traffic.mode is 'traffic' (account quota).
// In 'selfpay' mode the upload goes straight to the bot-wallet createPin
// path, so the settings-panel toggle governs every on-chain write.
test('sponsor direct upload is gated on the global traffic.mode setting', () => {
  assert.match(
    source,
    /import \{ getConfiguredTrafficApiBase, getConfiguredTrafficPinMode \} from '\.\/trafficAccountService';/,
    'metaFileUploadService must import the global traffic mode reader',
  );
  assert.match(
    source,
    /const sponsorUploadAllowed = getConfiguredTrafficPinMode\(\) === 'traffic';/,
    'the sponsor upload gate must read the global traffic.mode setting',
  );
  const gateSectionStart = source.indexOf('const sponsorUploadAllowed');
  assert.notEqual(gateSectionStart, -1);
  const gateSection = source.slice(gateSectionStart, gateSectionStart + 400);
  assert.match(
    gateSection,
    /if \(network === 'mvc' && !useData && metabot && sponsorUploadAllowed && isMvcSponsorUploadEnabled/,
    'the sponsor upload branch must require sponsorUploadAllowed',
  );
});

test('buffer-based direct uploads still route through the unified createPin gateway', () => {
  // The selfPaidDirect helper (used for buffer uploads, for self-pay mode,
  // and as the sponsor fallback) must keep calling createPin — the unified
  // billing gateway that honors traffic.mode.
  const helperStart = source.indexOf('const selfPaidDirect = async');
  assert.notEqual(helperStart, -1, 'missing selfPaidDirect helper');
  const helperSection = source.slice(helperStart, helperStart + 1200);
  assert.match(helperSection, /await createPin\(/);
});
