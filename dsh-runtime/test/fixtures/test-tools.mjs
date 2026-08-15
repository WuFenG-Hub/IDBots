// Test-fixture tool for the M1 wire test: gives session/steer a step-boundary
// window (the fake LLM calls slow_tool on the STEER_TEST marker).

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
  },
}
