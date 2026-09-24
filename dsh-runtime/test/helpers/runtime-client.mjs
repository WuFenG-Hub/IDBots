// Launch the IDBots dsh-runtime bin (`node bin.mjs <config>`) through the SDK
// client. dsh-sdk-client 0.1.2 dropped `command`/`args` from HarnessClient
// options — one-argument construction now resolves and spawns the same-version
// `dsh` CLI instead. Custom processes ride the second constructor argument
// (RuntimeProcessOptions), the same channel upstream's fake-runtime tests use
// via createProcessHarnessClient (not exported from the package index).

import { HarnessClient } from '@deepseek-ai/dsh-sdk-client'

/** Spawn `node <args...>` as the runtime process; env replaces the child env wholesale.
 *  `initializeTimeoutMs` is overridable for heavy compositions (the browser-use
 *  provider's boot can exceed the 10s default under a loaded gate run). */
export function runtimeClient({ args, env, requestTimeoutMs, processCwd, initializeTimeoutMs } = {}) {
  return new HarnessClient({}, {
    command: process.execPath,
    args,
    ...processCwd === undefined ? {} : { cwd: processCwd },
    environment: () => env,
    description: 'idbots-dsh-runtime',
    initializeTimeoutMs: initializeTimeoutMs ?? 10_000,
    ...requestTimeoutMs === undefined ? {} : { requestTimeoutMs },
  })
}
