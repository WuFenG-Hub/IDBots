import { createContext, useContext } from 'react';
import type { InlineMetaAppActor } from './inlineMetaAppBridge';

/**
 * The Bot that acts for MetaApps embedded in this conversation's assistant
 * bubbles (InlineMetaAppBlock). Provided by the session view from the
 * session's metabot; null outside a Bot session, in which case embedded apps
 * render but cannot sign.
 */
export const InlineMetaAppActorContext = createContext<InlineMetaAppActor | null>(null);

export const useInlineMetaAppActor = (): InlineMetaAppActor | null => useContext(InlineMetaAppActorContext);
