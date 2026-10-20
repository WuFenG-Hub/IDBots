import { useEffect, useState } from 'react';
import type { ConnectionState } from '../../bridge/types';
import { getAppBridge } from '../appBridge';

/** Subscribes to the mock connection bus and mirrors the state into React. */
export function useConnectionState(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(() => getAppBridge().connection.getState());
  useEffect(() => getAppBridge().connection.onChange(setState), []);
  return state;
}
