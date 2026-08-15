// IDBots DSH Phase 0 spike: custom tools + permission gate.
//
// Validates the two seams IDBots needs from a kernel:
//  1. ctx.tools.register(defineTool(...)) — porting the existing minimal-shape
//     tool factories (upload_file, metabot_manage, ...) onto the DSH registry.
//  2. tools/pre-execute waterfall — the equivalent surface of the Claude SDK's
//     canUseTool callback. NOTE: the event carries an agent-scope filter, so a
//     host-wide policy listener must register with { global: true } (or per
//     agent via CreateAgentOptions.setup). Here: deterministic deny for large
//     transfers, mirroring enforceToolSafetyPolicy.

import { defineTool } from '@deepseek-ai/dsh-tools'

// stdout belongs to the JSON-RPC wire in sdk runtime mode; gate debug logs.
const spikeLog = (...args) => { if (!process.env.SPIKE_QUIET) console.log(...args) }


const renderJson = (args, value) => {
  spikeLog(`[idbots-tools] render enter for value=${JSON.stringify(value)?.slice(0, 60)}`)
  return [{ type: 'text', text: JSON.stringify(value) }]
}

export default {
  name: 'idbots-tools',
  inject: ['tools', 'idbotsWallet'],
  apply(ctx) {
    ctx.tools.register(defineTool({
      name: 'wallet_balance',
      description: 'Read the wallet balance for a MetaID account. Use when asked how much funds an account holds.',
      parameters: {
        metaid: { type: 'string', required: true, description: 'The MetaID account to query.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args) {
        spikeLog(`[idbots-tools] wallet_balance execute enter args=${JSON.stringify(args)}`)
        const value = await ctx.idbotsWallet.getBalance(args.metaid)
        spikeLog(`[idbots-tools] wallet_balance execute ok value=${JSON.stringify(value)}`)
        return value
      },
    }))

    ctx.tools.register(defineTool({
      name: 'spike_ping',
      description: 'Echo a value back. Spike-only probe tool.',
      parameters: {
        echo: { type: 'string', required: true, description: 'Value to echo.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args) {
        return { pong: args.echo, at: new Date().toISOString() }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'slow_tool',
      description: 'Sleep briefly then return. Gives the spike driver a window to steer mid-turn.',
      parameters: {
        note: { type: 'string', description: 'Ignored note.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args, exec) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 1500)
          exec.signal?.addEventListener('abort', () => clearTimeout(timer), { once: true })
        })
        return { slept: true, note: args.note ?? '' }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'wallet_transfer_gated',
      description: 'Transfer funds between accounts. Subject to the spike permission policy.',
      parameters: {
        to: { type: 'string', required: true, description: 'Destination MetaID.' },
        amount: { type: 'number', required: true, description: 'Amount to transfer.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: renderJson },
      async execute(args) {
        return ctx.idbotsWallet.transfer('alice', args.to, args.amount)
      },
    }))

    // Permission seam: host-wide deny for large amounts. Registered with
    // { global: true } because tools/pre-execute dispatches through an
    // agent-scope carrier that filters ordinary fiber-context listeners out.
    ctx.on('tools/pre-execute', async (exec, next) => {
      // ToolExecution fields: token, callId, rootCallId, name, signal, agent,
      // deferContext, concludeTurn, arguments (not `args`).
      const name = exec?.name
      const argsJson = JSON.stringify(exec?.arguments ?? {}) ?? ''
      spikeLog(`[idbots-tools] pre-execute seen: ${name ?? '?'} args=${argsJson.slice(0, 60)}`)
      const amount = exec?.arguments?.amount
      if (name === 'wallet_transfer_gated' && amount > 1000) {
        spikeLog(`[idbots-tools] pre-execute DENY ${name} amount=${amount}`)
        return { kind: 'deny', reason: 'spike policy: transfers above 1000 require human confirmation' }
      }
      return next()
    }, { global: true })
  },
}
