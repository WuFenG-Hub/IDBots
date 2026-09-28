import { useRef } from 'react';

/**
 * One identity for the lifetime of the component, always invoking the latest
 * callback it was given.
 *
 * The session list renders one memoized row per session (hundreds of them), and
 * every row receives the list's action callbacks as props. A plain inline
 * handler — or one rebuilt from a value that changes on each parent render, such
 * as a fresh sessions array read for the browser-session routing — changes
 * identity on every render, which makes the row memo compare unequal and
 * re-render every row on the screen. Wrapping the handler keeps the prop the
 * memoized children see referentially stable while still calling the newest
 * closure: these callbacks only run from events, i.e. after the render that
 * stored them has been committed, so the latest ref is always the current one.
 */
export const useStableCallback = <TArgs extends unknown[], TResult>(
  callback: (...args: TArgs) => TResult,
): ((...args: TArgs) => TResult) => {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;
  const stableRef = useRef<((...args: TArgs) => TResult) | null>(null);
  if (stableRef.current === null) {
    stableRef.current = (...args: TArgs) => callbackRef.current(...args);
  }
  return stableRef.current;
};
