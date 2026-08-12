import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TwinBadge from '../src/renderer/components/metabots/TwinBadge';
import MetaBotSelector, { type MetaBotForSelector } from '../src/renderer/components/cowork/MetaBotSelector';
import MetaBotListCard from '../src/renderer/components/metabots/MetaBotListCard';
import type { Metabot } from '../src/renderer/types/metabot';

const selectors = (metabots: MetaBotForSelector[], selectedId: number | null) => ({
  metabots,
  selectedId,
  onSelect: () => {},
  label: 'Meta bot',
  placeholder: 'Select a bot',
});

test('TwinBadge renders the Twin label with the shared badge slot', () => {
  const markup = renderToStaticMarkup(<TwinBadge />);
  assert.match(markup, /data-slot="metabot-twin-badge"/);
  assert.match(markup, />Twin</);
});

test('MetaBotSelector shows the Twin badge next to the selected Twin bot', () => {
  const markup = renderToStaticMarkup(
    <MetaBotSelector
      {...selectors(
        [
          { id: 1, name: 'TwinBot', avatar: null, metabot_type: 'twin' },
          { id: 2, name: 'WorkerBot', avatar: null, metabot_type: 'worker' },
        ],
        1,
      )}
    />,
  );

  assert.match(markup, /TwinBot<\/span>\s*<span[^>]*data-slot="metabot-twin-badge"[^>]*>Twin<\/span>/);
  // The Twin must not fall back to the plain type suffix.
  assert.doesNotMatch(markup, /TwinBot<\/span>\s*\(twin\)/);
});

test('MetaBotSelector does not show the Twin badge when a worker is selected', () => {
  const markup = renderToStaticMarkup(
    <MetaBotSelector
      {...selectors(
        [
          { id: 1, name: 'TwinBot', avatar: null, metabot_type: 'twin' },
          { id: 2, name: 'WorkerBot', avatar: null, metabot_type: 'worker' },
        ],
        2,
      )}
    />,
  );

  assert.match(markup, />WorkerBot<\/span>/);
  assert.doesNotMatch(markup, /data-slot="metabot-twin-badge"/);
});

const baseMetabot = {
  id: 1,
  wallet_id: 11,
  mvc_address: '1BLoQMNePNqFMj4nJMoBa6BxvbikVGkEso',
  btc_address: 'btc-address',
  doge_address: 'doge-address',
  chat_public_key_pin_id: null,
  metabot_info_pinid: 'pin-1',
  name: 'AI_Sunny',
  avatar: null,
  enabled: true,
  metabot_type: 'worker',
  role: 'assistant',
  soul: 'helpful',
  goal: null,
  background: null,
  boss_id: null,
  boss_global_metaid: null,
  llm_id: null,
  tools: [],
  skills: [],
  created_at: 1,
  updated_at: 1,
  globalmetaid: 'idq14habcdefg9xz',
} as unknown as Metabot;

test('MetaBotListCard shows the Twin badge only on the Twin bot', () => {
  const renderCard = (metabot: Metabot) =>
    renderToStaticMarkup(
      <MetaBotListCard
        metabot={metabot}
        onEdit={() => {}}
        onToggleEnabled={() => {}}
        isChainSynced
        onSyncToChain={() => {}}
      />,
    );

  const workerMarkup = renderCard(baseMetabot);
  assert.doesNotMatch(workerMarkup, /data-slot="metabot-twin-badge"/);

  const twinMarkup = renderCard({ ...baseMetabot, metabot_type: 'twin' });
  assert.match(twinMarkup, /data-slot="metabot-twin-badge"/);
  assert.match(twinMarkup, />Twin</);
});
