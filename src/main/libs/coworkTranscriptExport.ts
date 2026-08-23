/**
 * Session transcript export for the composer's /export command.
 *
 * The DSH web UI's /export downloads a ZIP of raw session artifacts via its
 * HTTP apiproxy; IDBots has no apiproxy, so the port renders the session view
 * (the same messages the transcript UI shows) into a single Markdown file and
 * saves it through a native save dialog.
 */

export interface TranscriptExportMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system';
  content: string;
  timestamp: number;
  metadata?: {
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: string;
    isError?: boolean;
    isDelegationInternal?: boolean;
  };
}

export interface TranscriptExportSession {
  id: string;
  title: string;
  cwd?: string | null;
  createdAt?: number;
}

const TOOL_INPUT_LIMIT = 800;
const TOOL_RESULT_LIMIT = 2000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n… (${text.length - limit} more characters)`;
}

function sectionHeading(label: string, timestamp: number): string {
  const iso = new Date(timestamp).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  return `### ${label} · ${iso}`;
}

/**
 * Render one session (metadata + full message list) as Markdown.
 * Delegation-internal plumbing messages are skipped, matching the transcript
 * UI's filtered view.
 */
export function buildSessionTranscriptMarkdown(
  session: TranscriptExportSession,
  messages: readonly TranscriptExportMessage[],
): string {
  const lines: string[] = [];
  const exportedAt = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  lines.push(`# ${session.title || 'Session'}`, '');
  lines.push(`- **Session ID**: \`${session.id}\``);
  if (session.cwd) {
    lines.push(`- **Working directory**: \`${session.cwd}\``);
  }
  if (session.createdAt) {
    const created = new Date(session.createdAt).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    lines.push(`- **Created**: ${created}`);
  }
  lines.push(`- **Messages**: ${messages.length}`);
  lines.push(`- **Exported**: ${exportedAt}`, '');
  lines.push('---', '');

  for (const message of messages) {
    if (message.metadata?.isDelegationInternal) continue;
    switch (message.type) {
      case 'user':
        lines.push(sectionHeading('User', message.timestamp), '', message.content.trim() || '_(empty)_', '');
        break;
      case 'assistant':
        lines.push(sectionHeading('Assistant', message.timestamp), '', message.content.trim() || '_(empty)_', '');
        break;
      case 'system':
        lines.push(sectionHeading('System', message.timestamp), '', message.content.trim(), '');
        break;
      case 'tool_use': {
        const toolName = message.metadata?.toolName ?? 'tool';
        lines.push(sectionHeading(`Tool · ${toolName}`, message.timestamp), '');
        const input = message.metadata?.toolInput
          ? JSON.stringify(message.metadata.toolInput, null, 2)
          : message.content;
        lines.push('```json', truncate(input, TOOL_INPUT_LIMIT), '```', '');
        break;
      }
      case 'tool_result': {
        const toolName = message.metadata?.toolName ?? 'tool';
        const failed = message.metadata?.isError ? ' (failed)' : '';
        lines.push(sectionHeading(`Tool result · ${toolName}${failed}`, message.timestamp), '');
        const result = message.metadata?.toolResult ?? message.content;
        lines.push('```', truncate(result, TOOL_RESULT_LIMIT), '```', '');
        break;
      }
    }
  }
  return lines.join('\n');
}

/** File-system-safe default name for the save dialog. */
export function transcriptExportFileName(session: TranscriptExportSession): string {
  const safeTitle = (session.title || 'session')
    .replace(/[^\w\u4e00-\u9fa5-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'session';
  return `idbots-session-${safeTitle}.md`;
}
