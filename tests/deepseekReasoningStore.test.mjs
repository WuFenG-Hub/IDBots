import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let DeepSeekReasoningStore;
try {
  ({ DeepSeekReasoningStore } = await import('../dist-electron/main/libs/deepseekReasoningStore.js'));
} catch {
  ({ DeepSeekReasoningStore } = await import('../dist-electron/libs/deepseekReasoningStore.js'));
}

const makeTmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-reasoning-store-'));

test('set/get round-trips reasoning and persists it across a reload (app restart)', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'cache.jsonl');

    const store = new DeepSeekReasoningStore(8);
    store.load(filePath);
    store.set('call_1', 'reasoning for call 1');
    store.set('call_2', 'reasoning for call 2');
    assert.equal(store.get('call_1'), 'reasoning for call 1');
    assert.ok(fs.existsSync(filePath), 'backing file must be written on set');

    // Simulate an app restart: a brand-new store instance over the same file.
    const reloaded = new DeepSeekReasoningStore(8);
    reloaded.load(filePath);
    assert.equal(reloaded.get('call_1'), 'reasoning for call 1');
    assert.equal(reloaded.get('call_2'), 'reasoning for call 2');
    assert.equal(reloaded.get('call_missing'), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LRU eviction keeps the newest entries and compaction bounds the file', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'cache.jsonl');

    const store = new DeepSeekReasoningStore(4);
    store.load(filePath);
    for (let i = 0; i < 10; i += 1) {
      store.set(`call_${i}`, `reasoning ${i}`);
    }
    assert.equal(store.size, 4, 'in-memory map is capped');
    assert.equal(store.get('call_0'), undefined, 'oldest entry evicted');
    assert.equal(store.get('call_9'), 'reasoning 9');

    // After enough appends the file is compacted to the live entries only.
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
    assert.ok(lines.length <= 4 + 4, `file must be compacted periodically, got ${lines.length} lines`);

    const reloaded = new DeepSeekReasoningStore(4);
    reloaded.load(filePath);
    assert.equal(reloaded.get('call_9'), 'reasoning 9');
    assert.ok(reloaded.size <= 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt lines are skipped on load; blank/empty values are never stored', () => {
  const dir = makeTmpDir();
  try {
    const filePath = path.join(dir, 'cache.jsonl');
    fs.writeFileSync(filePath, [
      '{"id":"call_ok","reasoning":"good"}',
      'not-json',
      '{"id":"call_noreasoning"}',
      '',
    ].join('\n'));

    const store = new DeepSeekReasoningStore(8);
    store.load(filePath);
    assert.equal(store.get('call_ok'), 'good');
    assert.equal(store.size, 1);

    store.set('call_blank', '   ');
    store.set('', 'no id');
    assert.equal(store.size, 1, 'blank reasoning / empty id are rejected');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('memory-only mode works without a backing file', () => {
  const store = new DeepSeekReasoningStore(2);
  store.set('a', '1');
  store.set('b', '2');
  store.set('c', '3');
  assert.equal(store.get('a'), undefined);
  assert.equal(store.get('c'), '3');
  store.clear();
  assert.equal(store.size, 0);
});
