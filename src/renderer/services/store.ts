// 删除重复的类型声明，使用全局类型定义
export interface LocalStore {
  getItem<T>(key: string): Promise<T | null>;
  /**
   * Like getItem, but a store/IPC failure REJECTS instead of collapsing to
   * null. Callers that must distinguish "key absent" (null) from "read
   * failed" (reject) — e.g. the config service deciding whether persisting a
   * defaults-based in-memory config would wipe stored user data — use this
   * variant.
   */
  getItemStrict<T>(key: string): Promise<T | null>;
  setItem<T>(key: string, value: T): Promise<void>;
  removeItem(key: string): Promise<void>;
}

// 订阅 store 键变更（跨窗口同步：其他窗口 store:set/remove 后触发）
export type StoreChangedHandler = (payload: { key: string }) => void;

class LocalStoreService implements LocalStore {
  async getItem<T>(key: string): Promise<T | null> {
    try {
      const value = await window.electron.store.get(key);
      return value || null;
    } catch (error) {
      console.error('Failed to get item from store:', error);
      return null;
    }
  }

  /**
   * Like getItem, but never collapses an unreadable value to null: an absent
   * key resolves to null (verified fresh), while a store/IPC failure OR a
   * row whose stored JSON fails to parse REJECTS (store:getStrict). Callers
   * that must refuse destructive defaults writes on unreadable data — the
   * config service deciding whether persisting a defaults-based config
   * would wipe stored credentials — use this variant.
   */
  async getItemStrict<T>(key: string): Promise<T | null> {
    const value = await window.electron.store.getStrict(key);
    return value ?? null;
  }

  async setItem<T>(key: string, value: T): Promise<void> {
    try {
      await window.electron.store.set(key, value);
    } catch (error) {
      console.error('Failed to set item in store:', error);
      throw error;
    }
  }

  async removeItem(key: string): Promise<void> {
    try {
      await window.electron.store.remove(key);
    } catch (error) {
      console.error('Failed to remove item from store:', error);
      throw error;
    }
  }

  /** 监听任一键的变更；返回取消订阅函数 */
  onChanged(handler: StoreChangedHandler): () => void {
    try {
      return window.electron.store.onChanged(handler);
    } catch (error) {
      console.error('Failed to subscribe to store changes:', error);
      return () => {};
    }
  }
}

export const localStore = new LocalStoreService();