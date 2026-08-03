import { contextBridge, ipcRenderer } from 'electron';
import type {
  CoworkA2AGuidanceRequest,
  CoworkSubmitInput,
  CoworkSubmitInputResult,
} from '../renderer/types/cowork';

// 暴露安全的 API 到渲染进程
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  arch: process.arch,
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('store:set', key, value),
    remove: (key: string) => ipcRenderer.invoke('store:remove', key),
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('skills:setEnabled', options),
    delete: (id: string) => ipcRenderer.invoke('skills:delete', id),
    download: (source: string) => ipcRenderer.invoke('skills:download', source),
    getRoot: () => ipcRenderer.invoke('skills:getRoot'),
    autoRoutingPrompt: () => ipcRenderer.invoke('skills:autoRoutingPrompt'),
    getConfig: (skillId: string) => ipcRenderer.invoke('skills:getConfig', skillId),
    setConfig: (skillId: string, config: Record<string, string>) => ipcRenderer.invoke('skills:setConfig', skillId, config),
    testEmailConnectivity: (skillId: string, config: Record<string, string>) =>
      ipcRenderer.invoke('skills:testEmailConnectivity', skillId, config),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('skills:changed', handler);
      return () => ipcRenderer.removeListener('skills:changed', handler);
    },
  },
  mcp: {
    list: () => ipcRenderer.invoke('mcp:list'),
    create: (data: any) => ipcRenderer.invoke('mcp:create', data),
    update: (id: string, data: any) => ipcRenderer.invoke('mcp:update', id, data),
    delete: (id: string) => ipcRenderer.invoke('mcp:delete', id),
    setEnabled: (options: { id: string; enabled: boolean }) => ipcRenderer.invoke('mcp:setEnabled', options),
  },
  metaapps: {
    list: () => ipcRenderer.invoke('metaapps:list'),
    listCommunity: (input?: { cursor?: string; size?: number }) => ipcRenderer.invoke('metaapps:listCommunity', input),
    installCommunity: (input: { sourcePinId: string }) => ipcRenderer.invoke('metaapps:installCommunity', input),
    open: (input: { appId: string; targetPath?: string }) => ipcRenderer.invoke('metaapps:open', input),
    resolveUrl: (input: { appId: string; targetPath?: string }) => ipcRenderer.invoke('metaapps:resolveUrl', input),
    autoRoutingPrompt: () => ipcRenderer.invoke('metaapps:autoRoutingPrompt'),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('metaapps:changed', handler);
      return () => ipcRenderer.removeListener('metaapps:changed', handler);
    },
  },
  metaappOwner: {
    list: (input: { metabotId: number; cursor?: string; size?: number }) =>
      ipcRenderer.invoke('metaappOwner:list', input),
    publish: (input: { metabotId: number; manifest: Record<string, unknown>; confirm?: boolean; network?: string }) =>
      ipcRenderer.invoke('metaappOwner:publish', input),
    update: (input: { metabotId: number; targetPinId: string; firstPinId?: string; manifest: Record<string, unknown>; confirm?: boolean; network?: string }) =>
      ipcRenderer.invoke('metaappOwner:update', input),
    remove: (input: { metabotId: number; targetPinId: string; firstPinId?: string; confirm?: boolean; network?: string }) =>
      ipcRenderer.invoke('metaappOwner:delete', input),
  },
  botBrowser: {
    onOpenUri: (callback: (input: { uri: string; actorId?: string | null }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, input: { uri: string; actorId?: string | null }) => callback(input);
      ipcRenderer.on('botBrowser:openUri', handler);
      return () => ipcRenderer.removeListener('botBrowser:openUri', handler);
    },
    onTabCommand: (callback: (input: {
      requestId: string;
      command: {
        action: 'open-tab' | 'close-tab' | 'switch-tab' | 'get-tabs' | 'get-active-tab';
        uri?: string;
        tabId?: number;
      };
    }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, input: Parameters<typeof callback>[0]) => callback(input);
      ipcRenderer.on('botBrowser:tab-command', handler);
      return () => ipcRenderer.removeListener('botBrowser:tab-command', handler);
    },
    respondToTabCommand: (response: {
      requestId: string;
      success: boolean;
      result?: unknown;
      error?: string;
    }) => ipcRenderer.send('botBrowser:tab-command:response', response),
    resolveResource: (input: { actorId?: string; uri: string }) =>
      ipcRenderer.invoke('botBrowser:resolveResource', input),
    getProfile: (input: { actorId?: string; globalMetaId: string }) =>
      ipcRenderer.invoke('botBrowser:getProfile', input),
    getSettings: (input?: { actorId?: string }) =>
      ipcRenderer.invoke('botBrowser:getSettings', input),
    updateSettings: (input: { actorId?: string; browser?: Record<string, unknown> }) =>
      ipcRenderer.invoke('botBrowser:updateSettings', input),
    resolveMetaAppPin: (input: { pinId: string }) => ipcRenderer.invoke('botBrowser:resolveMetaAppPin', input),
    getMetaAppCache: () => ipcRenderer.invoke('botBrowser:getMetaAppCache'),
    clearMetaAppCache: (input?: { all?: boolean; scope?: string; pinId?: string; cacheKey?: string }) =>
      ipcRenderer.invoke('botBrowser:clearMetaAppCache', input),
    writeMetaIdPin: (input: { actorId?: string; resourceUri?: string; payload?: unknown; network?: string }) =>
      ipcRenderer.invoke('botBrowser:writeMetaIdPin', input),
    uploadMetaFile: (input: { actorId?: string; resourceUri?: string; payload?: unknown; network?: string }) =>
      ipcRenderer.invoke('botBrowser:uploadMetaFile', input),
    sendPrivateChat: (input: {
      actorId?: string;
      peerGlobalMetaId?: string;
      content?: string;
      replyPin?: string;
      network?: string;
    }) => ipcRenderer.invoke('botBrowser:sendPrivateChat', input),
  },
  permissions: {
    checkCalendar: () => ipcRenderer.invoke('permissions:checkCalendar'),
    requestCalendar: () => ipcRenderer.invoke('permissions:requestCalendar'),
  },
  api: {
    // 普通 API 请求（非流式）
    fetch: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }) => ipcRenderer.invoke('api:fetch', options),

    // 流式 API 请求
    stream: (options: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
      requestId: string;
    }) => ipcRenderer.invoke('api:stream', options),

    // 取消流式请求
    cancelStream: (requestId: string) => ipcRenderer.invoke('api:stream:cancel', requestId),

    // 监听流式数据
    onStreamData: (requestId: string, callback: (chunk: string) => void) => {
      const handler = (_event: any, chunk: string) => callback(chunk);
      ipcRenderer.on(`api:stream:${requestId}:data`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:data`, handler);
    },

    // 监听流式完成
    onStreamDone: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:done`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:done`, handler);
    },

    // 监听流式错误
    onStreamError: (requestId: string, callback: (error: string) => void) => {
      const handler = (_event: any, error: string) => callback(error);
      ipcRenderer.on(`api:stream:${requestId}:error`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:error`, handler);
    },

    // 监听流式取消
    onStreamAbort: (requestId: string, callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on(`api:stream:${requestId}:abort`, handler);
      return () => ipcRenderer.removeListener(`api:stream:${requestId}:abort`, handler);
    },
  },
  gigSquare: {
    fetchServices: () => ipcRenderer.invoke('gigSquare:fetchServices'),
    fetchMyServices: (params?: { page?: number; pageSize?: number; refresh?: boolean }) =>
      ipcRenderer.invoke('gigSquare:fetchMyServices', params),
    fetchMyServiceOrders: (params: { serviceId: string; page?: number; pageSize?: number; refresh?: boolean }) =>
      ipcRenderer.invoke('gigSquare:fetchMyServiceOrders', params),
    fetchRefunds: () => ipcRenderer.invoke('gigSquare:fetchRefunds'),
    processRefundOrder: (params: { orderId: string }) =>
      ipcRenderer.invoke('gigSquare:processRefundOrder', params),
    syncFromRemote: () => ipcRenderer.invoke('gigSquare:syncFromRemote'),
    fetchProviderInfo: (params: { providerMetaId?: string; providerGlobalMetaId?: string; providerAddress?: string }) =>
      ipcRenderer.invoke('gigSquare:fetchProviderInfo', params),
    preflightOrder: (params: { metabotId: number; toGlobalMetaId: string }) =>
      ipcRenderer.invoke('gigSquare:preflightOrder', params),
    publishService: (params: {
      metabotId: number;
      serviceName: string;
      displayName: string;
      description: string;
      executionReminder?: string;
      providerSkills?: string[];
      providerSkill?: string;
      paymentTiming?: 'free' | 'prepaid' | string;
      price: string;
      currency: string;
      protocolSettlementKind?: 'native' | 'fiat' | string;
      metadata?: string;
      mrc20Ticker?: string;
      mrc20Id?: string;
      outputType: string;
      serviceIconDataUrl?: string | null;
    }) => ipcRenderer.invoke('gigSquare:publishService', params),
    revokeService: (params: { serviceId: string }) =>
      ipcRenderer.invoke('gigSquare:revokeService', params),
    modifyService: (params: {
      serviceId: string;
      serviceName?: string;
      displayName?: string;
      description?: string;
      executionReminder?: string;
      providerSkills?: string[];
      providerSkill?: string;
      paymentTiming?: 'free' | 'prepaid' | string;
      price?: string;
      currency?: string;
      protocolSettlementKind?: 'native' | 'fiat' | string;
      metadata?: string;
      mrc20Ticker?: string;
      mrc20Id?: string;
      outputType?: string;
      serviceIconDataUrl?: string | null;
    }) => ipcRenderer.invoke('gigSquare:modifyService', params),
    createServiceOrderPin: (params: {
      metabotId: number;
      servicePinId?: string | null;
      paymentTxid?: string | null;
      price?: string | null;
      currency?: string | null;
      settlementKind?: string | null;
      metadata?: string | null;
    }) => ipcRenderer.invoke('gigSquare:createServiceOrderPin', params),
    sendOrder: (params: {
      metabotId: number;
      toGlobalMetaId: string;
      toChatPubkey: string;
      orderPayload: string;
      peerName?: string | null;
      peerAvatar?: string | null;
      serviceId?: string | null;
      servicePrice?: string | null;
      serviceCurrency?: string | null;
      servicePaymentChain?: string | null;
      serviceSettlementKind?: 'native' | 'mrc20' | string | null;
      serviceMrc20Ticker?: string | null;
      serviceMrc20Id?: string | null;
      servicePaymentCommitTxid?: string | null;
      serviceSkill?: string | null;
      serviceOutputType?: string | null;
      serverBotGlobalMetaId?: string | null;
      serviceOrderPinId?: string | null;
      servicePaidTx?: string | null;
    }) => ipcRenderer.invoke('gigSquare:sendOrder', params),
    pingProvider: (params: {
      metabotId: number;
      toGlobalMetaId: string;
      toChatPubkey: string;
      timeoutMs?: number;
    }) => ipcRenderer.invoke('gigSquare:pingProvider', params),
  },
  providerDiscovery: {
    getOnlineServices: () =>
      ipcRenderer.invoke('providerDiscovery:getOnlineServices'),
    getOnlineBots: () =>
      ipcRenderer.invoke('providerDiscovery:getOnlineBots'),
    getSnapshot: () =>
      ipcRenderer.invoke('providerDiscovery:getSnapshot'),
    onChanged: (callback: (data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('providerDiscovery:changed', handler);
      return () => ipcRenderer.removeListener('providerDiscovery:changed', handler);
    },
  },
  appEvents: {
    onOpenSettings: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('app:openSettings', handler);
      return () => ipcRenderer.removeListener('app:openSettings', handler);
    },
    onNewTask: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('app:newTask', handler);
      return () => ipcRenderer.removeListener('app:newTask', handler);
    },
  },
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    toggleMaximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    moveBy: (dx: number, dy: number) => ipcRenderer.send('window:move-by', { dx, dy }),
    showSystemMenu: (position: { x: number; y: number }) => ipcRenderer.send('window:showSystemMenu', position),
    onStateChanged: (callback: (state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => void) => {
      const handler = (_event: any, state: { isMaximized: boolean; isFullscreen: boolean; isFocused: boolean }) => callback(state);
      ipcRenderer.on('window:state-changed', handler);
      return () => ipcRenderer.removeListener('window:state-changed', handler);
    },
  },
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  checkApiConfig: () => ipcRenderer.invoke('check-api-config'),
  saveApiConfig: (config: { apiKey: string; baseURL: string; model: string; apiType?: 'anthropic' | 'openai' }) =>
    ipcRenderer.invoke('save-api-config', config),
  generateSessionTitle: (userInput: string | null) =>
    ipcRenderer.invoke('generate-session-title', userInput),
  getRecentCwds: (limit?: number) =>
    ipcRenderer.invoke('get-recent-cwds', limit),
  cowork: {
    // Session management
    startSession: (options: { prompt: string; cwd?: string; systemPrompt?: string; title?: string; activeSkillIds?: string[]; metabotId?: number | null; sessionType?: 'standard' | 'browser' }) =>
      ipcRenderer.invoke('cowork:session:start', options),
    continueSession: (options: { sessionId: string; prompt: string; systemPrompt?: string; activeSkillIds?: string[] }) =>
      ipcRenderer.invoke('cowork:session:continue', options),
    submitInput: (input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> =>
      ipcRenderer.invoke('cowork:session:submitInput', input),
    stopSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:stop', sessionId),
    endA2APrivateChat: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:endA2APrivateChat', sessionId),
    ensureA2ASession: (input: {
      actorId?: string | null;
      localMetabotId?: number | null;
      peerGlobalMetaId: string;
      peerName?: string | null;
      peerAvatar?: string | null;
    }) =>
      ipcRenderer.invoke('cowork:session:ensureA2A', input),
    queueA2AGuidance: (input: CoworkA2AGuidanceRequest) =>
      ipcRenderer.invoke('cowork:session:queueA2AGuidance', input),
    resendA2ADeliveryArtifact: (input: string | { sessionId: string; orderTxid?: string | null }) =>
      ipcRenderer.invoke('cowork:session:resendA2ADeliveryArtifact', input),
    archiveSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:archive', sessionId),
    unarchiveSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:unarchive', sessionId),
    setSessionPinned: (options: { sessionId: string; pinned: boolean }) =>
      ipcRenderer.invoke('cowork:session:pin', options),
    renameSession: (options: { sessionId: string; title: string }) =>
      ipcRenderer.invoke('cowork:session:rename', options),
    getSession: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:get', sessionId),
    listSessions: (options?: { metabotId?: number | null }) =>
      ipcRenderer.invoke('cowork:session:list', options),
    processServiceRefund: (sessionId: string) =>
      ipcRenderer.invoke('cowork:session:processServiceRefund', sessionId),
    readLocalImage: (options: { path: string; maxBytes?: number }) =>
      ipcRenderer.invoke('cowork:session:readLocalImage', options),
    exportResultImage: (options: { rect: { x: number; y: number; width: number; height: number }; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:exportResultImage', options),
    captureImageChunk: (options: { rect: { x: number; y: number; width: number; height: number } }) =>
      ipcRenderer.invoke('cowork:session:captureImageChunk', options),
    saveResultImage: (options: { pngBase64: string; defaultFileName?: string }) =>
      ipcRenderer.invoke('cowork:session:saveResultImage', options),
    downloadMetafile: (options: { url: string; fallbackUrl?: string; fileName?: string }) =>
      ipcRenderer.invoke('cowork:metafile:download', options),

    // Permission handling
    respondToPermission: (options: { requestId: string; result: any }) =>
      ipcRenderer.invoke('cowork:permission:respond', options),

    // Configuration
    getConfig: () =>
      ipcRenderer.invoke('cowork:config:get'),
    setConfig: (config: {
      workingDirectory?: string;
      executionMode?: 'auto' | 'local' | 'sandbox';
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
    }) =>
      ipcRenderer.invoke('cowork:config:set', config),
    listMemoryEntries: (input: {
      sessionId?: string;
      metabotId?: number;
      query?: string;
      status?: 'created' | 'stale' | 'deleted' | 'all';
      includeDeleted?: boolean;
      limit?: number;
      offset?: number;
    }) =>
      ipcRenderer.invoke('cowork:memory:listEntries', input),
    createMemoryEntry: (input: {
      sessionId?: string;
      metabotId?: number;
      text: string;
      confidence?: number;
      isExplicit?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:createEntry', input),
    updateMemoryEntry: (input: {
      sessionId?: string;
      metabotId?: number;
      id: string;
      text?: string;
      confidence?: number;
      status?: 'created' | 'stale' | 'deleted';
      isExplicit?: boolean;
    }) =>
      ipcRenderer.invoke('cowork:memory:updateEntry', input),
    deleteMemoryEntry: (input: { sessionId?: string; metabotId?: number; id: string }) =>
      ipcRenderer.invoke('cowork:memory:deleteEntry', input),
    getMemoryStats: (input?: { sessionId?: string; metabotId?: number }) =>
      ipcRenderer.invoke('cowork:memory:getStats', input),
    getMemoryPolicy: (input?: { sessionId?: string; metabotId?: number }) =>
      ipcRenderer.invoke('cowork:memory:getPolicy', input),
    setMemoryPolicy: (input: {
      metabotId: number;
      memoryEnabled?: boolean;
      memoryImplicitUpdateEnabled?: boolean;
      memoryLlmJudgeEnabled?: boolean;
      memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
      memoryUserMemoriesMaxItems?: number;
    }) =>
      ipcRenderer.invoke('cowork:memory:setPolicy', input),
    isDelegationBlocking: (sessionId: string) =>
      ipcRenderer.invoke('cowork:isDelegationBlocking', sessionId) as Promise<boolean>,
    getDelegationInfo: (sessionId: string) =>
      ipcRenderer.invoke('cowork:getDelegationInfo', sessionId) as Promise<{ orderId: string } | null>,
    getSandboxStatus: () =>
      ipcRenderer.invoke('cowork:sandbox:status'),
    installSandbox: () =>
      ipcRenderer.invoke('cowork:sandbox:install'),
    onSandboxDownloadProgress: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('cowork:sandbox:downloadProgress', handler);
      return () => ipcRenderer.removeListener('cowork:sandbox:downloadProgress', handler);
    },
    // Stream event listeners
    onStreamMessage: (callback: (data: { sessionId: string; message: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; message: any }) => callback(data);
      ipcRenderer.on('cowork:stream:message', handler);
      return () => ipcRenderer.removeListener('cowork:stream:message', handler);
    },
    onStreamMessageUpdate: (callback: (data: { sessionId: string; messageId: string; content?: string; metadata?: Record<string, unknown> }) => void) => {
      const handler = (_event: any, data: { sessionId: string; messageId: string; content?: string; metadata?: Record<string, unknown> }) => callback(data);
      ipcRenderer.on('cowork:stream:messageUpdate', handler);
      return () => ipcRenderer.removeListener('cowork:stream:messageUpdate', handler);
    },
    onStreamPermission: (callback: (data: { sessionId: string; request: any }) => void) => {
      const handler = (_event: any, data: { sessionId: string; request: any }) => callback(data);
      ipcRenderer.on('cowork:stream:permission', handler);
      return () => ipcRenderer.removeListener('cowork:stream:permission', handler);
    },
    onStreamComplete: (callback: (data: { sessionId: string; claudeSessionId: string | null }) => void) => {
      const handler = (_event: any, data: { sessionId: string; claudeSessionId: string | null }) => callback(data);
      ipcRenderer.on('cowork:stream:complete', handler);
      return () => ipcRenderer.removeListener('cowork:stream:complete', handler);
    },
    onStreamError: (callback: (data: { sessionId: string; error: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; error: string }) => callback(data);
      ipcRenderer.on('cowork:stream:error', handler);
      return () => ipcRenderer.removeListener('cowork:stream:error', handler);
    },
    onDelegationStateChange: (callback: (data: { sessionId: string; blocking: boolean; orderId?: string; message?: string }) => void) => {
      const handler = (_event: any, data: { sessionId: string; blocking: boolean; orderId?: string; message?: string }) => callback(data);
      ipcRenderer.on('cowork:delegation:stateChange', handler);
      return () => ipcRenderer.removeListener('cowork:delegation:stateChange', handler);
    },
  },
  dialog: {
    selectDirectory: () => ipcRenderer.invoke('dialog:selectDirectory'),
    selectFile: (options?: { title?: string; filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('dialog:selectFile', options),
    saveInlineFile: (options: { dataBase64: string; fileName?: string; mimeType?: string; cwd?: string }) =>
      ipcRenderer.invoke('dialog:saveInlineFile', options),
  },
  shell: {
    openPath: (filePath: string) => ipcRenderer.invoke('shell:openPath', filePath),
    showItemInFolder: (filePath: string) => ipcRenderer.invoke('shell:showItemInFolder', filePath),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
  autoLaunch: {
    get: () => ipcRenderer.invoke('app:getAutoLaunch'),
    set: (enabled: boolean) => ipcRenderer.invoke('app:setAutoLaunch', enabled),
  },
  feeRates: {
    getTiers: () => ipcRenderer.invoke('feeRates:getTiers') as Promise<Record<string, { title: string; desc: string; feeRate: number }[]>>,
    getSelected: () => ipcRenderer.invoke('feeRates:getSelected') as Promise<Record<string, string>>,
    select: (chain: string, tierTitle: string) => ipcRenderer.invoke('feeRates:select', chain, tierTitle) as Promise<{ success: boolean }>,
    refresh: () => ipcRenderer.invoke('feeRates:refresh') as Promise<Record<string, { title: string; desc: string; feeRate: number }[]>>,
  },
  appInfo: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getSystemLocale: () => ipcRenderer.invoke('app:getSystemLocale'),
  },
  startup: {
    rendererInitialized: () => ipcRenderer.invoke('startup:rendererInitialized') as Promise<{
      success: boolean;
      elapsedMs: number;
      startedAt: number;
    }>,
  },
  appUpdate: {
    download: (url: string) => ipcRenderer.invoke('appUpdate:download', url),
    cancelDownload: () => ipcRenderer.invoke('appUpdate:cancelDownload'),
    install: (filePath: string) => ipcRenderer.invoke('appUpdate:install', filePath),
    applySilent: (filePath: string) => ipcRenderer.invoke('appUpdate:applySilent', filePath),
    relaunchNow: () => ipcRenderer.invoke('appUpdate:relaunchNow'),
    onDownloadProgress: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('appUpdate:downloadProgress', handler);
      return () => ipcRenderer.removeListener('appUpdate:downloadProgress', handler);
    },
  },
  log: {
    getPath: () => ipcRenderer.invoke('log:getPath'),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
  },
  im: {
    // Configuration
    getConfig: () => ipcRenderer.invoke('im:config:get'),
    setConfig: (config: any) => ipcRenderer.invoke('im:config:set', config),

    // Gateway control
    startGateway: (platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord') => ipcRenderer.invoke('im:gateway:start', platform),
    stopGateway: (platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord') => ipcRenderer.invoke('im:gateway:stop', platform),
    testGateway: (
      platform: 'dingtalk' | 'feishu' | 'telegram' | 'discord',
      configOverride?: any
    ) => ipcRenderer.invoke('im:gateway:test', platform, configOverride),

    // Status
    getStatus: () => ipcRenderer.invoke('im:status:get'),

    // Event listeners
    onStatusChange: (callback: (status: any) => void) => {
      const handler = (_event: any, status: any) => callback(status);
      ipcRenderer.on('im:status:change', handler);
      return () => ipcRenderer.removeListener('im:status:change', handler);
    },
    onMessageReceived: (callback: (message: any) => void) => {
      const handler = (_event: any, message: any) => callback(message);
      ipcRenderer.on('im:message:received', handler);
      return () => ipcRenderer.removeListener('im:message:received', handler);
    },
  },
  scheduledTasks: {
    // Task CRUD
    list: () => ipcRenderer.invoke('scheduledTask:list'),
    get: (id: string) => ipcRenderer.invoke('scheduledTask:get', id),
    create: (input: any) => ipcRenderer.invoke('scheduledTask:create', input),
    update: (id: string, input: any) => ipcRenderer.invoke('scheduledTask:update', id, input),
    delete: (id: string) => ipcRenderer.invoke('scheduledTask:delete', id),
    toggle: (id: string, enabled: boolean) => ipcRenderer.invoke('scheduledTask:toggle', id, enabled),

    // Execution
    runManually: (id: string) => ipcRenderer.invoke('scheduledTask:runManually', id),
    stop: (id: string) => ipcRenderer.invoke('scheduledTask:stop', id),

    // Run history
    listRuns: (taskId: string, limit?: number, offset?: number) =>
      ipcRenderer.invoke('scheduledTask:listRuns', taskId, limit, offset),
    countRuns: (taskId: string) => ipcRenderer.invoke('scheduledTask:countRuns', taskId),
    listAllRuns: (limit?: number, offset?: number) =>
      ipcRenderer.invoke('scheduledTask:listAllRuns', limit, offset),

    // Stream event listeners
    onStatusUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('scheduledTask:statusUpdate', handler);
      return () => ipcRenderer.removeListener('scheduledTask:statusUpdate', handler);
    },
    onRunUpdate: (callback: (data: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on('scheduledTask:runUpdate', handler);
      return () => ipcRenderer.removeListener('scheduledTask:runUpdate', handler);
    },
  },
  idbots: {
    getMetaBots: () => ipcRenderer.invoke('idbots:getMetaBots'),
    getOfficialSkillsStatus: () => ipcRenderer.invoke('idbots:getOfficialSkillsStatus'),
    installOfficialSkill: (skill: { name: string; skillFileUri: string; remoteVersion: string; remoteCreator: string }) =>
      ipcRenderer.invoke('idbots:installOfficialSkill', skill),
    syncAllOfficialSkills: () => ipcRenderer.invoke('idbots:syncAllOfficialSkills'),
    getCommunitySkillsStatus: () => ipcRenderer.invoke('idbots:getCommunitySkillsStatus'),
    addMetaBot: (input: {
      name: string;
      avatar?: string | null;
      role: string;
      soul: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      allow_chat_skills?: string[];
      metabot_type?: 'twin' | 'worker';
    }) => ipcRenderer.invoke('idbots:addMetaBot', input),
    restoreMetaBotFromMnemonic: (input: { mnemonic: string; path?: string }) =>
      ipcRenderer.invoke('idbots:restoreMetaBotFromMnemonic', input),
    getAddressBalance: (options: { metabotId?: number; addresses?: { btc?: string; mvc?: string; doge?: string } }) =>
      ipcRenderer.invoke('idbots:getAddressBalance', options),
    getMetabotWalletAssets: (input: { metabotId: number }) =>
      ipcRenderer.invoke('idbots:getMetabotWalletAssets', input),
    getTransferFeeSummary: (chain: 'mvc' | 'doge' | 'btc') => ipcRenderer.invoke('idbots:getTransferFeeSummary', chain),
    getTokenTransferFeeSummary: (input: { kind: 'mrc20' | 'mvc-ft' }) =>
      ipcRenderer.invoke('idbots:getTokenTransferFeeSummary', input),
    buildTransferPreview: (params: {
      metabotId: number;
      chain: 'mvc' | 'doge' | 'btc';
      toAddress: string;
      amountSpaceOrDoge: string;
      feeRate: number;
    }) => ipcRenderer.invoke('idbots:buildTransferPreview', params),
    buildTokenTransferPreview: (params: {
      kind: 'mrc20' | 'mvc-ft';
      metabotId: number;
      asset: any;
      toAddress: string;
      amount: string;
      feeRate: number;
    }) => ipcRenderer.invoke('idbots:buildTokenTransferPreview', params),
    executeTransfer: (params: {
      metabotId: number;
      chain: 'mvc' | 'doge' | 'btc';
      toAddress: string;
      amountSpaceOrDoge: string;
      feeRate: number;
    }) => ipcRenderer.invoke('idbots:executeTransfer', params),
    executeTokenTransfer: (params: {
      kind: 'mrc20' | 'mvc-ft';
      metabotId: number;
      asset: any;
      toAddress: string;
      amount: string;
      feeRate: number;
    }) => ipcRenderer.invoke('idbots:executeTokenTransfer', params),
    getMetaBotMnemonic: (metabotId: number) => ipcRenderer.invoke('idbots:getMetaBotMnemonic', metabotId),
    deleteMetaBot: (metabotId: number) => ipcRenderer.invoke('idbots:deleteMetaBot', metabotId),
    syncMetaBot: (metabotId: number) => ipcRenderer.invoke('idbots:syncMetaBot', metabotId),
    syncMetaBotEditChanges: (input: {
      metabotId: number;
      syncName?: boolean;
      syncAvatar?: boolean;
      syncBio?: boolean;
      syncPersona?: boolean;
      syncLlm?: boolean;
      syncChatSkills?: boolean;
      syncHomepage?: boolean;
      syncOwner?: boolean;
    }) => ipcRenderer.invoke('idbots:syncMetaBotEditChanges', input),
    createMetaBotOnChain: (input: {
      name: string;
      avatar?: string | null;
      role?: string;
      soul?: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      fallback_llm_id?: string | null;
      allow_chat_skills?: string[];
      metabot_type?: 'twin' | 'worker';
      homepage?: string | null;
    }) => ipcRenderer.invoke('idbots:createMetaBotOnChain', input),
    uploadMetabotHomepageFile: (input: {
      metabotId: number;
      fileName: string;
      contentType?: string;
      base64: string;
      network?: string;
    }) => ipcRenderer.invoke('idbots:uploadMetabotHomepageFile', input),
  },
  userIdentity: {
    get: () => ipcRenderer.invoke('userIdentity:get'),
    create: (input: { name: string; avatar?: string | null }) =>
      ipcRenderer.invoke('userIdentity:create', input),
    importFromMnemonic: (input: { mnemonic: string; path?: string }) =>
      ipcRenderer.invoke('userIdentity:import', input),
    updateName: (input: { name: string }) => ipcRenderer.invoke('userIdentity:updateName', input),
    logout: () => ipcRenderer.invoke('userIdentity:logout'),
    revealMnemonic: () => ipcRenderer.invoke('userIdentity:revealMnemonic'),
    retryChainSync: () => ipcRenderer.invoke('userIdentity:retryChainSync'),
  },
  metaWebListener: {
    getListenerConfig: () => ipcRenderer.invoke('idbots:getListenerConfig'),
    getListenerStatus: () => ipcRenderer.invoke('idbots:getListenerStatus'),
    toggleListener: (payload: { type: 'enabled' | 'groupChats' | 'privateChats' | 'serviceRequests' | 'respondToStrangerPrivateChats'; enabled: boolean }) =>
      ipcRenderer.invoke('idbots:toggleListener', payload),
    startMetaWebListener: () => ipcRenderer.invoke('idbots:startMetaWebListener'),
    onListenerLog: (callback: (log: string) => void) => {
      const handler = (_event: unknown, log: string) => callback(log);
      ipcRenderer.on('idbots:listener-log', handler);
      return () => ipcRenderer.removeListener('idbots:listener-log', handler);
    },
    assignGroupChatTask: (params: import('./services/assignGroupChatTaskService').AssignGroupChatTaskParams) =>
      ipcRenderer.invoke('idbots:assignGroupChatTask', params),
  },
  metabot: {
    list: () => ipcRenderer.invoke('metabot:list'),
    get: (id: number) => ipcRenderer.invoke('metabot:get', id),
    create: (input: {
      name: string;
      avatar?: string | null;
      metabot_type: 'twin' | 'worker';
      role: string;
      soul: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      llm_id?: string | null;
    }) => ipcRenderer.invoke('metabot:create', input),
    update: (id: number, input: {
      name?: string;
      avatar?: string | null;
      enabled?: boolean;
      metabot_type?: 'twin' | 'worker';
      role?: string;
      soul?: string;
      goal?: string | null;
      bio?: string | null;
      /** Deprecated compatibility input; use bio. */
      background?: string | null;
      boss_id?: number | null;
      boss_global_metaid?: string | null;
      llm_id?: string | null;
      fallback_llm_id?: string | null;
      homepage?: string | null;
    }) => ipcRenderer.invoke('metabot:update', id, input),
    setEnabled: (id: number, enabled: boolean) => ipcRenderer.invoke('metabot:setEnabled', id, enabled),
    checkNameExists: (options: { name: string; excludeId?: number }) =>
      ipcRenderer.invoke('metabot:checkNameExists', options),
  },
  dream: {
    getStatus: () => ipcRenderer.invoke('dream:getStatus'),
    listDailySummaries: (options: { metabotId: number; limit?: number; offset?: number }) =>
      ipcRenderer.invoke('dream:listDailySummaries', options),
    runNow: (options: { metabotId: number; date?: string }) =>
      ipcRenderer.invoke('dream:runNow', options),
    onStatusChanged: (callback: (payload: { metabotId: number; dreaming: boolean }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { metabotId: number; dreaming: boolean }) => callback(payload);
      ipcRenderer.on('metabot:dreamStatusChanged', handler);
      return () => ipcRenderer.removeListener('metabot:dreamStatusChanged', handler);
    },
  },
  networkStatus: {
    send: (status: 'online' | 'offline') => ipcRenderer.send('network:status-change', status),
  },
  p2p: {
    getStatus: () => ipcRenderer.invoke('p2p:getStatus'),
    getConfig: () => ipcRenderer.invoke('p2p:getConfig'),
    setConfig: (config: unknown) => ipcRenderer.invoke('p2p:setConfig', config),
    getPeers: () => ipcRenderer.invoke('p2p:getPeers'),
    getUserInfo: (params: { globalMetaId: string }) =>
      ipcRenderer.invoke('metaid:getUserInfo', params),
    resolveAvatarSource: (params: { reference: string }) =>
      ipcRenderer.invoke('metaid:resolveAvatarSource', params),
    onStatusUpdate: (callback: (status: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
      ipcRenderer.on('p2p:statusUpdate', handler);
      return () => ipcRenderer.removeListener('p2p:statusUpdate', handler);
    },
    onSyncProgress: (callback: (data: unknown) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('p2p:syncProgress', handler);
      return () => ipcRenderer.removeListener('p2p:syncProgress', handler);
    },
  },
});
