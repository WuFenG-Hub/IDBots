import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  buildBrowserPageDefinition,
  renderBrowserPageHtml,
} from '@openagentinternet/agent-browser-ui/browser';
import { i18nService } from '../../services/i18n';
import { createBrowserEndpointShim, type BrowserEndpointShimResponse } from './browserEndpointShim';
import { createIdbotsBrowserHostAdapter } from './idbotsBrowserHostAdapter';
import { injectBrowserIframeBridge, relaxMetaAppIframeSandbox } from './browserIframeBridge';
import type {
  BotBrowserConversationRequest,
  BotBrowserOpenUriInput,
  BotBrowserSurfaceHandle,
} from './types';

export interface BotBrowserSurfaceProps {
  visible: boolean;
  onOpenConversation(request: BotBrowserConversationRequest): Promise<void>;
  onError(message: string): void;
  onReady?: () => void;
}

type BrowserIframeMessage =
  | {
      source: 'idbots-browser-iframe-bridge';
      type: 'browser-ready';
    }
  | {
      source: 'idbots-browser-iframe-bridge';
      type: 'endpoint-request';
      id: string;
      request: {
        url: string;
        method?: string;
        body?: unknown;
      };
    };

const PARENT_SOURCE = 'idbots-browser-surface';

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

function getBrowserLanguagePreference(): string {
  const maybeI18n = i18nService as { getLanguage?: () => string };
  try {
    if (typeof maybeI18n.getLanguage === 'function') {
      const language = maybeI18n.getLanguage();
      if (language) return language;
    }
  } catch (error) {
    console.warn('Failed to read i18n language for Bot Browser:', error);
  }

  if (typeof document !== 'undefined' && document.documentElement.lang) {
    return document.documentElement.lang;
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }
  return 'en';
}

function endpointErrorResponse(error: unknown): BrowserEndpointShimResponse {
  return {
    status: 400,
    body: {
      ok: false,
      state: 'failed',
      code: 'browser_endpoint_error',
      message: errorMessage(error, 'Browser endpoint request failed.'),
    },
  };
}

export const BotBrowserSurface = forwardRef<BotBrowserSurfaceHandle, BotBrowserSurfaceProps>(
  function BotBrowserSurface(
    {
      visible,
      onOpenConversation,
      onError,
      onReady,
    },
    ref,
  ) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const srcDocRef = useRef<string | null>(null);
    const buildPromiseRef = useRef<Promise<void> | null>(null);
    const readyRef = useRef(false);
    const pendingOpenUrisRef = useRef<BotBrowserOpenUriInput[]>([]);
    const pendingRefreshRuntimeRef = useRef(false);
    const callbacksRef = useRef({
      onOpenConversation,
      onError,
      onReady,
    });
    const endpointShimRef = useRef<ReturnType<typeof createBrowserEndpointShim> | null>(null);
    const [srcDoc, setSrcDoc] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    callbacksRef.current = {
      onOpenConversation,
      onError,
      onReady,
    };

    if (!endpointShimRef.current) {
      const adapter = createIdbotsBrowserHostAdapter({
        listMetabots: async () => {
          const result = await window.electron.metabot.list();
          return result?.list ?? [];
        },
        listMetaApps: async () => {
          const result = await window.electron.metaapps.list();
          return result?.apps ?? [];
        },
        resolveMetaAppPin: async (pinId) => {
          return window.electron.botBrowser.resolveMetaAppPin({ pinId });
        },
        installCommunityMetaApp: async (sourcePinId) => {
          return window.electron.metaapps.installCommunity({ sourcePinId });
        },
        resolveMetaAppUrl: async (app) => {
          const result = await window.electron.metaapps.resolveUrl({
            appId: app.id,
            targetPath: app.entry,
          });
          if (!result?.success || !result.url) {
            throw new Error(result?.error || 'Failed to resolve MetaApp URL.');
          }
          return result.url;
        },
        getMetaAppCache: () => window.electron.botBrowser.getMetaAppCache(),
        clearMetaAppCache: (input) => window.electron.botBrowser.clearMetaAppCache(input),
        openConversation: (request) => callbacksRef.current.onOpenConversation(request),
      });
      endpointShimRef.current = createBrowserEndpointShim(adapter);
    }

    const postToIframe = useCallback((message: Record<string, unknown>): boolean => {
      const target = iframeRef.current?.contentWindow;
      if (!target) return false;
      target.postMessage({ source: PARENT_SOURCE, ...message }, '*');
      return true;
    }, []);

    const postOpenUri = useCallback((input: BotBrowserOpenUriInput): boolean => {
      return postToIframe({
        type: 'open-uri',
        input,
      });
    }, [postToIframe]);

    const flushPendingOpenUris = useCallback(() => {
      if (!readyRef.current) return;
      const pending = pendingOpenUrisRef.current.splice(0);
      for (let index = 0; index < pending.length; index += 1) {
        const input = pending[index];
        if (!postOpenUri(input)) {
          readyRef.current = false;
          pendingOpenUrisRef.current.unshift(...pending.slice(index));
          break;
        }
      }
    }, [postOpenUri]);

    const flushPendingRefreshRuntime = useCallback(() => {
      if (!readyRef.current) return;
      if (!pendingRefreshRuntimeRef.current) return;
      if (postToIframe({ type: 'refresh-runtime' })) {
        pendingRefreshRuntimeRef.current = false;
      } else {
        readyRef.current = false;
      }
    }, [postToIframe]);

    const ensureSrcDoc = useCallback((): Promise<void> => {
      if (srcDocRef.current) return Promise.resolve();
      if (buildPromiseRef.current) return buildPromiseRef.current;

      setLoading(true);
      const buildPromise = (async () => {
        try {
          const definition = injectBrowserIframeBridge(buildBrowserPageDefinition());
          const html = relaxMetaAppIframeSandbox(
            await renderBrowserPageHtml(definition, getBrowserLanguagePreference()),
          );
          readyRef.current = false;
          srcDocRef.current = html;
          setSrcDoc(html);
        } catch (error) {
          const message = errorMessage(error, 'Failed to build Bot Browser surface.');
          callbacksRef.current.onError(message);
          throw error;
        } finally {
          setLoading(false);
          buildPromiseRef.current = null;
        }
      })();

      buildPromiseRef.current = buildPromise;
      return buildPromise;
    }, []);

    useEffect(() => {
      if (!visible) return;
      void ensureSrcDoc().catch(() => {});
    }, [ensureSrcDoc, visible]);

    useEffect(() => {
      const handleMessage = (event: MessageEvent) => {
        if (event.source !== iframeRef.current?.contentWindow) return;
        const data = event.data as BrowserIframeMessage;
        if (!data || data.source !== 'idbots-browser-iframe-bridge') return;

        if (data.type === 'browser-ready') {
          readyRef.current = true;
          callbacksRef.current.onReady?.();
          flushPendingOpenUris();
          flushPendingRefreshRuntime();
          return;
        }

        if (data.type === 'endpoint-request') {
          const shim = endpointShimRef.current;
          if (!shim) return;
          void (async () => {
            const response = await shim(data.request).catch(endpointErrorResponse);
            postToIframe({
              type: 'endpoint-response',
              id: data.id,
              response,
            });
          })();
        }
      };

      window.addEventListener('message', handleMessage);
      return () => window.removeEventListener('message', handleMessage);
    }, [flushPendingOpenUris, flushPendingRefreshRuntime, postToIframe]);

    useImperativeHandle(ref, () => ({
      async openUri(input: BotBrowserOpenUriInput): Promise<void> {
        if (!readyRef.current) {
          pendingOpenUrisRef.current.push(input);
          await ensureSrcDoc().catch(() => {});
          return;
        }
        if (postOpenUri(input)) return;
        readyRef.current = false;
        pendingOpenUrisRef.current.push(input);
        await ensureSrcDoc().catch(() => {});
      },
      async refreshRuntime(): Promise<void> {
        if (!readyRef.current) {
          pendingRefreshRuntimeRef.current = true;
          await ensureSrcDoc().catch(() => {});
          return;
        }
        if (postToIframe({ type: 'refresh-runtime' })) return;
        readyRef.current = false;
        pendingRefreshRuntimeRef.current = true;
        await ensureSrcDoc().catch(() => {});
      },
    }), [ensureSrcDoc, postOpenUri, postToIframe]);

    const showLoading = loading || !srcDoc;

    return (
      <div
        className="h-full w-full"
        data-bot-browser-surface
        style={{ display: visible ? 'block' : 'none' }}
      >
        {srcDoc ? (
          <iframe
            ref={iframeRef}
            title="Bot Browser"
            srcDoc={srcDoc}
            className="h-full w-full"
            style={{ border: 0, display: 'block' }}
          />
        ) : null}
        {showLoading ? (
          <div className="flex h-full w-full items-center justify-center dark:text-claude-darkText text-claude-text">
            {i18nService.t('loading')}
          </div>
        ) : null}
      </div>
    );
  },
);

BotBrowserSurface.displayName = 'BotBrowserSurface';
