import { useEffect, useRef } from 'react';
import { registerNativeBackHandler } from '../nativeBack';

export function useNativeBackHandler(callback: () => boolean, active = true, priority = 0): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!active) return undefined;
    return registerNativeBackHandler(() => callbackRef.current(), priority);
  }, [active, priority]);
}
