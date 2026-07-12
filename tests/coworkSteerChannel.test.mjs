import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CoworkSteerChannel,
  buildCoworkSteerSdkMessage,
} from '../dist-electron/main/libs/coworkSteerChannel.js';

test('delivers SDK user messages in FIFO order and acknowledges after consumer progress', async () => {
  const channel = new CoworkSteerChannel();
  const first = channel.enqueue(buildCoworkSteerSdkMessage('first'));
  const second = channel.enqueue(buildCoworkSteerSdkMessage('second'));
  const iterator = channel[Symbol.asyncIterator]();

  assert.equal((await iterator.next()).value.message.content[0].text.includes('first'), true);
  const nextPromise = iterator.next();
  await first.delivered;
  assert.equal((await nextPromise).value.message.content[0].text.includes('second'), true);

  channel.close();
  assert.deepEqual(await iterator.next(), { done: true, value: undefined });
  await second.delivered;
});

test('abort rejects queued delivery and ends the iterator', async () => {
  const channel = new CoworkSteerChannel();
  const queued = channel.enqueue(buildCoworkSteerSdkMessage('never delivered'));
  channel.abort(new Error('stopped'));

  await assert.rejects(queued.delivered, /stopped/);
  await assert.rejects(channel[Symbol.asyncIterator]().next(), /stopped/);
});

test('runtime envelope does not alter the visible user text', () => {
  const message = buildCoworkSteerSdkMessage('只修改查询逻辑');
  const runtimeText = message.message.content[0].text;
  assert.match(runtimeText, /<operator_steer>/);
  assert.match(runtimeText, /只修改查询逻辑/);
  assert.match(runtimeText, /earliest safe boundary/i);
});
