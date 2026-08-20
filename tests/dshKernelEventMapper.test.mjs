// M4 unit test: DshEventMapper turns recorded rc.6 wire envelopes into the
// same message/streaming/turn contract handleClaudeEvent produces.
// All fixtures are verbatim recorded shapes (M1-M3 wire traffic).

import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'

const require = Module.createRequire(import.meta.url)
const { DshEventMapper } = require('../dist-electron/main/libs/dshKernel/dshEventMapper.js')
const { splitThinkTaggedContent } = require('../dist-electron/main/libs/dshKernel/thinkTags.js')

const kinds = (actions) => actions.map((a) => a.kind)

test('user/message events map to nothing — the host records user bubbles', () => {
  const mapper = new DshEventMapper()
  // Human input, plugin runtime-context snapshots, and tool carries are all
  // model-facing facts; echoing them would duplicate the submission path's
  // own user messages (prompts and steers alike).
  for (const source of [{ kind: 'user' }, { kind: 'plugin', form: 'snapshot' }, { kind: 'tool', callId: 'c1' }]) {
    const actions = mapper.consume({
      type: 'user/message',
      seq: 4,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'x' }], source },
    })
    assert.deepEqual(actions, [])
  }
})

test('text deltas open a streaming slot and update with accumulated content', () => {
  const mapper = new DshEventMapper()
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'mock ' } },
  })
  assert.deepEqual(kinds(opened), ['message', 'messageUpdate'])
  assert.equal(opened[0].slot, 'text')
  assert.equal(opened[0].message.metadata.isStreaming, true)
  assert.equal(opened[1].content, 'mock ')

  const more = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'says' } },
  })
  assert.deepEqual(kinds(more), ['messageUpdate'])
  assert.equal(more[0].content, 'mock says')
})

test('reasoning deltas stream into a separate thinking slot', () => {
  const mapper = new DshEventMapper()
  const actions = mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } },
  })
  assert.equal(actions[0].slot, 'thinking')
  assert.equal(actions[0].message.metadata.isThinking, true)
})

test('assistant/message finalizes open slots and reports usage with route', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'request/header', data: { header: { config: { provider: 'mockgw', model: 'mock-1' } } } })
  mapper.consume({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', index: 0, text: 'hi' } } })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], source: { kind: 'model' } },
      usage: { inputTokens: 11, outputTokens: 7 },
    },
  })
  assert.deepEqual(kinds(done), ['messageFinalize', 'usage'])
  assert.equal(done[0].slot, 'text')
  assert.equal(done[0].content, 'hi')
  assert.equal(done[1].usage.provider, 'mockgw')
  assert.equal(mapper.usage().inputTokens, 11)
})

test('tool call and result map to tool_use / tool_result messages', () => {
  const mapper = new DshEventMapper()
  const call = mapper.consume({
    type: 'tool/call',
    data: { turn: 2, step: 1, callId: 'call_spike_ping_1', name: 'spike_ping', arguments: '{"echo":"hi"}' },
  })
  assert.equal(call[0].message.type, 'tool_use')
  assert.equal(call[0].message.metadata.toolName, 'spike_ping')
  assert.deepEqual(call[0].message.metadata.toolInput, { echo: 'hi' })
  assert.equal(call[0].message.metadata.toolUseId, 'call_spike_ping_1')

  const result = mapper.consume({
    type: 'tool/result',
    data: {
      turn: 2, step: 1,
      message: {
        source: { kind: 'tool', callId: 'call_spike_ping_1' },
        content: [{
          type: 'tool-result',
          toolCallId: 'call_spike_ping_1',
          content: [{ type: 'text', text: '{"pong":"hi"}' }],
          isError: false,
        }],
      },
    },
  })
  assert.equal(result[0].message.type, 'tool_result')
  assert.equal(result[0].message.metadata.toolUseId, 'call_spike_ping_1')
  assert.equal(result[0].message.metadata.isError, false)
  assert.equal(result[0].message.content, '{"pong":"hi"}')
})

test('denied tool result keeps isError and surfaces the deny reason', () => {
  const mapper = new DshEventMapper()
  const result = mapper.consume({
    type: 'tool/result',
    data: {
      message: {
        content: [{
          type: 'tool-result',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'the user rejected tool "dangerous_tool"' }],
          isError: true,
        }],
      },
    },
  })
  assert.equal(result[0].message.metadata.isError, true)
  assert.match(result[0].message.content, /rejected/)
})

test('turn/end maps with reason; aborted carries the cause', () => {
  const mapper = new DshEventMapper()
  const ended = mapper.consume({
    type: 'turn/end',
    data: { turn: 5, reason: { kind: 'aborted', reason: 'm1 wire cancel' } },
  })
  assert.deepEqual(kinds(ended), ['turnEnd'])
  assert.equal(ended[0].reason.kind, 'aborted')
  assert.equal(ended[0].reason.reason, 'm1 wire cancel')
})

test('empty terminal turn flags a clean stop with no text and no tool calls', () => {
  const mapper = new DshEventMapper()
  // The DeepSeek truncation signature: only reasoning deltas, then a clean stop.
  mapper.consume({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking…' } } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.kind, 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, true)
  const thinkingDone = ended.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  assert.equal(thinkingDone.content, 'thinking…')
})

test('turn/end with text output is not an empty terminal turn', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' } } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, undefined)
})

test('turn/end after tool calls is not an empty terminal turn', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  assert.equal(ended[0].emptyTerminal, undefined)
})

test('empty-terminal flags reset between turns', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } } })
  mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  // Next turn produces nothing at all — still empty (reasoning-only or fully silent).
  const second = mapper.consume({ type: 'turn/end', data: { turn: 2, reason: { kind: 'stop' } } })
  assert.equal(second[0].emptyTerminal, true)
})

test('non-stop reasons never flag empty terminal', () => {
  const mapper = new DshEventMapper()
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'max-tokens' } } })
  assert.equal(ended[0].emptyTerminal, undefined)
})

test('assistant/message reasoning blocks become a thinking slot', () => {
  const mapper = new DshEventMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need to inspect git first' },
          { type: 'text', text: 'I will run git status.' },
        ],
      },
    },
  })
  assert.equal(done[0].slot, 'thinking')
  assert.equal(done[0].message.metadata.isThinking, true)
  assert.equal(done[1].slot, 'thinking')
  assert.equal(done[1].content, 'need to inspect git first')
  assert.equal(done[2].slot, 'text')
  assert.equal(done[3].content, 'I will run git status.')
})

test('text-delta think tags stream into the thinking slot and leave visible text', () => {
  const mapper = new DshEventMapper()
  const first = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: '<think>plan it</think>hello' } },
  })
  assert.equal(first[0].slot, 'thinking')
  assert.equal(first[0].message.metadata.isThinking, true)
  assert.equal(first[1].content, 'plan it')
  assert.equal(first[2].slot, 'text')
  assert.equal(first[3].content, 'hello')

  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, undefined)
})

test('think-tag-only text-delta is an empty terminal turn (reasoning, no reply)', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: '<think>still figuring it out</think>' } },
  })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, true)
})

test('block-start reasoning opens the thinking slot before deltas arrive', () => {
  const mapper = new DshEventMapper()
  const opened = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  assert.equal(opened[0].slot, 'thinking')
  assert.equal(opened[0].message.metadata.isThinking, true)
})

// ---- DeepSeek Responses phase classification ------------------------------
// Text items arrive tagged commentary (thinking out loud around tool calls)
// or final_answer (the visible reply); the tag rides the assembled replay
// state only — content blocks and streaming deltas carry no phase.

const sig = (phase) => JSON.stringify({ v: 1, id: 'msg_1', phase })

test('streamed commentary text converts the text message into thinking at finalize', () => {
  const mapper = new DshEventMapper()
  // Commentary streams as plain text (phase unknown on the wire mid-stream).
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 3, step: 1, chunk: { type: 'text-delta', index: 0, text: '让我先查一下配置。' } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 3, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: '让我先查一下配置。' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
        source: {
          kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash',
          replayState: { kind: 'pi-ai', version: 1, api: 'openai-responses', blocks: [
            { type: 'text', textSignature: sig('commentary') },
            { type: 'tool-call' },
          ] },
        },
      },
    },
  })
  const finalize = done.find((a) => a.kind === 'messageFinalize')
  assert.equal(finalize.slot, 'text')
  assert.equal(finalize.content, '让我先查一下配置。')
  assert.equal(finalize.metadata.isThinking, true, 'streamed text message reclassifies to thinking')
  // A commentary-only step followed by its tool call must not look empty.
  mapper.consume({ type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 3, reason: { kind: 'aborted', reason: 'cancel' } } })
  assert.equal(ended[0].kind, 'turnEnd')
})

test('final_answer text stays visible (no thinking metadata)', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 4, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Here is the result.' } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 4, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Here is the result.' }],
        source: { kind: 'model', replayState: { blocks: [{ type: 'text', textSignature: sig('final_answer') }] } },
      },
    },
  })
  const finalize = done.find((a) => a.kind === 'messageFinalize')
  assert.equal(finalize.slot, 'text')
  assert.equal(finalize.content, 'Here is the result.')
  assert.equal(finalize.metadata, undefined)
})

test('a turn whose only output is commentary is an empty terminal turn', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { turn: 5, step: 1, chunk: { type: 'text-delta', index: 0, text: '考虑一下该怎么回答……' } },
  })
  mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 5, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '考虑一下该怎么回答……' }],
        source: { kind: 'model', replayState: { blocks: [{ type: 'text', textSignature: sig('commentary') }] } },
      },
    },
  })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 5, reason: { kind: 'stop' } } })
  // Commentary reclassified as thinking → nothing visible → the auto-continue
  // guard must fire instead of reporting a hollow completed turn.
  const turnEnd = ended.find((a) => a.kind === 'turnEnd')
  assert.equal(turnEnd.emptyTerminal, true)
})

test('unassembled commentary (block-end only) opens a thinking message', () => {
  const mapper = new DshEventMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 6, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Thinking out loud without any streamed deltas.' },
          { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
        ],
        source: { kind: 'model', replayState: { blocks: [
          { type: 'text', textSignature: sig('commentary') },
          { type: 'tool-call' },
        ] } },
      },
    },
  })
  // No text slot was streamed, so commentary materializes as a thinking
  // message. The slot stays streaming across the tool round (update, not
  // finalize) so the ThinkingBlock does not collapse before the next step.
  const opened = done.find((a) => a.kind === 'message')
  assert.equal(opened.slot, 'thinking')
  assert.equal(opened.message.metadata.isThinking, true)
  const updated = done.find((a) => a.kind === 'messageUpdate' && a.slot === 'thinking')
  assert.equal(updated.content, 'Thinking out loud without any streamed deltas.')
  assert.equal(done.some((a) => a.kind === 'messageFinalize' && a.slot === 'thinking'), false)
})

test('mixed commentary and final text split across slots in order', () => {
  const mapper = new DshEventMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 7, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'First, deliberation.' },
          { type: 'text', text: 'The final answer.' },
        ],
        source: { kind: 'model', replayState: { blocks: [
          { type: 'text', textSignature: sig('commentary') },
          { type: 'text', textSignature: sig('final_answer') },
        ] } },
      },
    },
  })
  const thinking = done.filter((a) => a.slot === 'thinking').find((a) => a.kind === 'messageFinalize')
  assert.equal(thinking.content, 'First, deliberation.')
  const textFinal = done.filter((a) => a.slot === 'text').find((a) => a.kind === 'messageFinalize')
  assert.equal(textFinal.content, 'The final answer.')
  assert.equal(textFinal.metadata, undefined)
})

test('unsigned replay signatures keep the legacy all-visible classification', () => {
  const mapper = new DshEventMapper()
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 8, step: 1,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'plain visible reply' }],
        source: { kind: 'model', replayState: { blocks: [{ type: 'text' }] } },
      },
    },
  })
  const finalize = done.find((a) => a.kind === 'messageFinalize')
  assert.equal(finalize.slot, 'text')
  assert.equal(finalize.content, 'plain visible reply')
  assert.equal(finalize.metadata, undefined)
})

test('native DeepSeek tool-step text folds into thinking and does not open a visible bubble', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: 'need a tool' } },
  })
  const done = mapper.consume({
    type: 'assistant/message',
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'need a tool' },
          { type: 'text', text: '本地没装 tsx，用 npx 临时拉一个跑（不碰 package.json）：' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  assert.equal(done.some((a) => a.slot === 'text'), false, 'commentary must not become a visible bubble')
  assert.equal(done.some((a) => a.kind === 'messageFinalize' && a.slot === 'thinking'), false, 'thinking stays streaming across the tool round')
  const updated = done.find((a) => a.kind === 'messageUpdate' && a.slot === 'thinking')
  assert.match(updated.content, /need a tool/)
  assert.match(updated.content, /本地没装 tsx/)
})

test('native DeepSeek keeps one thinking slot across tool rounds and only finalizes on the reply', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: 'first plan' } },
  })
  const step1 = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'first plan' },
          { type: 'text', text: '先看仓库结构。' },
          { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
        ],
      },
    },
  })
  assert.equal(step1.filter((a) => a.kind === 'message' && a.slot === 'thinking').length, 0)

  const step2open = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: ' next' } },
  })
  assert.equal(step2open.some((a) => a.kind === 'message'), false, 'must reuse the live thinking slot')
  assert.equal(step2open[0].kind, 'messageUpdate')
  assert.match(step2open[0].content, /first plan/)
  assert.match(step2open[0].content, /先看仓库结构/)
  assert.match(step2open[0].content, / next/)

  mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'next' },
          { type: 'text', text: '继续读安装器。' },
          { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' },
        ],
      },
    },
  })

  const reply = mapper.consume({
    type: 'assistant/message',
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'ready to answer' },
          { type: 'text', text: '## 本轮测试汇总' },
        ],
      },
    },
  })
  const thinkingDone = reply.find((a) => a.kind === 'messageFinalize' && a.slot === 'thinking')
  const textDone = reply.find((a) => a.kind === 'messageFinalize' && a.slot === 'text')
  assert.equal(reply.some((a) => a.kind === 'message' && a.slot === 'thinking'), false, 'reply must not open a second thinking bubble')
  assert.match(thinkingDone.content, /first plan/)
  assert.match(thinkingDone.content, /先看仓库结构/)
  assert.match(thinkingDone.content, /继续读安装器/)
  assert.match(thinkingDone.content, /ready to answer/)
  assert.equal(textDone.content, '## 本轮测试汇总')
  assert.equal(textDone.metadata, undefined)
})

test('reasoning-chunks stream into the thinking slot like the DSH web UI', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  const first = mapper.consume({
    type: 'reasoning-chunks',
    data: { turn: 1, step: 1, index: 0, texts: ['The', ' user', ' wants'] },
  })
  assert.equal(first.some((a) => a.kind === 'message' && a.slot === 'thinking'), false, 'block-start already opened the slot')
  assert.equal(first[0].kind, 'messageUpdate')
  assert.equal(first[0].slot, 'thinking')
  assert.equal(first[0].content, 'The user wants')

  const more = mapper.consume({
    type: 'reasoning-chunks',
    data: { turn: 1, step: 1, index: 0, texts: [' a', ' tool'] },
  })
  assert.equal(more[0].content, 'The user wants a tool')

  const echoed = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'reasoning-delta', index: 0, text: ' a' } },
  })
  assert.deepEqual(echoed, [], 'sparse reasoning-delta must not double-count after chunks')
})

test('text-delta after a native reasoning block does not open a body bubble', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  })
  const leaked = mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 1, text: '本地没装 tsx，用 npx 临时拉一个跑：' } },
  })
  assert.equal(leaked.some((a) => a.slot === 'text'), false)
})

test('compaction/summary maps to a system checkpoint with counts and summary text', () => {
  const mapper = new DshEventMapper()
  const actions = mapper.consume({
    type: 'compaction/summary',
    data: {
      summary: [{ type: 'text', text: 'Earlier turns discussed the install path.' }],
      shadowedSeqs: [1, 2, 3],
      shadowedTokenCount: 420,
    },
  })
  assert.equal(actions.length, 1)
  assert.equal(actions[0].kind, 'message')
  assert.equal(actions[0].message.type, 'system')
  assert.equal(actions[0].message.metadata.compaction, true)
  assert.match(actions[0].message.content, /Compacted 3 history items \(~420 tokens\)/)
  assert.match(actions[0].message.content, /Earlier turns discussed the install path/)
})

test('compaction/start is silent; compaction/end only reports failures', () => {
  const mapper = new DshEventMapper()
  assert.deepEqual(mapper.consume({ type: 'compaction/start', data: { turn: null } }), [])
  assert.deepEqual(mapper.consume({ type: 'compaction/end', data: { turn: null } }), [])
  const failed = mapper.consume({
    type: 'compaction/end',
    data: { turn: null, error: 'summary unavailable' },
  })
  assert.equal(failed[0].message.type, 'system')
  assert.equal(failed[0].message.metadata.isError, true)
  assert.match(failed[0].message.content, /Compaction failed: summary unavailable/)
})

test('splitThinkTaggedContent extracts think and thinking tags', () => {
  assert.deepEqual(splitThinkTaggedContent('plain reply'), { thinking: '', text: 'plain reply' })
  assert.deepEqual(
    splitThinkTaggedContent('<think>plan</think>answer'),
    { thinking: 'plan', text: 'answer' },
  )
  assert.deepEqual(
    splitThinkTaggedContent('<thinking>plan</thinking>\nanswer'),
    { thinking: 'plan', text: '\nanswer' },
  )
  assert.deepEqual(
    splitThinkTaggedContent('<think>unclosed'),
    { thinking: 'unclosed', text: '' },
  )
})
