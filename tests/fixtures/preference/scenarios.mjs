import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Loaded lazily so schema tests run before sealing.ts exists. */
const sealing = () => require('../../../dist-electron/main/services/preference/sealing.js');

export const pid = (n) => `${n.toString(16).padStart(64, '0')}i0`;
export const gid = (name) => `idq1${name}`.padEnd(42, '0');
export const saltOf = (n) => n.toString(16).padStart(64, '0');

export const ROUND_AT = 1_792_000_000;
export const COMMIT_CLOSE = ROUND_AT + 86_400;
export const REVEAL_CLOSE = COMMIT_CLOSE + 86_400;
export const FINAL_NOW = REVEAL_CLOSE + 7_201;

export const TWIN = gid('twin1');
export const B1 = gid('builder1');
export const B2 = gid('builder2');
export const B3 = gid('builder3');
export const H1 = gid('human1');
export const H2 = gid('human2');
export const H3 = gid('human3');
export const A1 = gid('ai1');
export const P1 = gid('public1');

export const CANDIDATES = [
  { id: 'c1', ref: pid(1), artifact: `metaapp://${pid(11)}`, author: B1 },
  { id: 'c2', ref: pid(2), artifact: `metaapp://${pid(12)}`, author: B2 },
  { id: 'c3', ref: pid(3), artifact: `metaapp://${pid(13)}`, author: B3 },
];

export const DEFAULT_JUDGES = [
  { id: H1, kind: 'human' },
  { id: H2, kind: 'human' },
  { id: H3, kind: 'human' },
  { id: A1, kind: 'ai' },
];

export const roundBody = (over = {}) => ({
  title: 'Q&A UI v2',
  category: ['ui:qa-community'],
  candidates: CANDIDATES,
  judges: DEFAULT_JUDGES,
  decision: { kinds: ['human'], minBallots: 2 },
  dimensions: [{ id: 'visual', label: 'Visual quality' }],
  commitCloseAt: COMMIT_CLOSE,
  revealCloseAt: REVEAL_CLOSE,
  ...over,
});

export const pair = (a, b, pick, extra = {}) => ({ a, b, pick, reason: `${a} vs ${b}: ${pick}`, ...extra });
export const ballot = (...pairs) => ({ pairs });

export { sealing };
