import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getOrchestratorTitlePrefix,
  extractSessionTitleFallback,
  buildOrchestratorSessionTitle,
  FALLBACK_TITLE_MAX_LENGTH,
} from '../src/main/libs/orchestratorSessionTitle.ts';

/** Shape of the prompt built by twinOrchestrationService.buildWorkerPrompt. */
function delegationPrompt(objective: string): string {
  return [
    '<twin_delegation>',
    '  <task_id>12a518ef-955d-4977-a267-f418f8e66d6c</task_id>',
    '  <step_id>fc0cee64-9df5-4350-9507-8e13e758f071</step_id>',
    '  <objective>',
    objective,
    '  </objective>',
    '  <acceptance_criteria>',
    '  ["criterion 1"]',
    '  </acceptance_criteria>',
    '</twin_delegation>',
  ].join('\n');
}

test('getOrchestratorTitlePrefix localizes the delegation prefix', () => {
  assert.equal(getOrchestratorTitlePrefix('zh'), '[编排任务]');
  assert.equal(getOrchestratorTitlePrefix('en'), '[Orchestration Task]');
});

test('extractSessionTitleFallback uses the <objective> block of a delegation prompt', () => {
  const prompt = delegationPrompt('修改 IDBots 委派任务 worker session 标题生成逻辑，改为本地化前缀加一句话总结');
  assert.equal(
    extractSessionTitleFallback(prompt, 'zh'),
    '修改 IDBots 委派任务 worker session 标题生成逻辑，改为本地化前缀加一句话总结'
  );
});

test('extractSessionTitleFallback trims multiline objectives to the first line', () => {
  const prompt = delegationPrompt('第一行标题意图\n第二行是补充细节，不应该进入 fallback 标题');
  assert.equal(extractSessionTitleFallback(prompt, 'zh'), '第一行标题意图');
});

test('extractSessionTitleFallback truncates long fallbacks at 50 chars', () => {
  const longLine = '这是一句特别特别特别特别特别特别特别特别特别特别特别特别长的委托目标描述文字'.repeat(2);
  const result = extractSessionTitleFallback(delegationPrompt(longLine), 'zh');
  assert.ok(result.length <= FALLBACK_TITLE_MAX_LENGTH + 1); // 50 chars + ellipsis
  assert.ok(result.endsWith('…'));
  assert.ok(result.startsWith('这是一句特别'));
});

test('extractSessionTitleFallback falls back to the first meaningful line for plain text', () => {
  assert.equal(
    extractSessionTitleFallback('   \n请帮我检查一下发布流程\n然后验证构建', 'zh'),
    '请帮我检查一下发布流程'
  );
});

test('extractSessionTitleFallback skips XML-tag lines even outside an objective block', () => {
  const prompt = ['<twin_delegation>', '<objective></objective>', '   ', '真正的内容行'].join('\n');
  assert.equal(extractSessionTitleFallback(prompt, 'zh'), '真正的内容行');
});

test('extractSessionTitleFallback returns a localized neutral label when nothing is usable', () => {
  assert.equal(extractSessionTitleFallback('', 'zh'), '编排任务');
  assert.equal(extractSessionTitleFallback('<twin_delegation></twin_delegation>', 'zh'), '编排任务');
  assert.equal(extractSessionTitleFallback('', 'en'), 'Orchestration Task');
});

test('buildOrchestratorSessionTitle composes localized prefix + LLM summary', () => {
  assert.equal(
    buildOrchestratorSessionTitle('zh', '修复委派会话标题格式', delegationPrompt('x')),
    '[编排任务] 修复委派会话标题格式'
  );
  assert.equal(
    buildOrchestratorSessionTitle('en', 'Fix delegated session title format', delegationPrompt('x')),
    '[Orchestration Task] Fix delegated session title format'
  );
});

test('buildOrchestratorSessionTitle falls back to the objective when the summary is missing or empty', () => {
  const prompt = delegationPrompt('中文委派目标');
  assert.equal(buildOrchestratorSessionTitle('zh', null, prompt), '[编排任务] 中文委派目标');
  assert.equal(buildOrchestratorSessionTitle('zh', '', prompt), '[编排任务] 中文委派目标');
  assert.equal(buildOrchestratorSessionTitle('zh', '   ', prompt), '[编排任务] 中文委派目标');
});
