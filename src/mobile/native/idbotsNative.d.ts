interface MobileNativeCapabilities {
  camera: boolean;
  photos: boolean;
  files: boolean;
  share: boolean;
  appState: boolean;
  backButton: boolean;
  externalUrls: boolean;
  secureScreen: boolean;
}

interface IdbotsNativeBridge {
  readonly nativeBridgeVersion: 1;
  readonly bootstrap: {
    readonly phase: 'document-start';
    readonly origin: string;
    readonly platform: 'android' | 'ios';
  };
  getCapabilities(): MobileNativeCapabilities;
}

interface IdbotsNativeProof {
  readonly phase: 'before-react';
  readonly origin: string;
  readonly platform: 'android' | 'ios';
  readonly nativeBridgeVersion: 1;
  readonly confirmedAtMs: number;
}

declare global {
  interface Window {
    Capacitor?: {
      isNativePlatform?: () => boolean;
    };
    idbotsNative?: IdbotsNativeBridge;
    idbotsNativeProof?: IdbotsNativeProof;
  }
}

export type { IdbotsNativeBridge, IdbotsNativeProof, MobileNativeCapabilities };
