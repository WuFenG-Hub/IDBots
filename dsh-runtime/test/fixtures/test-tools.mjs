// Test-fixture tools for the M1/M2 wire tests: slow_tool gives session/steer a
// step-boundary window; dangerous_tool plus the ask policy drives the approval
// channel (the fake LLM calls them on STEER_TEST / TOOL:DANGEROUS markers).

import { defineTool } from '@deepseek-ai/dsh-tools'

export default {
  name: 'idbots-test-tools',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register(defineTool({
      name: 'slow_tool',
      description: 'Sleep briefly then return. Test fixture only.',
      parameters: {
        note: { type: 'string', description: 'Ignored note.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args, exec) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500)
          exec.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true })
        })
        return { slept: true, note: args.note ?? '' }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'dangerous_tool',
      description: 'Requires human approval before running. Test fixture only.',
      parameters: {
        payload: { type: 'number', required: true, description: 'Ignored payload.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return { executed: true, payload: args.payload }
      },
    }))

    // Ask policy: routes dangerous_tool into the approval seam (dsh-user-approval
    // owns the ask resolution; idbots-sdk-server bridges it to the wire).
    ctx.on('tools/pre-execute', (exec, next) => {
      if (exec?.name === 'dangerous_tool') {
        return { kind: 'ask', reason: 'test fixture: dangerous_tool needs human confirmation' }
      }
      return next()
    }, { global: true })
  },
}
