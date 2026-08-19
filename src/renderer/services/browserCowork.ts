import { store } from '../store';
import {
  setBrowserSession,
  setBrowserStreaming,
  clearBrowserSession,
} from '../store/slices/browserCoworkSlice';
import { coworkService } from './cowork';
import { skillService } from './skill';
import type { CoworkSession } from '../types/cowork';

/**
 * Session service for the Bot Browser side-panel Co-Work surface.
 *
 * Browser sessions are `sessionType === 'browser'` cowork sessions: they reuse
 * the whole cowork pipeline (IPC, runner, stream events, SQLite persistence)
 * but are driven from the Bot Browser sidebar instead of the main CoworkView.
 * The panel keeps its own current-session pointer in `browserCoworkSlice`;
 * history is derived from the shared `cowork.sessions` list filtered by type.
 */
class BrowserCoworkService {
  private starting = false;

  private async buildCombinedSystemPrompt(): Promise<string | undefined> {
    const config = store.getState().cowork.config;
    // NOTE: the local MetaApp auto-routing prompt (<available_metaapps> →
    // open_metaapp) is deliberately excluded for browser sessions — in this
    // surface apps are opened on-chain via search_metaapps + metaapp:// URIs.
    const skillPrompt = await skillService.getAutoRoutingPrompt();
    return [skillPrompt, config.systemPrompt]
      .filter((part) => part?.trim())
      .join('\n\n') || undefined;
  }

  async start(
    prompt: string,
    metabotId?: number | null,
    cwd?: string,
    modelEffort?: { model?: string | null; effort?: string | null },
  ): Promise<CoworkSession | null> {
    if (this.starting) return null;
    const cowork = window.electron?.cowork;
    if (!cowork) return null;
    this.starting = true;
    try {
      store.dispatch(setBrowserStreaming(true));
      const fallbackTitle = prompt.split('\n')[0].slice(0, 50) || 'Bot Browser';
      const [generatedTitle, systemPrompt] = await Promise.all([
        coworkService.generateSessionTitle(prompt).catch(() => null),
        this.buildCombinedSystemPrompt(),
      ]);
      const result = await cowork.startSession({
        prompt,
        title: generatedTitle?.trim() || fallbackTitle,
        systemPrompt,
        sessionType: 'browser',
        ...(typeof metabotId === 'number' ? { metabotId } : {}),
        ...(cwd?.trim() ? { cwd: cwd.trim() } : {}),
        ...(modelEffort?.model ? { model: modelEffort.model } : {}),
        ...(modelEffort && modelEffort.effort !== undefined ? { effort: modelEffort.effort } : {}),
      });
      if (result?.success && result.session) {
        store.dispatch(setBrowserSession(result.session));
        // Refresh the shared session list so the panel history sees the new session.
        await coworkService.loadSessions();
        return result.session;
      }
      store.dispatch(setBrowserStreaming(false));
      console.error('Failed to start browser cowork session:', result?.error);
      return null;
    } finally {
      this.starting = false;
    }
  }

  async send(prompt: string): Promise<boolean> {
    const session = store.getState().browserCowork.currentSession;
    if (!session) return false;
    const result = await coworkService.submitInput({
      sessionId: session.id,
      submissionId: crypto.randomUUID(),
      text: prompt,
    });
    return result.success !== false;
  }

  async stop(): Promise<void> {
    const session = store.getState().browserCowork.currentSession;
    if (!session) return;
    await coworkService.stopSession(session.id);
  }

  async loadSession(sessionId: string): Promise<void> {
    const result = await window.electron?.cowork?.getSession(sessionId);
    if (result?.success && result.session) {
      store.dispatch(setBrowserSession(result.session));
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    await coworkService.archiveSession(sessionId);
    if (store.getState().browserCowork.currentSession?.id === sessionId) {
      store.dispatch(clearBrowserSession());
    }
  }

  startNewDraft(): void {
    store.dispatch(clearBrowserSession());
  }
}

export const browserCoworkService = new BrowserCoworkService();
