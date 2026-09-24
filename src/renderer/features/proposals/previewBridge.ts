// Explicit in-memory fixtures; never load the production Electron preload.
const unsubscribe = () => () => {};
const blocked = async () => { throw new Error('Unavailable in isolated UI preview'); };
const values = new Map<string, unknown>();
Object.defineProperty(window, 'electron', { value: {
  platform: 'darwin',
  window: { isMaximized: async () => false, onStateChanged: unsubscribe },
  skills: { list: async () => ({ success: true, skills: [] }), onChanged: unsubscribe },
  appInfo: { getSystemLocale: async () => 'zh-CN' },
  store: { get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: unknown) => { values.set(key, value); },
    remove: async (key: string) => { values.delete(key); }, onChanged: unsubscribe },
  powerGuard: { getStatus: async () => ({ active: false, engaged: false, sources: [] }), onChanged: unsubscribe },
  cowork: { isDelegationBlocking: async () => false, onDelegationStateChange: unsubscribe,
    listSessionFeedback: async () => ({ success: true, feedback: [] }) },
  metabot: { list: async () => ({ success: true, list: [] }) },
  dialog: { selectFile: blocked, saveInlineFile: blocked },
  shell: { openPath: blocked, openExternal: blocked },
} });
