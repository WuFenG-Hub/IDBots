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
//  - some DeepSeek/gateway routes leak chain-of-thought into text-delta as
//    <think> tags instead of reasoning-delta; those are split into the
//    thinking slot so the renderer can reuse Claude's ThinkingBlock.

import type { DshMapperAction, DshSessionEventEnvelope, DshUsageSnapshot } from './types'
import { splitThinkTaggedContent } from './thinkTags'

const textOf = (blocks: Array<{ type: string; text?: string }> | undefined): string =>
  (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

const reasoningOf = (blocks: Array<{ type: string; text?: string }> | undefined): string =>
  (blocks ?? []).filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('')

export class DshEventMapper {
  private textOpen = false
  private textBuf = ''
  private thinkingOpen = false
  private thinkingBuf = ''
  /** Accumulated raw text-delta (may still contain <think> tags). */
  private rawTextBuf = ''
  /** True once a native reasoning-delta opened the thinking slot this step. */
  private reasoningFromDeltas = false
  private lastUsage: DshUsageSnapshot | null = null
  private provider: string | undefined
  private model: string | undefined
  // Per-turn activity signals for the empty-terminal-turn guard: a turn that
  // ends 'stop' having produced neither text nor tool calls ended before doing
  // anything — the DeepSeek reasoning-only truncation the Claude path
  // auto-continues on (bf15f63d). Flags reset at every turn/end.
  private turnSawText = false
  private turnSawToolCall = false

  consume(envelope: DshSessionEventEnvelope): DshMapperAction[] {
    const actions: DshMapperAction[] = []
    const data = envelope.data ?? {}
    switch (envelope.type) {
      case 'user/message': {
        // NOT mapped: the host's submission path already records user bubbles
        // for prompts and steers (same as handleClaudeEvent never echoes user
        // input back). All user-role events here — human input, plugin runtime
        // snapshots (approval policy), tool-result carries — are model-facing
        // facts only; tool results arrive as their own tool/result events.
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
        if (chunk?.type === 'block-start' && chunk.blockType === 'reasoning') {
          this.openThinking(actions)
        } else if (chunk?.type === 'text-delta') {
          this.rawTextBuf += chunk.text ?? ''
          const split = splitThinkTaggedContent(this.rawTextBuf)
          if (!this.reasoningFromDeltas && split.thinking.length > 0) {
            this.openThinking(actions)
            this.thinkingBuf = split.thinking
            actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
          }
          if (split.text.length > 0) {
            this.openText(actions)
            this.textBuf = split.text
            this.turnSawText = true
            actions.push({ kind: 'messageUpdate', slot: 'text', content: this.textBuf })
          }
        } else if (chunk?.type === 'reasoning-delta') {
          this.reasoningFromDeltas = true
          this.openThinking(actions)
          this.thinkingBuf += chunk.text ?? ''
          actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'reasoning') {
          const assembled = typeof chunk.block.text === 'string' ? chunk.block.text : ''
          if (assembled.length > 0) {
            this.openThinking(actions)
            this.thinkingBuf = assembled
            actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
          }
        } else if (chunk?.type === 'usage') {
          this.lastUsage = this.withRoute(chunk.usage)
        }
        break
      }

      case 'assistant/message': {
        this.finalizeAssistantMessage(actions, data)
        const usage = this.withRoute(data.usage ?? undefined)
        if (usage) {
          this.lastUsage = usage
          actions.push({ kind: 'usage', usage })
        }
        break
      }

      case 'tool/call': {
        this.turnSawToolCall = true
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
        // Empty terminal turn: a clean 'stop' with no text and no tool calls
        // this turn — the model emitted (at most) reasoning and ended. Flag it
        // so the turn runner can auto-continue once instead of reporting a
        // hollow "completed" (parity with the Claude path's bf15f63d fix).
        const emptyTerminal = reason.kind === 'stop' && !this.turnSawText && !this.turnSawToolCall
        actions.push({
          kind: 'turnEnd',
          turn: data.turn,
          reason,
          ...(emptyTerminal ? { emptyTerminal: true } : {}),
        })
        this.turnSawText = false
        this.turnSawToolCall = false
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

  private openThinking(actions: DshMapperAction[]): void {
    if (this.thinkingOpen) return
    this.thinkingOpen = true
    this.thinkingBuf = ''
    actions.push({
      kind: 'message',
      slot: 'thinking',
      message: { type: 'assistant', content: '', metadata: { isThinking: true, isStreaming: true } },
    })
  }

  private openText(actions: DshMapperAction[]): void {
    if (this.textOpen) return
    this.textOpen = true
    this.textBuf = ''
    actions.push({
      kind: 'message',
      slot: 'text',
      message: { type: 'assistant', content: '', metadata: { isStreaming: true } },
    })
  }

  private finalizeAssistantMessage(actions: DshMapperAction[], data: { message?: { content?: Array<{ type: string; text?: string }> } }): void {
    const blocks = data.message?.content
    let reasoning = reasoningOf(blocks)
    let visibleText = textOf(blocks)

    if (!reasoning) {
      const split = splitThinkTaggedContent(visibleText || this.rawTextBuf)
      reasoning = split.thinking || this.thinkingBuf
      visibleText = split.text
    } else if (visibleText) {
      visibleText = splitThinkTaggedContent(visibleText).text
    }

    if (reasoning.length > 0) {
      this.openThinking(actions)
      this.thinkingBuf = reasoning
    }
    if (this.thinkingOpen) {
      this.thinkingOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'thinking', content: this.thinkingBuf })
      this.thinkingBuf = ''
    }

    if (visibleText.length > 0) {
      this.openText(actions)
      this.textBuf = visibleText
      this.turnSawText = true
    }
    if (this.textOpen) {
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: this.textBuf })
      this.textBuf = ''
    }

    this.rawTextBuf = ''
    this.reasoningFromDeltas = false
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
