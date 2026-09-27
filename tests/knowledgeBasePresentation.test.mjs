import test from 'node:test';
import assert from 'node:assert/strict';
import { formatKnowledgeBaseLearnSummary } from '../src/renderer/services/knowledgeBasePresentation.js';

const zh = {
  knowledgeBaseLearnSummary: '新增 {added} / 更新 {updated} / 移除 {removed}',
  knowledgeBaseLearnSummaryFailed: '{count} 个文件学习失败',
  knowledgeBaseLearnSummaryFailedReason: '（首个错误：{reason}）',
  knowledgeBaseLearnFailed: '学习失败',
};
const t = (key) => zh[key];

test('clean run keeps the success notice with just the counts', () => {
  const notice = formatKnowledgeBaseLearnSummary(
    { added: 2, updated: 1, removed: 0, unchanged: 3, failed: [] },
    t
  );
  assert.equal(notice.kind, 'success');
  assert.equal(notice.text, '新增 2 / 更新 1 / 移除 0');
});

test('missing failed array is treated as no failures (legacy summaries)', () => {
  const notice = formatKnowledgeBaseLearnSummary({ added: 1, updated: 0, removed: 0 }, t);
  assert.equal(notice.kind, 'success');
});

test('failures flip the notice to error and name the first file and reason', () => {
  const notice = formatKnowledgeBaseLearnSummary(
    {
      added: 0,
      updated: 0,
      removed: 0,
      failed: [
        { relpath: 'spec.pdf', error: 'Failed to parse PDF "spec.pdf": boom' },
        { relpath: 'other.docx', error: 'docx also broke' },
      ],
    },
    t
  );
  assert.equal(notice.kind, 'error');
  assert.ok(notice.text.includes('2 个文件学习失败'), notice.text);
  assert.ok(notice.text.includes('spec.pdf: Failed to parse PDF "spec.pdf": boom'), notice.text);
  assert.ok(!notice.text.includes('other.docx'), notice.text);
});

test('long failure reasons are truncated to keep the notice one line', () => {
  const notice = formatKnowledgeBaseLearnSummary(
    { added: 0, failed: [{ relpath: 'big.pdf', error: 'x'.repeat(500) }] },
    t
  );
  assert.ok(notice.text.length < 300, notice.text);
  assert.ok(/x…）$/.test(notice.text), notice.text);
});

test('failure entry without a reason falls back to the generic learn-failed string', () => {
  const notice = formatKnowledgeBaseLearnSummary(
    { added: 0, failed: [{ relpath: 'silent.pdf', error: '' }] },
    t
  );
  assert.equal(notice.kind, 'error');
  assert.ok(notice.text.includes('silent.pdf: 学习失败'), notice.text);
});
