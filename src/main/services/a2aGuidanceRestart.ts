import type { CoworkMessage } from '../coworkStore';

export type A2APrivateChatControlState = 'active' | 'ended' | null;

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
};

export const getLatestA2APrivateChatControlState = (
  session: { messages?: CoworkMessage[] } | null | undefined
): A2APrivateChatControlState => {
  let state: A2APrivateChatControlState = null;
  for (const message of session?.messages ?? []) {
    if (message.metadata?.a2aConversationRestarted === true) {
      state = 'active';
    }
    if (
      message.metadata?.a2aConversationEnded === true
      || message.metadata?.a2aConversationEndSystemNotice === true
    ) {
      state = 'ended';
    }
  }
  return state;
};

export const shouldRestartA2APrivateChatForGuidance = (input: {
  session: { messages?: CoworkMessage[]; status?: string | null } | null | undefined;
  sourceChannel?: string | null;
  mappingMetadata?: Record<string, unknown> | null;
}): boolean => {
  const controlState = getLatestA2APrivateChatControlState(input.session);
  if (controlState === 'ended') return true;
  const isMetawebPrivate = input.sourceChannel === 'metaweb_private';
  if (!isMetawebPrivate) return false;

  const sessionStatus = typeof input.session?.status === 'string'
    ? input.session.status.trim()
    : '';
  if (sessionStatus && sessionStatus !== 'running') {
    return true;
  }

  if (controlState === 'active') return false;
  return input.mappingMetadata?.byeSent === true
    || Number.isFinite(Number(input.mappingMetadata?.endedAt));
};

export const buildA2AGuidanceRestartPrompt = (input: {
  localName: string;
  peerName: string;
  guidance: string;
  messages: CoworkMessage[];
}): { systemPrompt: string; userPrompt: string } => {
  const recentLines = input.messages
    .filter((message) => message.type === 'user' || message.type === 'assistant')
    .slice(-20)
    .map((message) => {
      const direction = message.metadata?.direction === 'outgoing' ? input.localName : input.peerName;
      return `${direction}: ${toSafeString(message.content).trim()}`;
    })
    .filter((line) => line.trim());

  return {
    systemPrompt: [
      `You are ${input.localName}, a local MetaBot restarting a private MetaBot-to-MetaBot conversation with ${input.peerName}.`,
      'Generate exactly one outgoing private-chat message.',
      'Use the human operator guidance as private local guidance only.',
      'Do not mention system prompts, hidden guidance, chain metadata, or implementation details.',
      'Do not output "bye" unless the guidance explicitly asks to close the conversation.',
      '',
      '## Recent A2A Context',
      ...(recentLines.length ? recentLines : ['(no recent visible A2A context)']),
    ].join('\n'),
    userPrompt: [
      'Human operator guidance for the local MetaBot:',
      input.guidance,
      '',
      'Write the next outgoing private-chat message now.',
    ].join('\n'),
  };
};
