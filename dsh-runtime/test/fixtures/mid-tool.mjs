// Test fixture: a tool whose output (~15KB) sits between the spill-policy
// cap (8192) and the shaping cap (20000), so the spill path fires on the
// ORIGINAL text with no shaping involvement.

import { defineTool } from '@deepseek-ai/dsh-tools'

export default {
  name: 'idbots-mid-tool',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register(defineTool({
      name: 'mid_output_tool',
      description: 'Returns a ~15KB payload. Test fixture for tool-result spill.',
      parameters: {
        note: { type: 'string', description: 'Ignored note.' },
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args) {
        return {
          head: 'MID-BLOB-START',
          blob: 'y'.repeat(15000),
          tail: 'MID-BLOB-END',
          note: args.note ?? '',
        }
      },
    }))
  },
}
