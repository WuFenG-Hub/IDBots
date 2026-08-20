import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDownloadComplete,
  modalStateForUpdatePhase,
  resolveCancelDownloadFollowUp,
  resolveConfirmUpdateAction,
  shouldPreserveDownloadProgress,
} from '../src/renderer/services/appUpdateUi.ts';

test('isDownloadComplete treats 100% (and floating-point 99.9%+) as done', () => {
  assert.equal(isDownloadComplete(null), false);
  assert.equal(isDownloadComplete({}), false);
  assert.equal(isDownloadComplete({ percent: 0.5 }), false);
  assert.equal(isDownloadComplete({ percent: 0.999 }), true);
  assert.equal(isDownloadComplete({ percent: 1 }), true);
});

test('modalStateForUpdatePhase maps silent phases onto the visible modal', () => {
  assert.equal(modalStateForUpdatePhase('downloading'), 'downloading');
  assert.equal(modalStateForUpdatePhase('applying'), 'installing');
  assert.equal(modalStateForUpdatePhase('restartReady'), 'restart');
  assert.equal(modalStateForUpdatePhase('ready'), 'info');
  assert.equal(modalStateForUpdatePhase('idle'), 'info');
});

test('opening the modal preserves progress only while a download is in flight', () => {
  assert.equal(shouldPreserveDownloadProgress('downloading'), true);
  assert.equal(shouldPreserveDownloadProgress('ready'), false);
  assert.equal(shouldPreserveDownloadProgress('applying'), false);
  assert.equal(shouldPreserveDownloadProgress('restartReady'), false);
});

test('Confirm/Install joins the silent flow instead of racing a second install', () => {
  assert.deepEqual(
    resolveConfirmUpdateAction({ phase: 'restartReady', modalState: 'restart', downloadedFilePath: '/tmp/a' }),
    { type: 'relaunch' },
  );
  assert.deepEqual(
    resolveConfirmUpdateAction({ phase: 'restartReady', modalState: 'downloading', downloadedFilePath: '/tmp/a' }),
    { type: 'showRestart' },
  );
  assert.deepEqual(
    resolveConfirmUpdateAction({ phase: 'applying', modalState: 'downloading', downloadedFilePath: '/tmp/a' }),
    { type: 'waitForSilentApply' },
  );
  assert.deepEqual(
    resolveConfirmUpdateAction({ phase: 'downloading', modalState: 'downloading', downloadedFilePath: null }),
    { type: 'waitForSilentApply' },
  );
  assert.deepEqual(
    resolveConfirmUpdateAction({ phase: 'ready', modalState: 'info', downloadedFilePath: '/tmp/a' }),
    { type: 'installLocal', filePath: '/tmp/a' },
  );
  assert.deepEqual(
    resolveConfirmUpdateAction({ phase: 'idle', modalState: 'info', downloadedFilePath: null }),
    { type: 'downloadManual' },
  );
});

test('Cancel after a finished download joins the current phase instead of resetting', () => {
  assert.deepEqual(
    resolveCancelDownloadFollowUp({ phase: 'downloading', downloadWasActive: true }),
    { type: 'resetToInfo' },
  );
  assert.deepEqual(
    resolveCancelDownloadFollowUp({ phase: 'applying', downloadWasActive: false }),
    { type: 'joinPhase', modalState: 'installing' },
  );
  assert.deepEqual(
    resolveCancelDownloadFollowUp({ phase: 'restartReady', downloadWasActive: false }),
    { type: 'joinPhase', modalState: 'restart' },
  );
  assert.deepEqual(
    resolveCancelDownloadFollowUp({ phase: 'ready', downloadWasActive: false }),
    { type: 'joinPhase', modalState: 'info' },
  );
});
