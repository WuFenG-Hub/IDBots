// Test fixture: a tool whose output exceeds the shaping budget, so the real
// pi-ai request path exercises commit-time tool-result shaping end to end.

import { defineTool } from '@deepseek-ai/dsh-tools'

export default {
  name: 'idbots-big-tool',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register(defineTool({
      name: 'big_output_tool',
      description: 'Returns a very large payload. Test fixture for result shaping.',
      parameters: {
        note: { type: 'string', description: 'Ignored note.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return {
          head: 'BIG-BLOB-START',
          blob: 'x'.repeat(60000),
          tail: 'BIG-BLOB-END',
          note: args.note ?? '',
        }
      },
    }))
  },
}
