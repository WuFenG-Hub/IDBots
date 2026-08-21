// Windows spawn shim for the DSH runtime child.
//
// dsh-bash-local / dsh-subprocess-local spawn a bare `bash` name with no
// windowsHide. Packaged Start-menu Electron then flashes a console per tool
// call, and a Path/PATH regression makes bash ENOENT even when mingit is on
// PATH. Rewrite argv[0] to CLAUDE_CODE_GIT_BASH_PATH when set, and hide the
// console. No-op on non-Windows.

import { spawn as realSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import childProcess from 'node:child_process'

export function resolveWin32BashProgram(file, env = process.env) {
  const name = String(file ?? '')
  const lower = name.toLowerCase()
  const isBareBash = name === 'bash' || lower === 'bash.exe' || lower.endsWith('\\bash.exe') || lower.endsWith('/bash.exe')
  if (!isBareBash) return file
  const configured = String(env.CLAUDE_CODE_GIT_BASH_PATH || env.IDBOTS_BASH_PATH || '').trim()
  if (configured && existsSync(configured)) return configured
  return file
}

export function withWin32SpawnOptions(options) {
  return { windowsHide: true, ...(options && typeof options === 'object' ? options : {}), windowsHide: true }
}

export function installWin32SpawnShim() {
  if (process.platform !== 'win32') return
  if (childProcess.spawn.__idbotsWin32Shim) return
  const patched = function spawnWithHiddenWindows(file, args, options) {
    let argv = args
    let opts = options
    if (argv !== undefined && argv !== null && !Array.isArray(argv) && typeof argv === 'object') {
      opts = argv
      argv = undefined
    }
    const program = resolveWin32BashProgram(file, process.env)
    const nextOpts = withWin32SpawnOptions(opts)
    return argv === undefined ? realSpawn(program, nextOpts) : realSpawn(program, argv, nextOpts)
  }
  patched.__idbotsWin32Shim = true
  childProcess.spawn = patched
}
