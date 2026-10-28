import { getNativeAdapter } from '../native/nativeAdapter';
import type { MobileTab } from './components/TabBar';

export interface NativeBackAdapter {
  onBackButton(callback: () => boolean): () => void;
}

interface BackEntry {
  callback: () => boolean;
  priority: number;
  sequence: number;
}

export interface NativeBackDispatcher {
  register(callback: () => boolean, priority?: number): () => void;
  dispatch(): boolean;
  destroy(): void;
}

export function createNativeBackDispatcher(adapter: NativeBackAdapter): NativeBackDispatcher {
  let entries: BackEntry[] = [];
  let sequence = 0;
  let unsubscribe: (() => void) | null = null;

  const dispatch = (): boolean => {
    const ordered = [...entries].sort((left, right) => right.priority - left.priority || right.sequence - left.sequence);
    for (const entry of ordered) {
      try {
        if (entry.callback()) return true;
      } catch {
        return true;
      }
    }
    return false;
  };

  const stopSubscription = () => {
    unsubscribe?.();
    unsubscribe = null;
  };

  return {
    register: (callback, priority = 0) => {
      const entry = { callback, priority, sequence: sequence += 1 };
      entries.push(entry);
      if (!unsubscribe) unsubscribe = adapter.onBackButton(dispatch);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        entries = entries.filter((candidate) => candidate !== entry);
        if (entries.length === 0) stopSubscription();
      };
    },
    dispatch,
    destroy: () => {
      entries = [];
      stopSubscription();
    },
  };
}

let defaultDispatcher: NativeBackDispatcher | null = null;

export function registerNativeBackHandler(callback: () => boolean, priority = 0): () => void {
  if (!defaultDispatcher) defaultDispatcher = createNativeBackDispatcher(getNativeAdapter());
  return defaultDispatcher.register(callback, priority);
}

export function handleMobileRootBack(
  state: { rechargeOpen: boolean; tab: MobileTab },
  actions: { closeRecharge: () => void; showChat: () => void },
): boolean {
  if (state.rechargeOpen) {
    actions.closeRecharge();
    return true;
  }
  if (state.tab !== 'chat') {
    actions.showChat();
    return true;
  }
  return false;
}
