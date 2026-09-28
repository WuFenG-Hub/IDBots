// idbots-cu-route-guard: fail-closed route policy for the experimental
// cua-driver desktop tools, mounted only when the host opts a bot into
// computer use.
//
// Why: the native provider runs the driver in-process, where macOS has no
// AppKit main-thread host — every agent-cursor overlay call refuses with
// facility_unavailable, and the pointer-moving routes (foreground delivery,
// desktop scope, modifier clicks, drag) act on the user's PHYSICAL pointer
// with no visual feedback. The provider's approval patch gates mutating tools
// per call, but its prompt never discloses that an approved click can grab
// the real mouse. This plugin denies those routes at tools/pre-execute —
// before any approval prompt — with model-facing reasons that name the safe
// alternative, and registers the same boundary as a system-prompt section so
// the model rarely reaches for them.
//
// Route table (tool names carry the provider's cua_driver_native__ prefix):
//   deny  delivery_mode:"foreground"              — HID tap + pointer warp
//   deny  scope:"desktop" / target.kind="desktop" — system-input rung
//   deny  drag                                    — no background drag on macOS
//   deny  modifier(s) on any call                 — forces foreground delivery
//   deny  set_config / replay_trajectory          — driver-config tamper /
//         unapproved re-fire of recorded input
//   deny  cursor-overlay family + move_cursor     — facility_unavailable here
// Everything else falls through to next() and the provider's approval gate.

export const name = 'idbots-cu-route-guard'
export const inject = ['tools', 'systemPrompt']

const PREFIX = 'cua_driver_native__'

// Overlay-cursor controls all refuse with facility_unavailable in an
// in-process (no GUI session) runtime; move_cursor joins them unless it
// targets the desktop rung, which the desktop rule denies instead.
const OVERLAY_TOOLS = new Set([
  'set_agent_cursor_enabled',
  'set_agent_cursor_theme',
  'set_agent_cursor_motion',
  'get_agent_cursor_state',
])

// set_config rewrites ~/.cua-driver/config.json (overlay/PiP toggles,
// capture geometry); replay_trajectory re-fires a recorded action sequence
// through one tool call, route-around for the per-action approval gate.
const CONFIG_TOOLS = new Set(['set_config', 'replay_trajectory'])

const REASONS = {
  foreground:
    'Foreground delivery moves the user\'s physical mouse pointer and steals focus — refused by host policy. Omit delivery_mode (background is the default) or use element/AX actions.',
  desktop:
    'Desktop-scope input drives the real OS pointer — refused by host policy. Target a specific app or window with background delivery instead.',
  drag:
    'macOS has no background drag and a foreground drag moves the user\'s physical pointer — refused by host policy. Use set_window_frame, invoke_menu, or element actions, or ask the user to perform the drag.',
  modifier:
    'Modifier-key clicks require foreground delivery, which moves the user\'s physical pointer — refused by host policy. Use press_key/hotkey for the modifier or a plain background click.',
  config:
    'This tool rewrites driver-level configuration or replays recorded input without per-action approval — refused by host policy.',
  overlay:
    'The agent-cursor overlay is unavailable in this runtime (in-process provider, no GUI session): cursor-overlay calls always fail with facility_unavailable. Do not retry them; use the background input tools.',
}

const hasModifiers = (args) =>
  (Array.isArray(args.modifier) && args.modifier.length > 0) ||
  (Array.isArray(args.modifiers) && args.modifiers.length > 0)

// First matching rule wins; returns the deny reason or null for "falls
// through". Exported for the wire test.
export const cuRouteViolation = (short, args) => {
  if (CONFIG_TOOLS.has(short)) return REASONS.config
  if (OVERLAY_TOOLS.has(short)) return REASONS.overlay
  if (short === 'move_cursor') {
    return args.scope === 'desktop' ? REASONS.desktop : REASONS.overlay
  }
  if (args.delivery_mode === 'foreground') return REASONS.foreground
  if (args.scope === 'desktop' || args.target?.kind === 'desktop') return REASONS.desktop
  if (short === 'drag') return REASONS.drag
  if (hasModifiers(args)) return REASONS.modifier
  return null
}

export function apply(ctx) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!exec.name.startsWith(PREFIX)) return next()
    const args = (exec.arguments !== null && typeof exec.arguments === 'object') ? exec.arguments : {}
    const reason = cuRouteViolation(exec.name.slice(PREFIX.length), args)
    if (reason === null) return next()
    console.error(`[idbots-cu-route-guard] denied ${exec.name}: ${reason}`)
    return { kind: 'deny', reason }
  }, { global: true })

  ctx.systemPrompt.section({
    name: 'idbots:computer-use-boundary',
    order: 150,
    text: [
      'Desktop control (cua_driver_native__* tools) operates in BACKGROUND mode only. Hard rules — violations are refused before execution:',
      '- NEVER pass delivery_mode:"foreground", scope:"desktop", or target:{kind:"desktop"}: those move the user\'s physical mouse pointer and steal focus.',
      '- NEVER combine modifier keys with a click (a modifier forces foreground delivery). Use press_key/hotkey for the modifier or a plain background click.',
      '- NEVER call drag: macOS has no background drag. Rearrange via set_window_frame/invoke_menu or element actions, or ask the user to drag.',
      '- Cursor-overlay tools (move_cursor, set_agent_cursor_*, get_agent_cursor_state) are unavailable in this runtime — do not call them.',
      '- set_config and replay_trajectory are refused by host policy.',
      'Prefer element/AX actions (get_accessibility_tree) and background pixel input; verify every action with a fresh screenshot.',
    ].join('\n'),
  })
}
