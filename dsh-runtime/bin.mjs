// IDBots DSH runtime bin: boots the composed plugin tree and keeps the process
// alive. Spawned and supervised by the Electron main process; stdin/stdout
// belong to the JSON-RPC protocol owned by idbots-sdk-server.
//
// Usage: node bin.mjs <path-to-cordis.yml|json>
//
// The config path may live anywhere (the app writes generated configs into
// userData): bare package names resolve against THIS directory's node_modules
// via bareModuleBaseUrl, and generated configs reference our plugins by
// absolute path.

import path from 'node:path'
import { installWin32SpawnShim } from './lib/win32-spawn-shim.mjs'
import { boot } from '@deepseek-ai/dsh-app-boot'

installWin32SpawnShim()

const configPath = process.argv[2]
if (!configPath) {
  process.stderr.write('idbots-dsh-runtime: config path required\n')
  process.exit(2)
}

const moduleBase = new URL('.', import.meta.url)
const ctx = await boot('idbots-dsh-runtime', path.resolve(configPath), undefined, undefined, moduleBase)
process.stderr.write(`[idbots-dsh-runtime] booted ${path.resolve(configPath)}\n`)

const keepalive = setInterval(() => {}, 1 << 30)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { clearInterval(keepalive); process.exit(0) })
}
