import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCoworkSessionStartOptions,
  resolveDefaultMetabotId,
} from '../src/renderer/services/coworkSessionStart';

const bots = [
  { id: 2, metabot_type: 'worker' },
  { id: 1, metabot_type: 'twin' },
];

describe('cowork session start context', () => {
  it('selects the actual Twin by default and preserves a valid explicit choice', () => {
    assert.equal(resolveDefaultMetabotId(bots, null), 1);
    assert.equal(resolveDefaultMetabotId(bots, 2), 2);
    assert.equal(resolveDefaultMetabotId(bots, 99), 1);
  });

  it('uses the first selectable Bot only as an explicit fallback', () => {
    assert.equal(resolveDefaultMetabotId([{ id: 7, metabot_type: 'worker' }], null), 7);
    assert.equal(resolveDefaultMetabotId([], null), null);
  });

  it('passes identity and workspace without overriding the Twin brain or persisted permission preference', () => {
    const options = buildCoworkSessionStartOptions({
      metabotId: 1,
      title: 'First chat',
      config: { workingDirectory: '/data/workspace', systemPrompt: 'Owner rules' },
    });
    assert.deepEqual(options, {
      metabotId: 1,
      title: 'First chat',
      cwd: '/data/workspace',
      systemPrompt: 'Owner rules',
    });
    assert.equal('model' in options, false);
    assert.equal('modelProvider' in options, false);
    assert.equal('effort' in options, false);
    assert.equal('permissionMode' in options, false);
  });

  it('lets main resolve the configured workspace when config has not hydrated yet', () => {
    assert.deepEqual(
      buildCoworkSessionStartOptions({ metabotId: 1, title: 'First chat' }),
      { metabotId: 1, title: 'First chat' },
    );
  });
});
