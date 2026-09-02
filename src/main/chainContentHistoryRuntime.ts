import type { ChainContentHistoryStore } from './chainContentHistoryStore';

/**
 * Runtime accessor for the ChainContentHistoryStore singleton.
 *
 * Leaf module by design: services/metaidCore.ts (createPin) must record every
 * successful MetaBot pin into the ledger, but the store itself is constructed
 * in main.ts alongside the other SQLite-backed stores. Importing main.ts from
 * metaidCore would create a dependency cycle, so main.ts pushes the ready
 * store in here and the ledger helpers pull it back out. A null store (unit
 * tests, early startup) simply means "recording disabled".
 */
let store: ChainContentHistoryStore | null = null;

export function setChainContentHistoryStore(s: ChainContentHistoryStore | null): void {
  store = s;
}

export function getChainContentHistoryStore(): ChainContentHistoryStore | null {
  return store;
}
