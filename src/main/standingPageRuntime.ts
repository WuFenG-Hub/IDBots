import type { StandingPageStore } from './standingPageStore';

/**
 * Runtime accessor for the StandingPageStore singleton (leaf module, same
 * pattern as chainContentHistoryRuntime): the store is constructed lazily in
 * main.ts, which pushes it in here; the cowork runner (tool surface) and any
 * service pull it back out without importing main.ts. A null store (unit
 * tests, early startup) simply means "tool unavailable".
 */
let store: StandingPageStore | null = null;

export function setStandingPageStore(s: StandingPageStore | null): void {
  store = s;
}

export function getStandingPageStore(): StandingPageStore | null {
  return store;
}
