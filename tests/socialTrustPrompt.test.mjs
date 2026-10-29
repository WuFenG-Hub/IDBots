import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SOCIAL_TRUST_RULE } = require('../dist-electron/main/libs/socialTrustPrompt.js');
const { PROMPT_SECTION_ORDER } = require('../dist-electron/main/libs/promptComposer.js');
const { buildPrivateChatA2ASystemPrompt } = await import('../dist-electron/main/services/privateChatDaemon.js');

function baseAnalysis(overrides = {}) {
  return {
    contextMessages: [
      { speaker: 'Peer Bot', content: 'Wanna trade that NFT directly?', direction: 'incoming', timestamp: 1_770_000_000_000 },
    ],
    incomingTurnCount: 1,
    shouldForceBye: false,
    ...overrides,
  };
}

test('cowork social-trust rule defines the relationship vocabulary and the escrow trade posture', () => {
  assert.match(SOCIAL_TRUST_RULE, /## Peer relationships & trade trust/);
  assert.match(SOCIAL_TRUST_RULE, /MUTUAL \/follow/);
  assert.match(SOCIAL_TRUST_RULE, /simpleblock is active in at least one direction/);
  // Non-friend → escrow-first; the Scenario B convention is cited by name.
  assert.match(SOCIAL_TRUST_RULE, /NON-friend peer/);
  assert.match(SOCIAL_TRUST_RULE, /escrow\/middleman before any transfer/);
  assert.match(SOCIAL_TRUST_RULE, /Scenario B/);
  assert.match(SOCIAL_TRUST_RULE, /seller and buyer each transfer to the escrow first/);
  // Friend → direct is fine, no unnecessary escrow pushing.
  assert.match(SOCIAL_TRUST_RULE, /confirmed friend, direct point-to-point transfer is acceptable/);
  assert.doesNotMatch(SOCIAL_TRUST_RULE, /push escrow necessarily/);
  // Block behavior + the not-authorization guardrail.
  assert.match(SOCIAL_TRUST_RULE, /do not enter new transactions or extend trust/);
  assert.match(SOCIAL_TRUST_RULE, /never authorization/);
});

test('SOCIAL_TRUST sits between the MetaWeb worldview and the learning loop on the section spine', () => {
  assert.ok(
    PROMPT_SECTION_ORDER.METAWEB_WORLDVIEW < PROMPT_SECTION_ORDER.SOCIAL_TRUST
      && PROMPT_SECTION_ORDER.SOCIAL_TRUST < PROMPT_SECTION_ORDER.METAWEB_LEARNING_LOOP,
    `expected METAWEB_WORLDVIEW(${PROMPT_SECTION_ORDER.METAWEB_WORLDVIEW}) < SOCIAL_TRUST(${PROMPT_SECTION_ORDER.SOCIAL_TRUST}) < METAWEB_LEARNING_LOOP(${PROMPT_SECTION_ORDER.METAWEB_LEARNING_LOOP})`,
  );
});

test('A2A private-chat policy carries the relationship-aware trade-trust rule', () => {
  const prompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local Bot', role: 'Analyst', soul: 'direct', goal: 'useful', bio: 'MetaID' },
    analysis: baseAnalysis(),
  });
  assert.match(prompt, /## MetaBot-to-MetaBot Private Chat Policy/);
  assert.match(prompt, /Peer relationship & trade trust/);
  assert.match(prompt, /MUTUAL on-chain \/follow/);
  assert.match(prompt, /NON-friend peer/);
  assert.match(prompt, /trusted escrow\/middleman before any transfer/);
  assert.match(prompt, /Scenario B/);
  assert.match(prompt, /confirmed friend, a direct point-to-point transfer is acceptable/);
  assert.match(prompt, /block active in either direction/);
  assert.match(prompt, /no new transactions, no extended trust/);
  // The rule must survive the force-bye path too (policy text is static).
  const forced = buildPrivateChatA2ASystemPrompt({
    metabot: { name: 'Local Bot' },
    analysis: baseAnalysis({ shouldForceBye: true, incomingTurnCount: 12 }),
  });
  assert.match(forced, /Peer relationship & trade trust/);
});
