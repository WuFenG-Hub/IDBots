// IDBots DSH Phase 0 spike: standalone SDK runtime bin.
//
// Boots the composed plugin tree (cordis.jsonrpc.yml mounts
// dsh-sdk-jsonrpc-server) and keeps the process alive; stdin/stdout belong to
// the JSON-RPC protocol. This is the shape an IDBots release would ship as
// its own runtime executable — spawned and supervised by the Electron main
// process through @deepseek-ai/dsh-sdk-client.

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'

const here = path.dirname(fileURLToPath(import.meta.url))
const configPath = process.argv[2]
  ?? path.resolve(process.cwd(), process.env.DSH_CORDIS_CONFIG ?? 'cordis.jsonrpc.yml')

const ctx = await boot('idbots-sdk-runtime', path.resolve(configPath))
process.stderr.write(`[idbots-sdk-runtime] booted ${path.resolve(configPath)}\n`)

// Keep the event loop alive; the jsonrpc server owns stdin.
const keepalive = setInterval(() => {}, 1 << 30)
process.on('SIGTERM', () => { clearInterval(keepalive); process.exit(0) })
process.on('SIGINT', () => { clearInterval(keepalive); process.exit(0) })
