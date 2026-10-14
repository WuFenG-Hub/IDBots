import type {
  PreferenceBallot,
  PreferenceHumanRoundView,
  PreferenceUserRoundSummary,
} from '../types/preference';

const METAAPP_PREFIX = 'metaapp://';
/** Bot Browser preview URLs expire after 30 min; re-resolve well before that. */
const PREVIEW_MAX_AGE_MS = 20 * 60 * 1000;

export type PreferencePreview = { url: string; resolvedAtMs: number } | { error: string };

/**
 * Preference rounds — renderer service: thin IPC wrapper. Components keep
 * their own state; every write and every derivation lives in the main process.
 */
class PreferenceRendererService {
  private api() {
    return window.electron?.preference ?? null;
  }

  available(): boolean {
    return this.api() !== null;
  }

  async listRounds(
    filter: { mine?: boolean; taskid?: string } = {},
  ): Promise<{ rounds: PreferenceUserRoundSummary[]; userGlobalMetaId: string | null }> {
    const api = this.api();
    if (!api) return { rounds: [], userGlobalMetaId: null };
    const result = await api.listRounds(filter);
    if (!result.success) throw new Error(result.error ?? 'preference:list-failed');
    return { rounds: result.rounds ?? [], userGlobalMetaId: result.userGlobalMetaId ?? null };
  }

  async roundStatus(roundPinId: string): Promise<PreferenceHumanRoundView> {
    const api = this.api();
    if (!api) throw new Error('preference:bridge-missing');
    const result = await api.roundStatus({ roundPinId });
    if (!result.success || !result.view) throw new Error(result.error ?? 'preference:status-failed');
    return result.view;
  }

  async commit(roundPinId: string, ballot: PreferenceBallot): Promise<{ pinId: string; ballotId: string }> {
    const api = this.api();
    if (!api) throw new Error('preference:bridge-missing');
    const result = await api.commit({ roundPinId, ballot });
    if (!result.success || !result.pinId || !result.ballotId) throw new Error(result.error ?? 'preference:commit-failed');
    return { pinId: result.pinId, ballotId: result.ballotId };
  }

  recordPairTime(roundPinId: string, pairKey: string, seconds: number): void {
    const api = this.api();
    if (!api || !Number.isInteger(seconds) || seconds < 1 || seconds > 3600) return;
    void api.telemetry({ roundPinId, pairKey, seconds });
  }

  async refresh(): Promise<void> {
    const api = this.api();
    if (!api) return;
    const result = await api.refresh();
    if (!result.success) throw new Error(result.error ?? 'preference:refresh-failed');
  }

  subscribe(callback: (reason: string) => void): () => void {
    const api = this.api();
    if (!api || typeof api.onUpdate !== 'function') return () => undefined;
    let lastSeq = 0;
    return api.onUpdate((data) => {
      if (data.seq <= lastSeq) return;
      lastSeq = data.seq;
      callback(data.reason);
    });
  }

  async resolvePreview(artifact: string): Promise<PreferencePreview> {
    if (!artifact.startsWith(METAAPP_PREFIX)) return { error: 'unsupported' };
    const pinId = artifact.slice(METAAPP_PREFIX.length).split(/[/?#]/)[0];
    const browser = window.electron?.botBrowser;
    if (!browser?.resolveMetaAppPin) return { error: 'bot-browser-unavailable' };
    try {
      const result = await browser.resolveMetaAppPin({ pinId });
      if (result.ok === false) return { error: result.message || result.code };
      if (!result.data.runUrl) return { error: 'no-run-url' };
      return { url: result.data.runUrl, resolvedAtMs: Date.now() };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  previewIsFresh(preview: PreferencePreview | undefined): boolean {
    return Boolean(preview && 'url' in preview && Date.now() - preview.resolvedAtMs < PREVIEW_MAX_AGE_MS);
  }
}

export const preferenceService = new PreferenceRendererService();
