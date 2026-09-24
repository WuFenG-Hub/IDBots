export interface AppCleanupDeps {
  destroyTray: () => void;
  stopSkillWatching: () => void;
  closeMetaidRpcServer: () => void;
  stopCoworkSessions: () => void;
  /** Drain every DSH runtime subprocess. Optional so older cleanup
   *  callers that only stop cowork sessions still type-check. */
  closeDshRuntime?: () => Promise<void>;
  /** Polling daemons that keep launching cowork/LLM turns. They must stop
   *  BEFORE the DSH runtime closes — otherwise their in-window turns crash
   *  with `DshKernel: closed` (the 2026-09-12 mass A2A session 'error'
   *  incident). Optional so older cleanup callers still type-check. */
  stopPrivateChatDaemon?: () => Promise<void> | void;
  stopGroupTaskDaemon?: () => void;
  stopOpenTeamGuestDaemon?: () => void;
  stopOpenAICompatProxy: () => Promise<void>;
  stopSkillServices: () => Promise<void>;
  stopIMGateways: () => Promise<void>;
  stopScheduler: () => void;
  stopCognitiveOrchestrator: () => void;
  stopDreamService: () => void;
  /** Optional so older cleanup callers that predate the hygiene service still type-check. */
  stopMemoryHygieneService?: () => void;
  stopProviderDiscovery: () => void;
  deactivateGroupChatTasks: () => void;
  log: (message: string) => void;
  error: (message: string, error: unknown) => void;
}

export async function runAppCleanup(deps: AppCleanupDeps): Promise<void> {
  deps.log('[Main] App is quitting, starting cleanup...');
  // Turn-generating loops first: no new scheduled/orchestrated/chat turns may
  // start once cowork sessions and the DSH runtime begin tearing down.
  await Promise.resolve(deps.stopPrivateChatDaemon?.()).catch((error: unknown) => {
    deps.error('[PrivateChat] Error stopping daemon on quit:', error);
  });
  deps.stopGroupTaskDaemon?.();
  deps.stopOpenTeamGuestDaemon?.();
  deps.stopScheduler();
  deps.stopCognitiveOrchestrator();
  deps.destroyTray();
  deps.stopSkillWatching();
  deps.closeMetaidRpcServer();
  deps.stopCoworkSessions();
  await deps.closeDshRuntime?.().catch((error) => {
    deps.error('Failed to close DSH runtime:', error);
  });

  await deps.stopOpenAICompatProxy().catch((error) => {
    deps.error('Failed to stop OpenAI compatibility proxy:', error);
  });

  await deps.stopSkillServices().catch((error) => {
    deps.error('[SkillServices] Error stopping services on quit:', error);
  });

  await deps.stopIMGateways().catch((error) => {
    deps.error('[IM Gateway] Error stopping gateways on quit:', error);
  });

  deps.stopDreamService();
  deps.stopMemoryHygieneService?.();
  deps.stopProviderDiscovery();
  deps.deactivateGroupChatTasks();
}
