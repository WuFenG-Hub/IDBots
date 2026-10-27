import { useEffect, useState } from 'react';
import { fetchArtifactText, type MobileArtifactKind } from '../artifacts';

interface ArtifactTextState {
  text: string | null;
  loading: boolean;
  error: Error | null;
}

export function useArtifactText(kind: MobileArtifactKind, url: string | null): ArtifactTextState {
  const [state, setState] = useState<ArtifactTextState>({ text: null, loading: false, error: null });
  useEffect(() => {
    if (kind !== 'markdown' || !url) {
      setState({ text: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setState({ text: null, loading: true, error: null });
    fetchArtifactText(url, { signal: controller.signal })
      .then((text) => {
        if (!cancelled) setState({ text, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || (error as { name?: unknown } | null)?.name === 'AbortError') return;
        setState({ text: null, loading: false, error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [kind, url]);
  return state;
}
