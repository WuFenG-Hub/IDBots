// IDBots DSH Phase 0 spike: wallet-style cordis service plugin.
//
// Simulates the shape of an IDBots feature module (MetaBot wallet) as a
// cordis Service occupying ctx.idbotsWallet, to validate the plugin authoring
// model: class plugin, service registration, config-driven state, and
// consumption by other plugins via inject.

import { Service } from '@deepseek-ai/cordis'

// stdout belongs to the JSON-RPC wire in sdk runtime mode; gate debug logs.
const spikeLog = (...args) => { if (!process.env.SPIKE_QUIET) console.log(...args) }


export default class IdbotsWalletService extends Service {
  constructor(ctx, config) {
    super(ctx, 'idbotsWallet')
    this.config = config
    this.accounts = new Map(Object.entries(config.initialBalances ?? { alice: 100, bob: 50 }))
  }

  listAccounts() {
    return [...this.accounts.entries()].map(([metaid, balance]) => ({ metaid, balance }))
  }

  async getBalance(metaid) {
    if (!this.accounts.has(metaid)) {
      throw new Error(`unknown account: ${metaid}`)
    }
    return { metaid, balance: this.accounts.get(metaid) }
  }

  async transfer(from, to, amount) {
    if (!Number.isFinite(amount) || amount <= 0) throw new Error('amount must be positive')
    const source = this.accounts.get(from)
    if (source === undefined) throw new Error(`unknown account: ${from}`)
    if (source < amount) throw new Error(`insufficient balance: ${source} < ${amount}`)
    const target = this.accounts.get(to) ?? 0
    this.accounts.set(from, source - amount)
    this.accounts.set(to, target + amount)
    const txid = `tx_${Date.now().toString(36)}`
    spikeLog(`[idbots-wallet] transfer ${amount} ${from} -> ${to} (${txid})`)
    return { txid, from, to, amount, balances: this.listAccounts() }
  }
}
