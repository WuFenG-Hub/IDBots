import { createContext, type ReactNode } from 'react';
import type { CoworkMessage } from '../../types/cowork';

/** Optional host-owned content beneath an assistant reply. */
export const MessageExtensionContext = createContext<((message: CoworkMessage) => ReactNode) | null>(null);
