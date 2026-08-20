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
//    thinking slot so the renderer can reuse Claude's ThinkingBlock
//  - DeepSeek Responses (pi-ai) tags text items commentary/final_answer in
//    the assembled replay state; commentary ("thinking out loud" around tool
//    calls) is reclassified into the thinking slot at finalize
//  - Official DeepSeek on dsh-llm-deepseek has no phase tags: text that
//    accompanies tool calls is treated as commentary, and the thinking slot
//    stays open across those tool rounds so the transcript does not bounce
//    (expand → tiny summary → collapse → expand) on every step

import type { DshMapperAction, DshSessionEventEnvelope, DshUsageSnapshot } from './types'
import { splitThinkTaggedContent } from './thinkTags'

const textOf = (blocks: Array<{ type: string; text?: string }> | undefined): string =>
  (blocks ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('')

const reasoningOf = (blocks: Array<{ type: string; text?: string }> | undefined): string =>
  (blocks ?? []).filter((b) => b.type === 'reasoning').map((b) => b.text ?? '').join('')

const hasToolCallIn = (blocks: Array<{ type: string }> | undefined): boolean =>
  (blocks ?? []).some((b) => b.type === 'tool-call' || b.type === 'tool_use')

const joinThinking = (parts: string[]): string =>
  parts.filter((part) => part.length > 0).join('\n\n')

type TextPhase = 'commentary' | 'final_answer'

/** Parse one pi-ai textSignature (`{"v":1,"id":…,"phase":…}`) into its phase. */
const phaseOfSignature = (signature: unknown): TextPhase | undefined => {
  if (typeof signature !== 'string' || signature.length === 0) return undefined
  try {
    const parsed = JSON.parse(signature)
    if (parsed && typeof parsed === 'object'
      && (parsed.phase === 'commentary' || parsed.phase === 'final_answer')) {
      return parsed.phase
    }
  } catch { /* malformed signatures stay unclassified */ }
  return undefined
}

/**
 * Ordered phases of the message's text blocks, from the assembled replay
 * state (`source.replayState.blocks[].textSignature`). DeepSeek's Responses
 * API tags every text item `commentary` (thinking out loud around tool
 * calls) or `final_answer` (the user-visible reply); pi-ai preserves the tag
 * only there — the wire `content` blocks and streaming deltas carry no phase.
 * Returns null when no block carries a phase (other providers/protocols keep
 * the legacy all-visible classification).
 */
const replayTextPhasesOf = (message: {
  content?: Array<{ type: string; text?: string }>
  source?: { replayState?: { blocks?: Array<{ type: string; textSignature?: unknown }> } }
} | undefined): Array<TextPhase | undefined> | null => {
  const blocks = message?.source?.replayState?.blocks
  if (!Array.isArray(blocks)) return null
  const phases: Array<TextPhase | undefined> = []
  let sawPhase = false
  for (const block of blocks) {
    if (block?.type !== 'text') continue
    const phase = phaseOfSignature(block.textSignature)
    if (phase !== undefined) sawPhase = true
    phases.push(phase)
  }
  return sawPhase ? phases : null
}

export class DshEventMapper {
  private textOpen = false
  private textBuf = ''
  private thinkingOpen = false
  private thinkingBuf = ''
  /**
   * Thinking already accepted for earlier tool-call steps of this turn.
   * Held across assistant/message boundaries so one ThinkingBlock stays
   * streaming instead of collapsing and reopening on every round.
   */
  private thinkingHeld = ''
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
  private turnSawToolCall = false
  /** Sticky per-turn: a step finalized VISIBLE reply text (commentary-phase
   * text finalized into thinking does not count — a turn whose only output is
   * commentary must still look empty so the auto-continue guard can fire). */
  private turnSawFinalText = false
  /** Text streamed since the last assistant/message finalize — the defensive
   * "produced something" signal for streams that end without assembling. */
  private turnSawStreamedText = false

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
            this.thinkingBuf = this.prefixHeld(split.thinking)
            actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
          }
          // Native reasoning already live this turn: hold text until
          // assistant/message proves it is the final answer, not commentary.
          if (split.text.length > 0 && !this.reasoningFromDeltas && !this.thinkingHeld) {
            this.openText(actions)
            this.textBuf = split.text
            this.turnSawStreamedText = true
            actions.push({ kind: 'messageUpdate', slot: 'text', content: this.textBuf })
          }
        } else if (chunk?.type === 'reasoning-delta') {
          this.reasoningFromDeltas = true
          this.openThinking(actions)
          if (this.thinkingHeld && this.thinkingBuf === this.thinkingHeld) {
            this.thinkingBuf = `${this.thinkingHeld}\n\n`
          }
          this.thinkingBuf += chunk.text ?? ''
          actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
        } else if (chunk?.type === 'block-end' && chunk.block?.type === 'reasoning') {
          const assembled = typeof chunk.block.text === 'string' ? chunk.block.text : ''
          if (assembled.length > 0) {
            this.openThinking(actions)
            this.thinkingBuf = this.prefixHeld(assembled)
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
        const emptyTerminal = reason.kind === 'stop'
          && !this.turnSawFinalText
          && !this.turnSawStreamedText
          && !this.turnSawToolCall
        this.closeOpenSlots(actions)
        actions.push({
          kind: 'turnEnd',
          turn: data.turn,
          reason,
          ...(emptyTerminal ? { emptyTerminal: true } : {}),
        })
        this.turnSawFinalText = false
        this.turnSawStreamedText = false
        this.turnSawToolCall = false
        break
      }

      case 'compaction/summary': {
        const summaryBlocks = Array.isArray(data.summary) ? data.summary : []
        const summaryText = textOf(summaryBlocks).trim()
        const items = Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0
        const tokens = typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0
        const header = `Compacted ${items} history items (~${tokens} tokens).`
        actions.push({
          kind: 'message',
          message: {
            type: 'system',
            content: summaryText.length > 0 ? `${header}\n\n${summaryText}` : header,
            metadata: { compaction: true },
          },
        })
        break
      }

      case 'compaction/end': {
        if (data.error) {
          const detail = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
          actions.push({
            kind: 'message',
            message: {
              type: 'system',
              content: `Compaction failed: ${detail}`,
              metadata: { compaction: true, isError: true },
            },
          })
        }
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

  /** Prefix this step's reasoning with thinking already held from earlier tool rounds. */
  private prefixHeld(stepText: string): string {
    return joinThinking([this.thinkingHeld, stepText])
  }

  /** Collapse any live slots at a real turn boundary so isStreaming cannot stick. */
  private closeOpenSlots(actions: DshMapperAction[]): void {
    if (this.thinkingOpen) {
      this.thinkingOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'thinking', content: this.thinkingBuf })
      this.thinkingBuf = ''
      this.thinkingHeld = ''
    }
    if (this.textOpen) {
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: this.textBuf })
      this.textBuf = ''
    }
  }

  private finalizeAssistantMessage(
    actions: DshMapperAction[],
    data: { message?: { content?: Array<{ type: string; text?: string }>; source?: { replayState?: { blocks?: Array<{ type: string; textSignature?: unknown }> } } } }
  ): void {
    const blocks = data.message?.content
    let reasoning = reasoningOf(blocks)
    let visibleText = textOf(blocks)
    let commentary = ''
    const hasToolCall = hasToolCallIn(blocks)

    const phases = replayTextPhasesOf(data.message)
    if (phases) {
      // Phase-classified text (DeepSeek Responses): commentary segments are
      // thinking-aloud around tool calls, only final_answer is the reply.
      // Content text blocks and replay text blocks are two projections of the
      // same stream, so walking both in order pairs every block with its tag.
      const commentaryParts: string[] = []
      const finalParts: string[] = []
      let index = 0
      for (const block of blocks ?? []) {
        if (block.type !== 'text') continue
        const text = block.text ?? ''
        if (text.length > 0) {
          if (phases[index] === 'commentary') commentaryParts.push(text)
          else finalParts.push(text)
        }
        index += 1
      }
      commentary = commentaryParts.join('\n\n')
      visibleText = splitThinkTaggedContent(finalParts.join('\n\n')).text
    } else if (hasToolCall) {
      // Native DeepSeek (dsh-llm-deepseek) has no commentary/final_answer
      // tags. Text that rides alongside tool calls is thinking-aloud — the
      // same class of content the Responses path folded into ThinkingBlock.
      commentary = splitThinkTaggedContent(visibleText).text
      visibleText = ''
    } else if (!reasoning) {
      const split = splitThinkTaggedContent(visibleText || this.rawTextBuf)
      reasoning = split.thinking || (!this.thinkingHeld ? this.thinkingBuf : '')
      visibleText = split.text
    } else {
      visibleText = splitThinkTaggedContent(visibleText).text
    }

    // A commentary-only message whose text already streamed into the text slot
    // converts that message in place (finalize as thinking) — no separate
    // thinking message and no empty visible bubble left behind. Skip when a
    // thinking slot is already live: fold commentary into it instead of
    // minting a second ThinkingBlock.
    const convertStreamedTextToThinking = commentary.length > 0
      && visibleText.length === 0
      && this.textOpen
      && !this.thinkingOpen
      && !this.thinkingHeld

    const combinedThinking = this.prefixHeld(joinThinking([reasoning, commentary]))

    if (!convertStreamedTextToThinking && combinedThinking.length > 0) {
      this.openThinking(actions)
      this.thinkingBuf = combinedThinking
    }

    if (hasToolCall && this.thinkingOpen) {
      if (combinedThinking.length > 0) {
        this.thinkingHeld = this.thinkingBuf
        actions.push({ kind: 'messageUpdate', slot: 'thinking', content: this.thinkingBuf })
      }
    } else if (this.thinkingOpen) {
      this.thinkingOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'thinking', content: this.thinkingBuf })
      this.thinkingBuf = ''
      this.thinkingHeld = ''
    }

    if (visibleText.length > 0) {
      this.openText(actions)
      this.textBuf = visibleText
      this.turnSawFinalText = true
    }
    if (convertStreamedTextToThinking) {
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: commentary, metadata: { isThinking: true } })
      this.textBuf = ''
    } else if (this.textOpen && visibleText.length === 0) {
      // Commentary was held or folded; close the leaked visible placeholder
      // so a tiny summary cannot linger between thinking rounds.
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: '' })
      this.textBuf = ''
    } else if (this.textOpen) {
      this.textOpen = false
      actions.push({ kind: 'messageFinalize', slot: 'text', content: this.textBuf })
      this.textBuf = ''
    }

    this.rawTextBuf = ''
    this.reasoningFromDeltas = false
    this.turnSawStreamedText = false
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
