import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from './store';
import Settings, { type SettingsOpenOptions } from './components/Settings';
import Sidebar from './components/Sidebar';
import Toast from './components/Toast';
import WindowTitleBar from './components/window/WindowTitleBar';
import { CoworkView } from './components/cowork';
import { MetaAppsView } from './components/metaapps';
import { SkillsView } from './components/skills';
import { ScheduledTasksView } from './components/scheduledTasks';
import { GroupTasksView, NewGroupTaskModal } from './components/groupTasks';
import MetabotsView from './components/metabots/MetabotsView';
import GigSquareView from './components/gigSquare/GigSquareView';
import CoworkPermissionModal from './components/cowork/CoworkPermissionModal';
import CoworkQuestionWizard from './components/cowork/CoworkQuestionWizard';
import { configService } from './services/config';
import { apiService } from './services/api';
import { themeService } from './services/theme';
import { coworkService } from './services/cowork';
import { scheduledTaskService } from './services/scheduledTask';
import { groupTaskService } from './services/groupTaskService';
import { checkForAppUpdate, type AppUpdateInfo, type AppUpdateDownloadProgress, UPDATE_POLL_INTERVAL_MS, UPDATE_HEARTBEAT_INTERVAL_MS } from './services/appUpdate';
import { defaultConfig, type ModelOptions } from './config';
import { setAvailableModels, setSelectedModel } from './store/slices/modelSlice';
import { clearSelection } from './store/slices/quickActionSlice';
import { setActiveSkillIds } from './store/slices/skillSlice';
import { selectTask as selectGroupTask } from './store/slices/groupTasksSlice';
import type { ApiConfig } from './services/api';
import type { CoworkPermissionResult } from './types/cowork';
import type { MetaAppRecord } from './types/metaApp';
import type { GroupTaskDetail } from './types/groupTask';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from './services/i18n';
import { matchesShortcut } from './services/shortcuts';
import { metaAppService } from './services/metaApp';
import AppUpdateBadge from './components/update/AppUpdateBadge';
import AppUpdateModal, { type UpdateModalState } from './components/update/AppUpdateModal';
import Onboarding from './components/onboarding/Onboarding';
import { openSelectedMetaApp } from './components/metaapps/metaAppLaunch.js';
import { shouldShowInitialOnboarding } from './components/onboarding/onboardingGate.js';
import { normalizePreselectedSkillId } from './utils/newChatPreselect';
import {
  clampSidebarWidth,
  defaultSidebarWidth,
  loadSidebarWidth,
  sidebarWidthStorageKey,
  type SidebarWidthMode,
} from './utils/sidebarWidth';
import { BotBrowserSurface } from './features/botBrowser/BotBrowserSurface';
import { useBotBrowserShell } from './features/botBrowser/useBotBrowserShell';
import { openBotBrowserConversationInCowork } from './features/botBrowser/conversationNavigationAdapter';
import type { BotBrowserConversationRequest } from './features/botBrowser/types';
import SidebarToggleIcon from './components/icons/SidebarToggleIcon';

type FocusedOrderTarget = {
  sessionId: string;
  orderTxid: string;
};

const normalizeFocusedOrderTxid = (value: unknown): string | null => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
};

// 应用更新阶段：idle=无更新或静默下载失败（徽章保底可见）；downloading/applying=静默后台处理中（无 UI）；
// ready=已下载待安装；restartReady=macOS 已静默替换待重启
type UpdatePhase = 'idle' | 'downloading' | 'ready' | 'applying' | 'restartReady';

const App: React.FC = () => {
  const [showSettings, setShowSettings] = useState(false);
  const [settingsOptions, setSettingsOptions] = useState<SettingsOpenOptions>({});
  const [mainView, setMainView] = useState<'cowork' | 'metaapps' | 'skills' | 'scheduledTasks' | 'groupTasks' | 'metabots' | 'gigSquare'>('cowork');
  const [isInitialized, setIsInitialized] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [isNewGroupTaskOpen, setIsNewGroupTaskOpen] = useState(false);
  const [, forceLanguageRefresh] = useState(0);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadSidebarWidth((key) => window.localStorage.getItem(key), 'home'));
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number; mode: SidebarWidthMode } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  const [updateModalState, setUpdateModalState] = useState<UpdateModalState>('info');
  const [downloadProgress, setDownloadProgress] = useState<AppUpdateDownloadProgress | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updatePhase, setUpdatePhaseState] = useState<UpdatePhase>('idle');
  const updatePhaseRef = useRef<UpdatePhase>('idle');
  const downloadedUpdateFileRef = useRef<{ version: string; filePath: string } | null>(null);
  const changeUpdatePhase = useCallback((phase: UpdatePhase) => {
    updatePhaseRef.current = phase;
    setUpdatePhaseState(phase);
  }, []);
  const [focusedOrderTarget, setFocusedOrderTarget] = useState<FocusedOrderTarget | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const mockUpdateModeRef = useRef(false);
  const mockDownloadTimerRef = useRef<number | null>(null);
  const mockInstallTimerRef = useRef<number | null>(null);
  const openingMetaAppIdsRef = useRef<Set<string>>(new Set());
  const hasInitialized = useRef(false);
  const dispatch = useDispatch();
  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const pendingPermission = pendingPermissions[0] ?? null;
  const isWindows = window.electron.platform === 'win32';
  const isMac = window.electron.platform === 'darwin';
  const focusedOrderTxid = focusedOrderTarget?.sessionId === currentSessionId
    ? focusedOrderTarget.orderTxid
    : null;
  const handleFocusedOrderConsumed = useCallback((orderTxid: string) => {
    const normalizedOrderTxid = normalizeFocusedOrderTxid(orderTxid);
    if (!normalizedOrderTxid) return;
    setFocusedOrderTarget((current) => (
      current?.sessionId === currentSessionId && current.orderTxid === normalizedOrderTxid
        ? null
        : current
    ));
  }, [currentSessionId]);

  const reportRendererStartupComplete = useCallback(async () => {
    try {
      await window.electron.startup.rendererInitialized();
    } catch (error) {
      console.warn('[Startup] Failed to report renderer initialization:', error);
    }
  }, []);

  const clearMockTimers = useCallback(() => {
    if (mockDownloadTimerRef.current != null) {
      window.clearInterval(mockDownloadTimerRef.current);
      mockDownloadTimerRef.current = null;
    }
    if (mockInstallTimerRef.current != null) {
      window.clearTimeout(mockInstallTimerRef.current);
      mockInstallTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      clearMockTimers();
    };
  }, [clearMockTimers]);

  useEffect(() => {
    if (!isInitialized) return;
    const config = configService.getConfig();
    if (!config.app.isDevelopment) return;
    if (!window.location.search.includes('mockUpdate=1')) return;

    mockUpdateModeRef.current = true;

    const mockInfo: AppUpdateInfo = {
      latestVersion: '9.9.9',
      date: '2026-03-11',
      changeLog: {
        zh: {
          title: '更新内容',
          content: ['优化更新流程展示', '修复若干稳定性问题'],
        },
        en: {
          title: 'Changes',
          content: ['Improve update flow preview', 'Fix stability issues'],
        },
      },
      url: 'https://idbots.ai/downloads/IDBots-latest',
    };

    setUpdateInfo(mockInfo);
    setUpdateError(null);
    setDownloadProgress(null);
    // 模拟静默下载已完成：Windows 进入待安装，macOS 进入待重启；点击徽章打开对应弹窗
    downloadedUpdateFileRef.current = { version: mockInfo.latestVersion, filePath: '/tmp/mock-idbots-update' };
    changeUpdatePhase(window.electron.platform === 'darwin' ? 'restartReady' : 'ready');
  }, [isInitialized, changeUpdatePhase]);

  // 初始化应用
  useEffect(() => {
    if (hasInitialized.current) {
      return;
    }
    hasInitialized.current = true;

    const initializeApp = async () => {
      try {
        // 标记平台，用于 CSS 条件样式（如 Windows 标题栏按钮区域留白）
        document.documentElement.classList.add(`platform-${window.electron.platform}`);

        // 初始化配置
        await configService.init();
        
        // 初始化主题
        themeService.initialize();

        // 初始化语言
        await i18nService.initialize();
        
        const config = await configService.getConfig();
        
        const apiConfig: ApiConfig = {
          apiKey: config.api.key,
          baseUrl: config.api.baseUrl,
        };
        apiService.setConfig(apiConfig);

        // 从 providers 配置中加载可用模型列表到 Redux
        const providerModels: { id: string; name: string; provider?: string; supportsImage?: boolean; options?: ModelOptions }[] = [];
        if (config.providers) {
          Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
            if (providerConfig.enabled && providerConfig.models) {
              providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean; options?: ModelOptions }) => {
                providerModels.push({
                  id: model.id,
                  name: model.name,
                  provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
                  supportsImage: model.supportsImage ?? false,
                  options: model.options,
                });
              });
            }
          });
        }
        const fallbackModels = config.model.availableModels.map(model => ({
          id: model.id,
          name: model.name,
          supportsImage: model.supportsImage ?? false,
          options: model.options,
        }));
        const resolvedModels = providerModels.length > 0 ? providerModels : fallbackModels;
        if (resolvedModels.length > 0) {
          dispatch(setAvailableModels(resolvedModels));
          const preferredModel = resolvedModels.find(model => model.id === config.model.defaultModel) ?? resolvedModels[0];
          dispatch(setSelectedModel(preferredModel));
        }
        
        // 初始化定时任务服务
        await scheduledTaskService.init();
        await groupTaskService.init();

        // Onboarding visibility: only first-run users without local MetaBots
        // should land in onboarding. Existing users must enter the app directly,
        // even if their current LLM config is empty or needs migration.
        let metabotCount = 0;
        try {
          const metabotResult = await window.electron.metabot.list();
          if (metabotResult?.success && Array.isArray(metabotResult.list)) {
            metabotCount = metabotResult.list.length;
          }
        } catch {
          metabotCount = 0;
        }
        setShowOnboarding(shouldShowInitialOnboarding(metabotCount));
        setIsInitialized(true);
        void reportRendererStartupComplete();
      } catch (error) {
        console.error('Failed to initialize app:', error);
        setInitError(i18nService.t('initializationError'));
        setIsInitialized(true);
        void reportRendererStartupComplete();
      }
    };

    initializeApp();
  }, []);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      forceLanguageRefresh((prev) => prev + 1);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = () => {
      window.electron.networkStatus.send('online');
    };

    const handleOffline = () => {
      window.electron.networkStatus.send('offline');
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const handleOnboardingComplete = useCallback(() => {
    const config = configService.getConfig();
    apiService.setConfig({ apiKey: config.api.key, baseUrl: config.api.baseUrl });
    if (config.providers) {
      const allModels: { id: string; name: string; provider?: string; supportsImage?: boolean; options?: ModelOptions }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean; options?: ModelOptions }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
              supportsImage: model.supportsImage ?? false,
              options: model.options,
            });
          });
        }
      });
      if (allModels.length > 0) {
        dispatch(setAvailableModels(allModels));
        const preferred = allModels.find((m) => m.id === config.model.defaultModel) ?? allModels[0];
        dispatch(setSelectedModel(preferred));
      }
    }
    setMainView('cowork');
    setShowOnboarding(false);
  }, [dispatch]);

  const handleOpenOnboarding = useCallback(() => {
    setMainView('cowork');
    setShowOnboarding(true);
  }, []);

  const handleCloseOnboarding = useCallback(() => {
    setMainView('cowork');
    setShowOnboarding(false);
  }, []);

  useEffect(() => {
    if (!isInitialized || !selectedModel?.id) return;
    const config = configService.getConfig();
    if (config.model.defaultModel === selectedModel.id) return;
    void configService.updateConfig({
      model: {
        ...config.model,
        defaultModel: selectedModel.id,
      },
    });
  }, [isInitialized, selectedModel?.id]);

  const handleShowSettings = useCallback((options?: SettingsOpenOptions) => {
    setSettingsOptions({
      initialTab: options?.initialTab,
      notice: options?.notice,
    });
    setShowSettings(true);
  }, []);

  const handleShowSkills = useCallback(() => {
    setMainView('skills');
  }, []);

  const handleShowMetaApps = useCallback(() => {
    setMainView('metaapps');
  }, []);

  const handleShowCowork = useCallback(() => {
    setMainView('cowork');
  }, []);

  const handleShowScheduledTasks = useCallback(() => {
    setMainView('scheduledTasks');
  }, []);

  const handleShowGroupTasks = useCallback(() => {
    setMainView('groupTasks');
  }, []);

  const handleNewGroupTask = useCallback(() => {
    setIsNewGroupTaskOpen(true);
  }, []);

  const handleGroupTaskCreated = useCallback((task: GroupTaskDetail) => {
    setIsNewGroupTaskOpen(false);
    setMainView('groupTasks');
    dispatch(selectGroupTask(task.id));
  }, [dispatch]);

  const handleShowGigSquare = useCallback(() => {
    setMainView('gigSquare');
  }, []);

  const handleShowMetabots = useCallback(() => {
    setMainView('metabots');
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarCollapsed((prev) => !prev);
  }, []);

  useEffect(() => {
    if (!isSidebarResizing) return;
    const handleMove = (event: MouseEvent) => {
      const start = sidebarResizeRef.current;
      if (!start) return;
      setSidebarWidth(clampSidebarWidth(start.startWidth + event.clientX - start.startX));
    };
    const handleUp = () => {
      const start = sidebarResizeRef.current;
      setIsSidebarResizing(false);
      sidebarResizeRef.current = null;
      setSidebarWidth((width) => {
        window.localStorage.setItem(sidebarWidthStorageKey(start?.mode ?? 'home'), String(width));
        return width;
      });
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
  }, [isSidebarResizing]);

  const handleNewChat = useCallback((preselectSkillId?: unknown) => {
    const shouldClearInput = mainView === 'cowork' || !!currentSessionId;
    const normalizedPreselectSkillId = normalizePreselectedSkillId(preselectSkillId);
    coworkService.clearSession();
    dispatch(clearSelection());
    if (normalizedPreselectSkillId) {
      dispatch(setActiveSkillIds([normalizedPreselectSkillId]));
    }
    setMainView('cowork');
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('cowork:focus-input', {
        detail: { clear: shouldClearInput },
      }));
    }, 0);
  }, [dispatch, mainView, currentSessionId]);

  const handleBlankNewChat = useCallback(() => {
    handleNewChat();
  }, [handleNewChat]);

  const handleStartTaskWithMetaApp = useCallback(async (app: MetaAppRecord) => {
    if (openingMetaAppIdsRef.current.has(app.id)) {
      return;
    }

    openingMetaAppIdsRef.current.add(app.id);
    try {
      await openSelectedMetaApp({ app, metaAppService });
    } finally {
      openingMetaAppIdsRef.current.delete(app.id);
    }
  }, []);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToastMessage(null);
      toastTimerRef.current = null;
    }, 2200);
  }, []);

  const botBrowserShell = useBotBrowserShell({
    showToast,
  });

  const handleSidebarResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: sidebarWidth,
      mode: botBrowserShell.surfaceMode,
    };
    setIsSidebarResizing(true);
  }, [sidebarWidth, botBrowserShell.surfaceMode]);

  const handleSidebarResizeReset = useCallback(() => {
    const mode = botBrowserShell.surfaceMode;
    const width = defaultSidebarWidth(mode);
    setSidebarWidth(width);
    window.localStorage.setItem(sidebarWidthStorageKey(mode), String(width));
  }, [botBrowserShell.surfaceMode]);

  // Bot Home and Bot Browser keep independent widths: restore the surface's own
  // comfortable width on every mode switch.
  useEffect(() => {
    setSidebarWidth(loadSidebarWidth((key) => window.localStorage.getItem(key), botBrowserShell.surfaceMode));
  }, [botBrowserShell.surfaceMode]);

  useEffect(() => {
    return window.electron.botBrowser.onOpenUri((input) => {
      void botBrowserShell.openUri(input);
    });
  }, [botBrowserShell.openUri]);

  // In-renderer requests (e.g. clickable metaid:// metaapp:// links in the
  // Co-Work panel) ride a DOM event to reach the shell.
  useEffect(() => {
    const handler = (event: Event) => {
      const uri = (event as CustomEvent<{ uri?: unknown }>).detail?.uri;
      if (typeof uri === 'string' && uri.trim()) {
        void botBrowserShell.openUri({ uri: uri.trim() });
      }
    };
    window.addEventListener('botBrowser:openUri', handler);
    return () => window.removeEventListener('botBrowser:openUri', handler);
  }, [botBrowserShell.openUri]);

  useEffect(() => {
    return window.electron.botBrowser.onTabCommand(({ requestId, command }) => {
      void botBrowserShell.controlTabs(command).then(
        (result) => {
          window.electron.botBrowser.respondToTabCommand({
            requestId,
            success: true,
            result,
          });
        },
        (error) => {
          window.electron.botBrowser.respondToTabCommand({
            requestId,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    });
  }, [botBrowserShell.controlTabs]);

  const handleShowLogin = useCallback(() => {
    showToast(i18nService.t('featureInDevelopment'));
  }, [showToast]);

  const startSilentDownload = useCallback(async (info: AppUpdateInfo) => {
    changeUpdatePhase('downloading');
    try {
      const downloadResult = await window.electron.appUpdate.download(info.url);
      if (!downloadResult.success || !downloadResult.filePath) {
        // 静默下载失败：保留 updateInfo，徽章显示「有新版本」，用户可点击走手动下载保底流程
        console.warn('[AppUpdate] Silent download failed:', downloadResult.error);
        changeUpdatePhase('idle');
        return;
      }
      downloadedUpdateFileRef.current = { version: info.latestVersion, filePath: downloadResult.filePath };

      if (window.electron.platform === 'darwin') {
        changeUpdatePhase('applying');
        try {
          const applyResult = await window.electron.appUpdate.applySilent(downloadResult.filePath);
          if (applyResult.success) {
            changeUpdatePhase('restartReady');
            return;
          }
          // 权限不足等原因：保留本地下载文件，回退为点击安装（提权）流程
          console.warn('[AppUpdate] Silent apply failed:', applyResult.error);
        } catch (applyError) {
          console.warn('[AppUpdate] Silent apply error:', applyError);
        }
      }
      changeUpdatePhase('ready');
    } catch (error) {
      console.warn('[AppUpdate] Silent download error:', error);
      changeUpdatePhase('idle');
    }
  }, [changeUpdatePhase]);

  const runUpdateCheck = useCallback(async () => {
    if (mockUpdateModeRef.current) {
      return;
    }
    const phase = updatePhaseRef.current;
    // 静默下载/替换进行中，或已替换待重启时，不再重复检查
    if (phase === 'downloading' || phase === 'applying' || phase === 'restartReady') {
      return;
    }
    try {
      const currentVersion = await window.electron.appInfo.getVersion();
      const nextUpdate = await checkForAppUpdate(currentVersion);
      if (!nextUpdate) {
        // 服务器端无更新：仅在本地没有待处理的已下载更新时清理提示
        if (!downloadedUpdateFileRef.current) {
          setUpdateInfo(null);
          setShowUpdateModal(false);
        }
        return;
      }
      if (downloadedUpdateFileRef.current?.version === nextUpdate.latestVersion) {
        return;
      }
      setUpdateInfo(nextUpdate);
      void startSilentDownload(nextUpdate);
    } catch (error) {
      console.error('Failed to check app update:', error);
    }
  }, [startSilentDownload]);

  const handleOpenUpdateModal = useCallback(() => {
    if (!updateInfo) return;
    setUpdateModalState(updatePhase === 'restartReady' ? 'restart' : 'info');
    setUpdateError(null);
    setDownloadProgress(null);
    setShowUpdateModal(true);
  }, [updateInfo, updatePhase]);

  const handleConfirmUpdate = useCallback(async () => {
    if (!updateInfo) return;

    if (mockUpdateModeRef.current) {
      setShowUpdateModal(false);
      return;
    }

    // macOS 静默替换已完成：用户确认后重启进入新版本
    if (updateModalState === 'restart') {
      await window.electron.appUpdate.relaunchNow();
      return;
    }

    const downloadedFile = downloadedUpdateFileRef.current?.version === updateInfo.latestVersion
      ? downloadedUpdateFileRef.current.filePath
      : null;

    if (downloadedFile) {
      // 更新包已在本地：直接安装（mac 提权安装后自动重启 / Windows 退出后运行安装器）
      setUpdateModalState('installing');
      setUpdateError(null);
      try {
        const installResult = await window.electron.appUpdate.install(downloadedFile);
        if (!installResult.success) {
          setUpdateModalState('error');
          setUpdateError(installResult.error || i18nService.t('updateInstallFailed'));
        }
      } catch (error) {
        setUpdateModalState('error');
        setUpdateError(error instanceof Error ? error.message : i18nService.t('updateInstallFailed'));
      }
      return;
    }

    // 保底路径：静默下载曾失败，走带进度提示的手动下载
    setUpdateModalState('downloading');
    setDownloadProgress(null);
    setUpdateError(null);

    const unsubscribe = window.electron.appUpdate.onDownloadProgress((progress) => {
      setDownloadProgress(progress);
    });

    try {
      const downloadResult = await window.electron.appUpdate.download(updateInfo.url);
      unsubscribe();

      if (!downloadResult.success) {
        if (downloadResult.error === 'Download cancelled') {
          return;
        }
        setUpdateModalState('error');
        setUpdateError(downloadResult.error || i18nService.t('updateDownloadFailed'));
        return;
      }

      if (downloadResult.filePath) {
        downloadedUpdateFileRef.current = { version: updateInfo.latestVersion, filePath: downloadResult.filePath };
      }

      setUpdateModalState('installing');
      const installResult = await window.electron.appUpdate.install(downloadResult.filePath!);

      if (!installResult.success) {
        setUpdateModalState('error');
        setUpdateError(installResult.error || i18nService.t('updateInstallFailed'));
      }
    } catch (error) {
      unsubscribe();
      const msg = error instanceof Error ? error.message : '';
      if (msg === 'Download cancelled') {
        return;
      }
      setUpdateModalState('error');
      setUpdateError(msg || i18nService.t('updateDownloadFailed'));
    }
  }, [updateInfo, updateModalState]);

  const handleCancelDownload = useCallback(async () => {
    await window.electron.appUpdate.cancelDownload();
    setUpdateModalState('info');
    setDownloadProgress(null);
  }, []);

  const handleRetryUpdate = useCallback(() => {
    setUpdateModalState('info');
    setUpdateError(null);
    setDownloadProgress(null);
  }, []);

  const handlePermissionResponse = useCallback(async (result: CoworkPermissionResult) => {
    if (!pendingPermission) return;
    await coworkService.respondToPermission(pendingPermission.requestId, result);
  }, [pendingPermission]);

  const handleBrowserOpenConversation = useCallback(async (request: BotBrowserConversationRequest) => {
    await openBotBrowserConversationInCowork(request, {
      switchToHome: botBrowserShell.switchToHome,
      showCowork: handleShowCowork,
      showToast,
    });
  }, [botBrowserShell.switchToHome, handleShowCowork, showToast]);

  const handleCloseSettings = () => {
    setShowSettings(false);
    window.dispatchEvent(new CustomEvent('app:settingsClosed'));
    const config = configService.getConfig();
    apiService.setConfig({
      apiKey: config.api.key,
      baseUrl: config.api.baseUrl,
    });

    if (config.providers) {
      const allModels: { id: string; name: string; provider?: string; supportsImage?: boolean; options?: ModelOptions }[] = [];
      Object.entries(config.providers).forEach(([providerName, providerConfig]) => {
        if (providerConfig.enabled && providerConfig.models) {
          providerConfig.models.forEach((model: { id: string; name: string; supportsImage?: boolean; options?: ModelOptions }) => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
              supportsImage: model.supportsImage ?? false,
              options: model.options,
            });
          });
        }
      });
      if (allModels.length > 0) {
        dispatch(setAvailableModels(allModels));
      }
    }
  };

  const isShortcutInputActive = () => {
    const activeElement = document.activeElement;
    if (!(activeElement instanceof HTMLElement)) return false;
    return activeElement.dataset.shortcutInput === 'true';
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isShortcutInputActive()) return;

      const { shortcuts } = configService.getConfig();
      const activeShortcuts = {
        ...defaultConfig.shortcuts,
        ...(shortcuts ?? {}),
      };

      if (matchesShortcut(event, activeShortcuts.newChat)) {
        event.preventDefault();
        handleBlankNewChat();
        return;
      }

      if (matchesShortcut(event, activeShortcuts.search)) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('cowork:shortcut:search'));
        return;
      }

      if (matchesShortcut(event, activeShortcuts.settings)) {
        event.preventDefault();
        handleShowSettings();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleShowSettings, handleBlankNewChat]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Listen for toast events from child components
  useEffect(() => {
    const handler = (e: Event) => {
      const message = (e as CustomEvent<string>).detail;
      if (message) showToast(message);
    };
    window.addEventListener('app:showToast', handler);
    return () => window.removeEventListener('app:showToast', handler);
  }, [showToast]);

  // 监听托盘菜单打开设置的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.appEvents.onOpenSettings(() => {
      handleShowSettings();
    });
    return unsubscribe;
  }, [handleShowSettings]);

  // 监听托盘菜单新建任务的 IPC 事件
  useEffect(() => {
    const unsubscribe = window.electron.appEvents.onNewTask(() => {
      handleBlankNewChat();
    });
    return unsubscribe;
  }, [handleBlankNewChat]);

  // 监听定时任务查看会话事件
  useEffect(() => {
    const handleViewSession = async (event: Event) => {
      const { sessionId } = (event as CustomEvent).detail;
      if (sessionId) {
        setFocusedOrderTarget(null);
        setMainView('cowork');
        await coworkService.loadSession(sessionId);
      }
    };
    window.addEventListener('scheduledTask:viewSession', handleViewSession);
    return () => window.removeEventListener('scheduledTask:viewSession', handleViewSession);
  }, []);

  useEffect(() => {
    const handleViewSession = async (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {};
      const sessionId = typeof detail.sessionId === 'string' ? detail.sessionId.trim() : '';
      const orderTxid = normalizeFocusedOrderTxid(detail.focusedOrderTxid ?? detail.orderTxid);
      if (sessionId) {
        setFocusedOrderTarget(orderTxid ? { sessionId, orderTxid } : null);
        setMainView('cowork');
        await coworkService.loadSession(sessionId);
      }
    };
    window.addEventListener('cowork:viewSession', handleViewSession);
    return () => window.removeEventListener('cowork:viewSession', handleViewSession);
  }, []);

  useEffect(() => {
    if (!isInitialized) return;

    let cancelled = false;
    let lastCheckTime = 0;

    const maybeCheck = async () => {
      if (cancelled) return;
      const now = Date.now();
      if (lastCheckTime > 0 && now - lastCheckTime < UPDATE_POLL_INTERVAL_MS) return;
      lastCheckTime = now;
      await runUpdateCheck();
    };

    void maybeCheck();

    const timer = window.setInterval(() => {
      void maybeCheck();
    }, UPDATE_HEARTBEAT_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void maybeCheck();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isInitialized, runUpdateCheck]);

  // 根据场景选择使用哪个权限组件
  const permissionModal = useMemo(() => {
    if (!pendingPermission) return null;

    // 检查是否为 AskUserQuestion 且有多个问题 -> 使用向导式组件
    const isQuestionTool = pendingPermission.toolName === 'AskUserQuestion';
    if (isQuestionTool && pendingPermission.toolInput) {
      const rawQuestions = (pendingPermission.toolInput as Record<string, unknown>).questions;
      const hasMultipleQuestions = Array.isArray(rawQuestions) && rawQuestions.length > 1;

      if (hasMultipleQuestions) {
        return (
          <CoworkQuestionWizard
            permission={pendingPermission}
            onRespond={handlePermissionResponse}
          />
        );
      }
    }

    // 其他情况使用原有的权限模态框
    return (
      <CoworkPermissionModal
        permission={pendingPermission}
        onRespond={handlePermissionResponse}
      />
    );
  }, [pendingPermission, handlePermissionResponse]);

  const isOverlayActive = showSettings || showUpdateModal || pendingPermissions.length > 0;
  // 静默下载/静默替换进行中不显示任何更新 UI；就绪或待重启时才显示徽章
  const updateBadge = updateInfo && updatePhase !== 'downloading' && updatePhase !== 'applying' ? (
    <AppUpdateBadge
      latestVersion={updateInfo.latestVersion}
      label={updatePhase === 'restartReady' ? i18nService.t('updateReadyPill') : undefined}
      onClick={handleOpenUpdateModal}
    />
  ) : null;
  const windowsStandaloneTitleBar = isWindows ? (
    <div className="draggable relative h-9 shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      <WindowTitleBar isOverlayActive={isOverlayActive} />
    </div>
  ) : null;

  if (!isInitialized) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-4">
            <div className="w-16 h-16 rounded-full bg-gradient-to-br from-claude-accent to-claude-accentHover flex items-center justify-center shadow-glow-accent animate-pulse">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="w-24 h-1 rounded-full bg-claude-accent/20 overflow-hidden">
              <div className="h-full w-1/2 rounded-full bg-claude-accent animate-shimmer" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium">{i18nService.t('loading')}</div>
          </div>
        </div>
      </div>
    );
  }

  if (initError) {
    return (
      <div className="h-screen overflow-hidden flex flex-col">
        {windowsStandaloneTitleBar}
        <div className="flex-1 flex flex-col items-center justify-center dark:bg-claude-darkBg bg-claude-bg">
          <div className="flex flex-col items-center space-y-6 max-w-md px-6">
            <div className="w-16 h-16 rounded-full bg-red-500 flex items-center justify-center shadow-lg">
              <ChatBubbleLeftRightIcon className="h-8 w-8 text-white" />
            </div>
            <div className="dark:text-claude-darkText text-claude-text text-xl font-medium text-center">{initError}</div>
            <button
              onClick={() => handleShowSettings()}
              className="btn-idchat-primary px-6 py-2.5 text-sm font-medium"
            >
              {i18nService.t('openSettings')}
            </button>
          </div>
          {showSettings && (
            <Settings
              onClose={handleCloseSettings}
              initialTab={settingsOptions.initialTab}
              notice={settingsOptions.notice}
            />
          )}
        </div>
      </div>
    );
  }

  if (showOnboarding) {
    return <Onboarding onComplete={handleOnboardingComplete} onClose={handleCloseOnboarding} />;
  }

  const homeContent = mainView === 'gigSquare' ? (
    <GigSquareView onOpenRemoteBotInBrowser={botBrowserShell.openRemoteBot} />
  ) : mainView === 'metaapps' ? (
    <MetaAppsView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleNewChat}
      onOpenMetaAppInBrowser={botBrowserShell.openMetaApp}
      onPreviewMetaAppByPin={botBrowserShell.openMetaAppByPin}
      onStartTaskWithMetaApp={handleStartTaskWithMetaApp}
      onOpenBotInBrowser={botBrowserShell.openRemoteBot}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : mainView === 'skills' ? (
    <SkillsView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      onStartTaskWithSkill={(skillId) => handleNewChat(skillId)}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : mainView === 'scheduledTasks' ? (
    <ScheduledTasksView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : mainView === 'groupTasks' ? (
    <GroupTasksView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
    />
  ) : mainView === 'metabots' ? (
    <MetabotsView
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
      onRequestModelSettings={() => handleShowSettings({ initialTab: 'model' })}
      onRequestOnboarding={handleOpenOnboarding}
      onOpenMetabotInBrowser={botBrowserShell.openLocalMetabot}
      onPreviewMetaAppHomepage={botBrowserShell.openMetaAppByPin}
      onRequestMetaApps={handleShowMetaApps}
    />
  ) : (
    <CoworkView
      onRequestAppSettings={handleShowSettings}
      onShowSkills={handleShowSkills}
      isSidebarCollapsed={isSidebarCollapsed}
      onToggleSidebar={handleToggleSidebar}
      onNewChat={handleBlankNewChat}
      updateBadge={isSidebarCollapsed ? updateBadge : null}
      onRequestOnboarding={handleOpenOnboarding}
      focusedOrderTxid={focusedOrderTxid}
      onFocusedOrderConsumed={handleFocusedOrderConsumed}
      onOpenBotInBrowser={botBrowserShell.openRemoteBot}
    />
  );

  return (
    <div className="relative h-screen overflow-hidden flex dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      {toastMessage && (
        <Toast message={toastMessage} onClose={() => setToastMessage(null)} />
      )}
      {isNewGroupTaskOpen && (
        <NewGroupTaskModal
          onClose={() => setIsNewGroupTaskOpen(false)}
          onCreated={handleGroupTaskCreated}
        />
      )}
      <Sidebar
        onShowLogin={handleShowLogin}
        onShowSettings={handleShowSettings}
        activeView={mainView}
        onShowMetaApps={handleShowMetaApps}
        onShowSkills={handleShowSkills}
        onShowCowork={handleShowCowork}
        onShowScheduledTasks={handleShowScheduledTasks}
        onShowGroupTasks={handleShowGroupTasks}
        onShowGigSquare={handleShowGigSquare}
        onShowMetabots={handleShowMetabots}
        onNewChat={handleBlankNewChat}
        onNewGroupTask={handleNewGroupTask}
        mode={botBrowserShell.surfaceMode}
        onSelectHome={botBrowserShell.switchToHome}
        onSelectBrowser={() => {
          void botBrowserShell.openBrowserHome();
        }}
        onNewBrowserTab={() => {
          void botBrowserShell.openNewTab();
        }}
        isCollapsed={isSidebarCollapsed}
        onToggleCollapse={handleToggleSidebar}
        width={sidebarWidth}
        isResizing={isSidebarResizing}
        updateBadge={!isSidebarCollapsed ? updateBadge : null}
      />
      {!isSidebarCollapsed ? (
        <div
          role="separator"
          aria-orientation="vertical"
          onMouseDown={handleSidebarResizeStart}
          onDoubleClick={handleSidebarResizeReset}
          className="w-1 shrink-0 cursor-col-resize transition-colors hover:bg-claude-accent/40"
        />
      ) : null}
      {/* While resizing, cover the content area so the Bot Browser iframe cannot
          swallow mousemove/mouseup events mid-drag (iframe event capture made the
          handle nearly undraggable in browser mode). */}
      {isSidebarResizing ? (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      ) : null}
      <div className="relative flex flex-1 min-w-0 min-h-0 overflow-hidden">
        {botBrowserShell.surfaceMode === 'home' ? (
          <div className={`flex-1 min-w-0 py-1.5 pr-1.5 ${isSidebarCollapsed ? 'pl-1.5' : ''}`}>
            <div className="h-full rounded-xl dark:bg-claude-darkBg bg-claude-bg overflow-hidden">
              {homeContent}
            </div>
          </div>
        ) : null}
        {botBrowserShell.hasMountedBrowser ? (
          <div className={botBrowserShell.surfaceMode === 'browser' ? 'relative flex flex-1 min-w-0 flex-col' : 'hidden'}>
            {isWindows ? (
              <div className="draggable relative h-9 shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
                <WindowTitleBar isOverlayActive={isOverlayActive} />
              </div>
            ) : null}
            <div className="flex-1 min-h-0">
              <BotBrowserSurface
                ref={botBrowserShell.browserRef}
                visible={botBrowserShell.surfaceMode === 'browser'}
                onOpenConversation={handleBrowserOpenConversation}
                onError={showToast}
                onReady={botBrowserShell.onBrowserReady}
              />
            </div>
            {isSidebarCollapsed ? (
              <button
                type="button"
                onClick={handleToggleSidebar}
                className={`non-draggable absolute top-2 z-40 h-8 w-8 inline-flex items-center justify-center rounded-lg border border-claude-border/70 bg-claude-surface/90 text-claude-textSecondary shadow-sm backdrop-blur-sm transition-colors hover:bg-claude-surfaceHover hover:text-claude-text dark:border-claude-darkBorder/70 dark:bg-claude-darkSurface/90 dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText ${isMac ? 'left-[76px]' : 'left-2'}`}
                aria-label={i18nService.t('expand')}
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 设置窗口显示在所有主内容之上，但不影响主界面的交互 */}
      {showSettings && (
        <Settings
          onClose={handleCloseSettings}
          initialTab={settingsOptions.initialTab}
          notice={settingsOptions.notice}
        />
      )}
      {showUpdateModal && updateInfo && (
        <AppUpdateModal
          updateInfo={updateInfo}
          readyToInstall={updatePhase === 'ready'}
          onConfirm={handleConfirmUpdate}
          onCancel={() => {
            if (updateModalState === 'info' || updateModalState === 'error' || updateModalState === 'restart') {
              setShowUpdateModal(false);
            }
          }}
          modalState={updateModalState}
          downloadProgress={downloadProgress}
          errorMessage={updateError}
          onCancelDownload={handleCancelDownload}
          onRetry={handleRetryUpdate}
        />
      )}
      {permissionModal}
    </div>
  );
};

export default App; 
