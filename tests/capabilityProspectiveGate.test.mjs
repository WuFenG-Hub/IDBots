import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCapabilityValidationPrompt } = require('../dist-electron/main/libs/capabilityValidationPrompt.js');

test('prospective rule lines ride the prompt only when requested', () => {
  const base = {
    botName: '小火',
    date: '2026-08-03',
    drafts: [
      { id: 7, dreamDate: '2026-08-02', title: '先验证再交付', description: '交付前自检', capabilityType: 'workflow' },
    ],
    recentSummaries: [{ summaryDate: '2026-08-03', summaryText: '交付后用户点赞' }],
  };
  const prospective = buildCapabilityValidationPrompt({ ...base, prospective: true });
  assert.ok(prospective.system.includes('独立证据规则'));
  assert.ok(prospective.user.includes('较晚日记的日期'));

  const legacy = buildCapabilityValidationPrompt(base);
  assert.ok(!legacy.system.includes('独立证据规则'), 'old callers keep the unchanged prompt');
  assert.ok(!legacy.user.includes('较晚日记的日期'), 'old callers keep the unchanged prompt');
});

test('similar falsified hypotheses render per draft plus the judging rule', () => {
  const withFalsified = buildCapabilityValidationPrompt({
    botName: '小火',
    date: '2026-08-03',
    drafts: [
      {
        id: 7,
        dreamDate: '2026-08-02',
        title: '先验证再交付',
        description: '交付前自检',
        capabilityType: 'workflow',
        similarFalsified: { title: '先验证再交付', reason: '照做后被差评', falsifiedDate: '2026-07-20' },
      },
    ],
    recentSummaries: [{ summaryDate: '2026-08-03', summaryText: '交付后用户点赞' }],
    prospective: true,
  });
  assert.ok(withFalsified.user.includes('曾被证伪的相似做法:「先验证再交付」(2026-07-20 否决:照做后被差评)'));
  assert.ok(withFalsified.user.includes('标注了「曾被证伪的相似做法」的草案:除非日记里出现了那次否决日期之后的新证据,否则不得判 validated。'));

  const withoutFalsified = buildCapabilityValidationPrompt({
    botName: '小火',
    date: '2026-08-03',
    drafts: [
      { id: 7, dreamDate: '2026-08-02', title: '先验证再交付', description: '交付前自检', capabilityType: 'workflow' },
    ],
    recentSummaries: [{ summaryDate: '2026-08-03', summaryText: '交付后用户点赞' }],
    prospective: true,
  });
  assert.ok(!withoutFalsified.user.includes('曾被证伪的相似做法'));
  assert.ok(!withoutFalsified.user.includes('标注了「曾被证伪的相似做法」'));
});
