// Shared DreamService test harness for the RRSI evolution phases (P1+).
//
// Framework-free fixture: no node:test imports. It wires compiled stores plus
// a marker-routed fake LLM around one DreamService instance so multi-night
// dream flows (distill → gate → reconcile → promote) can be driven from tests.
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from '../memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

export const BOT_ID = 5;
export const LONG_IDENTITY = `我是一个认真严谨的 MetaBot。${'我先验证再交付。'.repeat(30)}`;

export const MARKERS = {
  validation: '能力验证',
  reconciliation: '记忆核对',
};

export function loadDreamServiceModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../../dist-electron/main/services/dreamService.js');
  } finally {
    Module._load = originalLoad;
  }
}

/** Local midnight (ms) of a YYYY-MM-DD date key. */
export function dayStartMs(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
  if (!match) throw new Error(`dayStartMs expects YYYY-MM-DD, got ${dateKey}`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

export function metabotStoreStub() {
  return {
    listMetabots: () => [
      { id: BOT_ID, name: '小火', role: '视频创作者', soul: '认真严谨', llm_id: 'bot-own-llm', enabled: true },
    ],
  };
}

let seededSessionCount = 0;

/**
 * Create one cowork session for bot 5 and insert its turns into
 * cowork_messages inside the dreamed day. Message ids stay unique across
 * calls (date + session index + turn index).
 */
export function seedSession(coworkStore, db, dateKey, turns, options = {}) {
  const metabotId = options.metabotId ?? BOT_ID;
  const title = options.title ?? '和用户聊发布';
  const session = coworkStore.createSession(title, '/tmp/a', '', 'local', [], metabotId);
  seededSessionCount += 1;
  const sessionIndex = seededSessionCount;
  const base = dayStartMs(dateKey);
  turns.forEach((turn, index) => {
    db.run(
      'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [
        `${dateKey}-${sessionIndex}-${index}`,
        session.id,
        turn.type,
        turn.content,
        '{}',
        base + 1000 * (index + 1),
        index + 1,
      ],
    );
  });
  return session;
}

/**
 * A valid dream output JSON string. Overrides merge over the defaults at the
 * top level; `capability_learnings` / `practice_proposals` are passed through
 * as given (snake_case).
 */
export function dreamJson(overrides = {}) {
  return JSON.stringify({
    daily_summary: '今天交付了视频。',
    sections: {},
    work_reviews: [],
    important_memories: [],
    value_lessons: [],
    self_identity: LONG_IDENTITY,
    capability_learnings: [],
    practice_proposals: [],
    ...overrides,
  });
}

/**
 * Marker-routed fake LLM. `performChat(system, user)` records the call, finds
 * the first registered marker contained in the system prompt and hands the
 * call to that responder; otherwise the fallback answers (default: a plain
 * dream JSON). Responder results are JSON-stringified when they are objects.
 * `nth` inside a responder is the 1-based count of calls routed to that
 * marker within the current dream run (`resetRun()` clears it) — panel A is
 * nth 1, panel B is nth 2.
 */
export function createChatRouter() {
  const calls = [];
  const responders = [];
  const perRunCounts = new Map();
  let fallback = () => dreamJson();
  return {
    calls,
    on(marker, responder) {
      responders.push({ marker, responder });
    },
    setFallback(responder) {
      fallback = responder;
    },
    resetRun() {
      perRunCounts.clear();
    },
    performChat: async (system, user) => {
      calls.push({ system, user });
      const entry = responders.find((candidate) => system.includes(candidate.marker));
      if (!entry) return fallback({ system, user });
      const nth = (perRunCounts.get(entry.marker) ?? 0) + 1;
      perRunCounts.set(entry.marker, nth);
      const result = await entry.responder({ system, user, nth });
      if (typeof result === 'string') return result;
      return JSON.stringify(result);
    },
  };
}

/**
 * Parse every `### 草案 #<id>(…)` header and its following `标题:<title>`
 * line out of a validation prompt and answer the output contract. `decide`
 * returns `{ verdict, score, rationale }` or null to omit that draft.
 */
export function validationVerdicts(user, decide) {
  const drafts = [...String(user).matchAll(/### 草案 #(\d+)\([^)]*\)\n标题:([^\n]+)/g)].map((match, index) => ({
    id: Number(match[1]),
    title: match[2],
    index,
  }));
  const verdicts = [];
  for (const draft of drafts) {
    const decision = decide(draft);
    if (decision) verdicts.push({ id: draft.id, ...decision });
  }
  return { verdicts };
}

/**
 * One fully wired DreamService night-runner. `runNight(dateKey)` resets the
 * router's per-run counters, moves the clock to 03:00 of the next day and
 * awaits `service.runNow(BOT_ID, dateKey)`; `telemetry(dateKey)` reads the
 * recorded run telemetry (null before the first run).
 */
export async function createDreamHarness(options = {}) {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const router = createChatRouter();
  const { DreamService } = loadDreamServiceModule();
  const { DreamStore } = require('../../dist-electron/main/dreamStore.js');
  const { MetaIDKnowledgeStore } = require('../../dist-electron/main/metaidKnowledgeStore.js');
  const dreamStore = new DreamStore(db, () => {});
  let currentNow = new Date(2026, 7, 3, 3, 0);
  const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => currentNow.getTime());
  const deps = {
    coworkStore,
    metabotStore: metabotStoreStub(),
    dreamStore,
    metaidKnowledgeStore: knowledgeStore,
    llmTimeoutMs: 5000,
    transientRetryDelaysMs: [],
    now: () => currentNow,
    performChat: router.performChat,
  };
  if (options.capabilityGate !== undefined) {
    deps.capabilityGate = options.capabilityGate;
  }
  const service = new DreamService(deps);
  return {
    db,
    coworkStore,
    dreamStore,
    knowledgeStore,
    router,
    service,
    setNow: (date) => {
      currentNow = date;
    },
    runNight: async (dateKey) => {
      router.resetRun();
      const next = new Date(dayStartMs(dateKey) + 27 * 60 * 60 * 1000); // 03:00 next day
      currentNow = next;
      await service.runNow(BOT_ID, dateKey);
    },
    telemetry: (dateKey) => dreamStore.getRun(BOT_ID, dateKey)?.telemetry ?? null,
    cleanup,
  };
}
