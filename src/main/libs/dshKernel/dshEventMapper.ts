// DSH session-event → CoworkMessage mapper (Phase 1 M4).
//
// This is the DSH counterpart of handleClaudeEvent's SDK-event half: a pure,
// stateful transformer from wire `session/event` envelopes into the same
// message/streaming/turn actions the Claude path emits, so the store, the
// renderer, and every consumer above CoworkRunner stay untouched.
//
// Shapes below are taken verbatim from recorded rc.6 wire traffic (M1-M3
// tests). Event payloads nest under `envelope.data`. Known quirks baked in:
//  - plugin-source user messages (approval policy snapshots, runtime context)
//    must NOT become user bubbles — they are model-facing context only
//  - tool/result carries only the callId; the tool name lives on tool/call
//  - usage arrives on assistant/chunk (usage) and assistant/message events

import type { DshMapperAction, DshSessionEventEnvelope, DshUsageSnapshot } from './types'

const textOf = (blocks: Array<{ type: string; text?: string }> | undefined): string =>
  (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

export class DshEventMapper {
  private textOpen = false
  private textBuf = ''
  private thinkingOpen = false
  private thinkingBuf = ''
  private lastUsage: DshUsageSnapshot | null = null
  private provider: string | undefined
  private model: string | undefined

  consume(envelope: DshSessionEventEnvelope): DshMapperAction[] {
    const actions: DshMapperAction[] = []
    const data = envelope.data ?? {}
    switch (envelope.type) {
      case 'user/message': {
        // Envelope payload is flat on data (id/role/content/source); defend
        // against a nested message copy too.
        const source = data.source ?? data.message?.source
        // user: real human input. plugin: runtime-context snapshots (approval
        // policy etc.) — model-facing only. tool: covered by tool/result.
        if (source?.kind === 'user') {
          actions.push({
            kind: 'message',
            message: { type: 'user', content: textOf(data.content ?? data.message?.content) },
          })
        }
        break
      }

      case 'request/header': {
        // Full assembled request snapshot: capture the route for usage reports.
        this.provider = data.header?.config?.provider ?? this.provider
        this.model = data.header?.config?.model ?? this.model
        break
      }

      case 'assistant/chunk': {
        const chunk = data.chunk
        if (chunk?.type === 'text-delta') {
          if (!this.textOpen) {
            this.textOpen = true
            this.textBuf = ''
            actions.push({
              kind: 'message',
              slot: 'text',
              message: { type: 'assistant', content: '', metadata: { isStreaming: true } },
            })
          }
          this.textBuf += chunk.text ?? ''
          actions.push({ kind: 'messageUpdate', slot: 'text', content: this.textBuf })
        } else if (chunk?.type === 'reasoning-delta') {
          if (!this.thinkingOpen) {
            this.thinkingOpen = true
            this.thinkingBuf = ''
            actions.push({
              kind: 'message',
              slot: 'thinking',
              message: { type: 'assistant', content: '', metadata: { isThinking: true, isStreaming: true } },
            })
          }
          this.thinkingBuf += chunk.text ?? ''
          actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
        } else if (chunk?.type === 'usage') {
          this.lastUsage = this.withRoute(chunk.usage)
        }
        // block-start/block-end/finish carry no additional mapped output: the
        // assembled message arrives as assistant/message.
        break
      }

      case 'assistant/message': {
        // Finalize any open streaming slots first (same-message-id finalize,
        // matching the Claude path's finalizeStreamingContent).
        if (this.thinkingOpen) {
          this.thinkingOpen = false
          actions.push({ kind: 'messageFinalize', slot: 'thinking', content: this.thinkingBuf })
          this.thinkingBuf = ''
        }
        if (this.textOpen) {
          this.textOpen = false
          actions.push({ kind: 'messageFinalize', slot: 'text', content: this.textBuf })
          this.textBuf = ''
        }
        const usage = this.withRoute(data.usage ?? undefined)
        if (usage) {
          this.lastUsage = usage
          actions.push({ kind: 'usage', usage })
        }
        break
      }

      case 'tool/call': {
        let toolInput: Record<string, unknown> = {}
        try {
          const parsed = JSON.parse(data.arguments ?? '{}')
          if (parsed && typeof parsed === 'object') toolInput = parsed as Record<string, unknown>
        } catch { /* keep empty input on malformed arguments */ }
        actions.push({
          kind: 'message',
          message: {
            type: 'tool_use',
            content: `Using tool: ${data.name ?? 'unknown'}`,
            metadata: {
              toolName: data.name ?? 'unknown',
              toolInput,
              toolUseId: typeof data.callId === 'string' ? data.callId : null,
            },
          },
        })
        break
      }

      case 'tool/result': {
        const block = data.message?.content?.find?.((b: { type: string }) => b.type === 'tool-result')
        const content = textOf(block?.content)
        const isError = Boolean(block?.isError)
        actions.push({
          kind: 'message',
          message: {
            type: 'tool_result',
            content,
            metadata: {
              toolResult: content,
              toolUseId: typeof block?.toolCallId === 'string' ? block.toolCallId : null,
              error: isError ? content || 'Tool execution failed' : undefined,
              isError,
            },
          },
        })
        break
      }

      case 'turn/end': {
        const reason = data.reason ?? { kind: 'unknown' }
        actions.push({ kind: 'turnEnd', turn: data.turn, reason })
        break
      }

      default:
        break
    }
    return actions
  }

  /** Latest usage snapshot (the getContextUsage equivalent source). */
  usage(): DshUsageSnapshot | null {
    return this.lastUsage
  }

  private withRoute(usage: Partial<DshUsageSnapshot> | undefined): DshUsageSnapshot | null {
    if (usage === undefined) return null
    return {
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens: usage.reasoningTokens,
      provider: this.provider,
      model: this.model,
    }
  }
}
