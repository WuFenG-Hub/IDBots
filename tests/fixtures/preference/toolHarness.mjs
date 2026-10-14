import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { H1, H2, ROUND_AT, pid } from './scenarios.mjs';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../../../dist-electron/main/sqliteStore.js');
const { PreferenceStore } = require('../../../dist-electron/main/services/preference/store.js');
const { PreferenceService } = require('../../../dist-electron/main/services/preference/service.js');
const { buildPreferenceAgentTools } = require('../../../dist-electron/main/libs/preferenceAgentTools.js');

/**
 * The session bot is MetaBot 7 (globalMetaId H2); the local human user is H1;
 * any other MetaBot id has no identity. `tasks` maps MetaTask root pinIds to
 * fake projections.
 */
export async function toolHarness({ nowSec = ROUND_AT + 1000, events = [], tasks = {}, sessionMetabotId = 7 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-preference-tools-'));
  const sqlite = await SqliteStore.create(dir);
  const store = new PreferenceStore(sqlite.getDatabase(), sqlite.getSaveFunction());
  const state = { nowSec, chainEvents: [...events], writes: [], metataskRefreshes: 0 };
  let serial = 7000;
  const writerFor = (globalMetaId) => ({
    globalMetaId,
    write: async (segment, payload) => {
      serial += 1;
      const pinId = pid(serial);
      state.writes.push({ segment, payload: JSON.parse(JSON.stringify(payload)), author: globalMetaId, pinId });
      return { pinId, txids: [pinId.slice(0, 64)] };
    },
  });
  const service = new PreferenceService({
    store,
    collect: async () => ({ events: state.chainEvents.map((event) => ({ ...event })), perPath: [] }),
    resolveWriter: (signer) => {
      if (signer.type === 'user') return writerFor(H1);
      return signer.metabotId === 7 ? writerFor(H2) : { error: 'METABOT_IDENTITY_MISSING' };
    },
    nowMs: () => state.nowSec * 1000,
  });
  const handlers = {};
  const tool = (name, _description, _schema, handler) => {
    handlers[name] = handler;
    return { name };
  };
  const built = buildPreferenceAgentTools({
    tool,
    control: {
      service: () => service,
      resolveGlobalMetaId: (metabotId) => (metabotId === 7 ? H2 : null),
      metataskDetail: (rootPinId) => tasks[rootPinId] ?? null,
      refreshMetaTask: async () => {
        state.metataskRefreshes += 1;
        return { ok: true, error: null };
      },
    },
    sessionId: 'session-1',
    resolveMetabotId: () => sessionMetabotId,
    nowMs: () => state.nowSec * 1000,
  });
  const call = async (name, args) => {
    const result = await handlers[name](args);
    const text = result.content[0].text;
    const isError = result.isError === true;
    return { isError, text, json: isError ? null : JSON.parse(text) };
  };
  return { service, state, handlers, call, built };
}

let confirmHeight = 400_000;
/** Simulates a captured write getting mined at block time `atSec`. */
export const confirm = (state, write, atSec) => {
  confirmHeight += 1;
  state.chainEvents.push({
    pinId: write.pinId,
    path: write.segment,
    author: write.author,
    height: confirmHeight,
    txIndex: 0,
    timestampMs: atSec * 1000,
    body: write.payload,
  });
};
