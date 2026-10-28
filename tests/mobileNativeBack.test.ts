import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeBackDispatcher, handleMobileRootBack } from '../src/mobile/app/nativeBack.ts';

function fakeAdapter() {
  let callback: (() => boolean) | undefined;
  let subscriptions = 0;
  let unsubscriptions = 0;
  return {
    adapter: {
      onBackButton: (next: () => boolean) => {
        callback = next;
        subscriptions += 1;
        return () => { unsubscriptions += 1; };
      },
    },
    emit: () => callback?.() ?? false,
    counts: () => ({ subscriptions, unsubscriptions }),
  };
}

test('Android Back reaches only the highest-priority mounted overlay', () => {
  const fake = fakeAdapter();
  const dispatcher = createNativeBackDispatcher(fake.adapter);
  const calls: string[] = [];
  dispatcher.register(() => { calls.push('route'); return true; }, 0);
  const removeSheet = dispatcher.register(() => { calls.push('sheet'); return true; }, 100);
  const removeDrawer = dispatcher.register(() => { calls.push('drawer'); return true; }, 100);

  assert.equal(fake.emit(), true);
  assert.deepEqual(calls, ['drawer']);
  removeDrawer();
  assert.equal(fake.emit(), true);
  assert.deepEqual(calls, ['drawer', 'sheet']);
  removeSheet();
  assert.equal(fake.emit(), true);
  assert.deepEqual(calls, ['drawer', 'sheet', 'route']);
  assert.deepEqual(fake.counts(), { subscriptions: 1, unsubscriptions: 0 });
  dispatcher.destroy();
  assert.deepEqual(fake.counts(), { subscriptions: 1, unsubscriptions: 1 });
});

test('an unhandled root reaches the native fallback and the last cleanup unsubscribes', () => {
  const fake = fakeAdapter();
  const dispatcher = createNativeBackDispatcher(fake.adapter);
  const cleanup = dispatcher.register(() => false);
  assert.equal(fake.emit(), false);
  cleanup();
  cleanup();
  assert.equal(fake.emit(), false);
  assert.deepEqual(fake.counts(), { subscriptions: 1, unsubscriptions: 1 });
});

test('a failing mounted handler consumes Back instead of exiting behind its UI', () => {
  const fake = fakeAdapter();
  const dispatcher = createNativeBackDispatcher(fake.adapter);
  dispatcher.register(() => { throw new Error('stale view'); }, 100);
  assert.equal(fake.emit(), true);
  dispatcher.destroy();
});

test('root Back closes recharge before switching the existing tab state', () => {
  const actions: string[] = [];
  const closeRecharge = () => actions.push('close-recharge');
  const showChat = () => actions.push('show-chat');
  assert.equal(handleMobileRootBack({ rechargeOpen: true, tab: 'me' }, { closeRecharge, showChat }), true);
  assert.deepEqual(actions, ['close-recharge']);

  actions.length = 0;
  assert.equal(handleMobileRootBack({ rechargeOpen: false, tab: 'tasks' }, { closeRecharge, showChat }), true);
  assert.deepEqual(actions, ['show-chat']);

  actions.length = 0;
  assert.equal(handleMobileRootBack({ rechargeOpen: false, tab: 'chat' }, { closeRecharge, showChat }), false);
  assert.deepEqual(actions, []);
});
