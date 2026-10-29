(() => {
  const remoteOrigin = __IDBOTS_REMOTE_ORIGIN_JSON__;
  const platform = __IDBOTS_PLATFORM_JSON__;
  if (window.top !== window || window.location.origin !== remoteOrigin) return;

  if (!window.idbotsMobile) {
    window.idbotsMobile = { isMobile: true, os: platform, shell: 'capacitor' };
  }

  const appPlugin = () => window.Capacitor?.Plugins?.App;
  const hasAppListeners = () => typeof appPlugin()?.addListener === 'function';
  const noop = () => {};
  const addAppListener = (eventName, listener) => {
    const plugin = appPlugin();
    if (typeof plugin?.addListener !== 'function') return noop;
    let active = true;
    let handle = null;
    try {
      Promise.resolve(plugin.addListener(eventName, listener)).then((registration) => {
        if (!active) {
          void registration.remove().catch(noop);
          return;
        }
        handle = registration;
      }).catch(noop);
    } catch {
      return noop;
    }
    return () => {
      active = false;
      if (handle) void handle.remove().catch(noop);
    };
  };
  const approvedExternalUrl = (value) => {
    const parsed = new URL(value.trim());
    const allowed = parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'alipays:';
    if (!allowed || !parsed.host || parsed.username || parsed.password) throw new Error('External URL is not allowed');
    return value.trim();
  };
  const isProductRootRoute = () => ['/', '/app', '/app/', '/login', '/login/'].includes(window.location.pathname);
  const bridge = Object.freeze({
    nativeBridgeVersion: 1,
    bootstrap: Object.freeze({ phase: 'document-start', origin: remoteOrigin, platform }),
    getCapabilities: () => ({
      camera: false,
      photos: false,
      files: false,
      share: false,
      appState: hasAppListeners(),
      backButton: platform === 'android' && hasAppListeners(),
      externalUrls: true,
      secureScreen: false,
    }),
    openExternal: async (value) => {
      const url = approvedExternalUrl(value);
      window.location.assign(url);
    },
    onAppStateChange: (callback) => addAppListener('appStateChange', (event) => {
      callback(event?.isActive === true);
    }),
    onBackButton: (callback) => {
      if (platform !== 'android') return noop;
      return addAppListener('backButton', (event) => {
        let handled = false;
        try {
          handled = callback() === true;
        } catch {
          handled = false;
        }
        if (handled) return;
        if (event?.canGoBack && !isProductRootRoute() && typeof window.history?.back === 'function') {
          window.history.back();
          return;
        }
        const plugin = appPlugin();
        if (typeof plugin?.exitApp === 'function') void plugin.exitApp().catch(noop);
      });
    },
  });
  Object.defineProperty(window, 'idbotsNative', {
    value: bridge,
    enumerable: true,
    configurable: false,
    writable: false,
  });
})();
