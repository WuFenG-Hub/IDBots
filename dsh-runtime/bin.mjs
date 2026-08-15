// IDBots DSH runtime bin: boots the composed plugin tree and keeps the process
// alive. Spawned and supervised by the Electron main process; stdin/stdout
// belong to the JSON-RPC protocol owned by idbots-sdk-server.
//
// Usage: node bin.mjs <path-to-cordis.yml>

import path from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'

const configPath = process.argv[2]
if (!configPath) {
  process.stderr.write('idbots-dsh-runtime: config path required\n')
  process.exit(2)
}

const ctx = await boot('idbots-dsh-runtime', path.resolve(configPath))
process.stderr.write(`[idbots-dsh-runtime] booted ${path.resolve(configPath)}\n`)

const keepalive = setInterval(() => {}, 1 << 30)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { clearInterval(keepalive); process.exit(0) })
}
