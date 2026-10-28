(() => {
  const remoteOrigin = __IDBOTS_REMOTE_ORIGIN_JSON__;
  const platform = __IDBOTS_PLATFORM_JSON__;
  if (window.top !== window || window.location.origin !== remoteOrigin) return;

  if (!window.idbotsMobile) {
    window.idbotsMobile = { isMobile: true, os: platform, shell: 'capacitor' };
  }

  const capabilities = Object.freeze({
    camera: false,
    photos: false,
    files: false,
    share: false,
    appState: true,
    backButton: platform === 'android',
    externalUrls: true,
    secureScreen: false,
  });
  const bridge = Object.freeze({
    nativeBridgeVersion: 1,
    bootstrap: Object.freeze({ phase: 'document-start', origin: remoteOrigin, platform }),
    getCapabilities: () => ({ ...capabilities }),
  });
  Object.defineProperty(window, 'idbotsNative', {
    value: bridge,
    enumerable: true,
    configurable: false,
    writable: false,
  });
})();
