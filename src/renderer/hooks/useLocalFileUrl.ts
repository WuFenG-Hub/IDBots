import { useEffect, useState } from 'react';
import {
  resolveLocalFileUrl,
  subscribeLocalFileUrl,
  type LocalFileUrlDisposition,
} from '../services/localFileUrl';

export interface LocalFileUrlState {
  /** Resolved URL: a `file://` URL on desktop, `/files/{token}` on mobile. */
  url: string | null;
  /** Sign failure (or desktop-resolution failure), for the UI to surface. */
  error: Error | null;
  /** True while a first sign for this path is in flight. */
  loading: boolean;
}

/**
 * Resolve one local file path to a usable URL (REQ-E-7). Desktop resolves to
 * the classic `file://` string; mobile signs through the gateway and re-renders
 * with the rotated token when the background refresh replaces it. `null` path
 * resets to `{ url: null, error: null, loading: false }`.
 */
export function useLocalFileUrl(
  path: string | null,
  options?: { disposition?: LocalFileUrlDisposition },
): LocalFileUrlState {
  const disposition = options?.disposition;
  const [state, setState] = useState<LocalFileUrlState>({
    url: null,
    error: null,
    loading: path != null,
  });

  useEffect(() => {
    if (path == null) {
      setState({ url: null, error: null, loading: false });
      return;
    }
    let cancelled = false;
    setState({ url: null, error: null, loading: true });

    resolveLocalFileUrl(path, { disposition })
      .then((url) => {
        if (!cancelled) setState({ url, error: null, loading: false });
      })
      .catch((raw: unknown) => {
        if (cancelled) return;
        const error = raw instanceof Error ? raw : new Error(String(raw));
        setState({ url: null, error, loading: false });
      });

    const unsubscribe = subscribeLocalFileUrl(path, disposition, (url) => {
      if (!cancelled) {
        setState((previous) => (previous.url === url ? previous : { ...previous, url }));
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [path, disposition]);

  return state;
}
