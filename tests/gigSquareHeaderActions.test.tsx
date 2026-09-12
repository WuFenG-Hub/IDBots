import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareHeaderActions from '../src/renderer/components/gigSquare/GigSquareHeaderActions';
import { i18nService } from '../src/renderer/services/i18n';

test('header actions render my services, refunds badge, and publish action', () => {
  const markup = renderToStaticMarkup(
    <GigSquareHeaderActions
      pendingRefundCount={3}
      onOpenMyServices={() => {}}
      onOpenRefunds={() => {}}
      onOpenPublish={() => {}}
    />
  );

  assert.ok(markup.includes(i18nService.t('gigSquareMyServicesButton')), 'my services action rendered');
  assert.ok(markup.includes(i18nService.t('gigSquareRefundsButton')), 'refunds action rendered');
  assert.match(markup, />3<\/span>/);
  assert.ok(markup.includes(i18nService.t('gigSquarePublishButton')), 'publish action rendered');
});

test('header actions hide the refunds badge when there is no pending refund', () => {
  const markup = renderToStaticMarkup(
    <GigSquareHeaderActions
      pendingRefundCount={0}
      onOpenMyServices={() => {}}
      onOpenRefunds={() => {}}
      onOpenPublish={() => {}}
    />
  );

  assert.ok(markup.includes(i18nService.t('gigSquareRefundsButton')), 'refunds action rendered');
  assert.doesNotMatch(markup, />0<\/span>/);
});
