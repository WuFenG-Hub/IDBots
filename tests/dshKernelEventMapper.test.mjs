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
  assert.equal(ended[0].kind, 'turnEnd')
  assert.equal(ended[0].emptyTerminal, true)
})

test('turn/end with text output is not an empty terminal turn', () => {
  const mapper = new DshEventMapper()
  mapper.consume({ type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'answer' } } })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  assert.equal(ended[0].emptyTerminal, undefined)
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
  assert.equal(ended[0].emptyTerminal, undefined)
})

test('think-tag-only text-delta is an empty terminal turn (reasoning, no reply)', () => {
  const mapper = new DshEventMapper()
  mapper.consume({
    type: 'assistant/chunk',
    data: { chunk: { type: 'text-delta', index: 0, text: '<think>still figuring it out</think>' } },
  })
  const ended = mapper.consume({ type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } })
  assert.equal(ended[0].emptyTerminal, true)
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
