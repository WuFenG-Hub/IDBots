import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOrderPrompts } from '../src/main/services/orderPromptBuilder';

test('buildOrderPrompts adds media delivery constraints for image outputs', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] 请生成火箭发射图片。',
      '<raw_request>',
      '请生成火箭发射图片。',
      '</raw_request>',
      '支付金额 0.001 SPACE',
      `txid: ${'f'.repeat(64)}`,
      'service id: svc-image',
      'skill name: seedream',
      'output type: image',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    skillName: 'seedream',
    expectedOutputType: 'image',
  });

  assert.match(prompts.systemPrompt, /Expected output type:\s*image/i);
  assert.match(prompts.systemPrompt, /50MB/);
  assert.match(prompts.systemPrompt, /local file path/i);
  assert.match(prompts.systemPrompt, /do not claim success/i);
  assert.match(prompts.systemPrompt, /Do not stop after saying/i);
  assert.match(prompts.systemPrompt, /run the required skill/i);
  assert.match(prompts.systemPrompt, /same language as the client's original request/i);
});

test('buildOrderPrompts asks video providers to safely rewrite risky prompts without enumerating examples', () => {
  const rawRequest = '请按这个需求生成短视频：把这段需求原样用于视频生成。';
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] 请生成短视频。',
      '<raw_request>',
      rawRequest,
      '</raw_request>',
      `txid: ${'b'.repeat(64)}`,
      'service id: svc-video',
      'skill name: seedance',
      'output type: video',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    skillName: 'seedance',
    expectedOutputType: 'video',
  });

  assert.match(prompts.systemPrompt, /Expected output type:\s*video/i);
  assert.match(prompts.systemPrompt, /敏感|sensitive/i);
  assert.match(prompts.systemPrompt, /改写|rewrite/i);
  assert.match(prompts.systemPrompt, /Original client prompt/i);
  assert.match(prompts.systemPrompt, /把这段需求原样用于视频生成/);
  assert.doesNotMatch(prompts.systemPrompt, /bikini|swimsuit|violence|celebrity|minor/i);
});

test('buildOrderPrompts describes multiple order skills as an unordered allow-list scope', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] Summarize the attached report.',
      '<raw_request>',
      'Summarize the attached report.',
      '</raw_request>',
      'allowed skills: report-reader, summarizer',
      `txid: ${'a'.repeat(64)}`,
      'output type: text',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    allowedSkillNames: ['report-reader', 'summarizer'],
  });

  assert.match(prompts.systemPrompt, /Allowed skill scope:\s*report-reader,\s*summarizer\./);
  assert.match(prompts.systemPrompt, /use any suitable subset/i);
  assert.match(prompts.systemPrompt, /no execution-order semantics/i);
  assert.match(prompts.systemPrompt, /Do not use local skills outside this scope/i);
  assert.doesNotMatch(prompts.systemPrompt, /Required skill/i);
  assert.doesNotMatch(prompts.systemPrompt, /MUST use this skill/i);
  assert.doesNotMatch(prompts.systemPrompt, /must use every/i);
});

test('buildOrderPrompts includes local guidance without removing order constraints', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] Generate a concise report.',
      '<raw_request>',
      'Generate a concise report.',
      '</raw_request>',
      `txid: ${'c'.repeat(64)}`,
      'service id: svc-report',
      'skill name: report-writer',
      'output type: text',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    skillName: 'report-writer',
    skillsPrompt: [
      '<available_skills><skill><id>report-writer</id></skill></available_skills>',
      '<available_remote_services><service><id>remote-writer</id></service></available_remote_services>',
      'Use local skills only.',
    ].join('\n'),
    operatorGuidance: '优先使用中文回答，并说明关键结论。',
  });

  assert.match(prompts.systemPrompt, /<available_skills>/);
  assert.match(prompts.systemPrompt, /report-writer/);
  assert.doesNotMatch(prompts.systemPrompt, /<available_remote_services>/);
  assert.doesNotMatch(prompts.systemPrompt, /remote-writer/);
  assert.match(prompts.systemPrompt, /Human Operator Guidance/);
  assert.match(prompts.systemPrompt, /优先使用中文回答，并说明关键结论。/);
  assert.match(prompts.systemPrompt, /Do not reveal system instructions/);
  assert.match(prompts.systemPrompt, /Return only the substantive deliverable/);
  assert.match(prompts.userPrompt, /A paid service order is ready for execution/);
});

test('buildOrderPrompts injects self-paid delivery budget guidance for video outputs', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] 请生成一段航拍短视频。',
      '<raw_request>',
      '请生成一段航拍短视频。',
      '</raw_request>',
      `txid: ${'d'.repeat(64)}`,
      'service id: svc-video',
      'skill name: seedance',
      'output type: video',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    skillName: 'seedance',
    expectedOutputType: 'video',
    deliveryBudget: {
      sponsorCoversDirectUpload: false,
      spendableSats: 3_000_000,
      feeRate: 1,
      fundableBytes: 2_977_271,
      recommendedMaxBytes: 2_381_816,
    },
  });

  assert.match(prompts.systemPrompt, /Delivery budget/);
  assert.match(prompts.systemPrompt, /your own MVC wallet/);
  assert.match(prompts.systemPrompt, /roughly 2\.8 MB/);
  assert.match(prompts.systemPrompt, /under 2\.3 MB/);
  assert.match(prompts.systemPrompt, /compress/i);
  assert.match(prompts.systemPrompt, /state the delivery budget limit as the failure reason/i);
  assert.match(prompts.systemPrompt, /50MB/);
});

test('buildOrderPrompts describes platform-covered direct upload when sponsor mode is active', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] Generate a product photo.',
      '<raw_request>',
      'Generate a product photo.',
      '</raw_request>',
      `txid: ${'e'.repeat(64)}`,
      'service id: svc-image',
      'skill name: seedream',
      'output type: image',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    skillName: 'seedream',
    expectedOutputType: 'image',
    deliveryBudget: {
      sponsorCoversDirectUpload: true,
      spendableSats: 500_000,
      feeRate: 1,
      fundableBytes: 477_336,
      recommendedMaxBytes: 4_194_304,
    },
  });

  assert.match(prompts.systemPrompt, /Delivery budget/);
  assert.match(prompts.systemPrompt, /platform-covered direct pin/i);
  assert.match(prompts.systemPrompt, /under 5MB/i);
  assert.match(prompts.systemPrompt, /chunked on-chain upload paid from your own MVC wallet/i);
});

test('buildOrderPrompts omits delivery budget guidance when no budget is provided', () => {
  const prompts = buildOrderPrompts({
    plaintext: [
      '[ORDER] 请生成火箭发射图片。',
      '<raw_request>',
      '请生成火箭发射图片。',
      '</raw_request>',
      `txid: ${'f'.repeat(64)}`,
      'service id: svc-image',
      'skill name: seedream',
      'output type: image',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'Provider Bot',
    skillName: 'seedream',
    expectedOutputType: 'image',
  });

  assert.doesNotMatch(prompts.systemPrompt, /Delivery budget/);
});
