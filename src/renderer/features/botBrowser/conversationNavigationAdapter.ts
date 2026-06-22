import { coworkService } from '../../services/cowork';
import type { CoworkSession } from '../../types/cowork';
import {
  normalizeBrowserGlobalMetaId,
  parseLocalMetabotActorId,
} from './botBrowserIntent.js';
import type { BotBrowserConversationRequest } from './types';

interface OpenBotBrowserConversationDeps {
  switchToHome: () => void;
  showCowork: () => void;
  showToast: (message: string) => void;
}

function messageFromError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return fallback;
}

export async function openBotBrowserConversationInCowork(
  request: BotBrowserConversationRequest,
  deps: OpenBotBrowserConversationDeps,
): Promise<CoworkSession> {
  try {
    const localMetabotId = parseLocalMetabotActorId(request.actorId);
    if (localMetabotId == null) {
      throw new Error('A valid local Bot actor is required.');
    }

    const peerGlobalMetaId = normalizeBrowserGlobalMetaId(request.peerGlobalMetaId);
    if (!peerGlobalMetaId) {
      throw new Error('A valid peer GlobalMetaID is required.');
    }

    const ensureA2ASession = window.electron?.cowork?.ensureA2ASession;
    if (!ensureA2ASession) {
      throw new Error('A2A session API is not available.');
    }

    const result = await ensureA2ASession({
      actorId: request.actorId,
      localMetabotId,
      peerGlobalMetaId,
      peerName: request.peerName ?? null,
      peerAvatar: request.peerAvatar ?? null,
    });
    const sessionId = result.session?.id;
    if (!result.success || !sessionId) {
      throw new Error(result.error || 'Failed to open the A2A session.');
    }

    await coworkService.loadSessions();
    const session = await coworkService.loadSession(sessionId);
    if (!session) {
      throw new Error('Failed to load the A2A session.');
    }

    deps.switchToHome();
    deps.showCowork();
    return session;
  } catch (error) {
    const message = messageFromError(error, 'Failed to open the A2A session.');
    deps.showToast(message);
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(message);
  }
}
