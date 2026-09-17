import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizePin } = require('../dist-electron/main/services/metawebPinService.js');
const { formatMetawebPinDetail } = require('../dist-electron/main/libs/metawebLearningAgentTools.js');

// Shape captured live from so.metaid.io (live-audit round 1): the paycomment
// pin detail returns text:null while the full markdown body sits in
// payload.content next to the commentTo pointer.
const paycommentRaw = {
  pinId: '04abf0d7de75ae03f793707eb8100416b0ba018e0a88dd973d7c6994dbe45154i0',
  currentPinId: '04abf0d7de75ae03f793707eb8100416b0ba018e0a88dd973d7c6994dbe45154i0',
  protocol: 'paycomment',
  path: '/protocols/paycomment',
  chainName: 'mvc',
  operation: 'create',
  creator: { globalMetaId: 'idq-test', metaid: 'meta-test', name: 'Lucy', address: 'addr-test' },
  createdAt: 1789602829,
  contentType: 'application/json',
  payload: {
    commentTo: '851768aaed87757849ec4cc8e97895b4d85590f28ed83dae8a20fd2fc4ca3c35i0',
    content: 'The comment body, in full.',
    contentType: 'text/markdown',
  },
  text: null,
  truncated: null,
  totalLength: null,
  meta: { title: '', summary: '', tags: [] },
  attachments: [],
  source: 'remote',
};

test('payload.content becomes the body when the server extracted no text (paycomment/rev)', () => {
  const pin = normalizePin(paycommentRaw);
  assert.equal(pin.text, 'The comment body, in full.');
  assert.equal(pin.truncated, false, 'payload content is never server-capped');
  assert.equal(pin.totalLength, 'The comment body, in full.'.length);
});

test('server-extracted text always wins over the payload fallback', () => {
  const pin = normalizePin({ ...paycommentRaw, text: 'Server text', truncated: true, totalLength: 999 });
  assert.equal(pin.text, 'Server text');
  assert.equal(pin.truncated, true);
  assert.equal(pin.totalLength, 999);
});

test('payloads without a string content field stay unreadable (encrypted/binary)', () => {
  const encrypted = normalizePin({ ...paycommentRaw, payload: { commentTo: 'x', ciphertext: 'deadbeef' } });
  assert.equal(encrypted.text, null);
  assert.equal(encrypted.truncated, null);
  const noPayload = normalizePin({ ...paycommentRaw, payload: null });
  assert.equal(noPayload.text, null);
});

test('pin sheet surfaces the replies-to pointer for comment/answer payloads', () => {
  const pin = normalizePin(paycommentRaw);
  const sheet = formatMetawebPinDetail(pin);
  assert.match(sheet, /- replies to: 851768aaed87757849ec4cc8e97895b4d85590f28ed83dae8a20fd2fc4ca3c35i0/);
  assert.ok(sheet.includes('The comment body, in full.'), 'derived body renders in the sheet');

  const answer = normalizePin({
    ...paycommentRaw,
    protocol: 'simpleanswer',
    payload: { answerTo: '73a8df99a98db001341a51adf1eeb92d4684e1dfb0583ec6d84fec71d6c764cdi0', content: 'Answer body' },
  });
  assert.match(formatMetawebPinDetail(answer), /- replies to: 73a8df99a98db001341a51adf1eeb92d4684e1dfb0583ec6d84fec71d6c764cdi0/);

  const plain = normalizePin({ ...paycommentRaw, protocol: 'simplenote', payload: { content: 'A note body' } });
  assert.doesNotMatch(formatMetawebPinDetail(plain), /replies to/);
});
