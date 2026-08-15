// idbots-prompt-sections: registers IDBots' stable system-prompt layers on the
// DSH systemPrompt registry.
//
// The app's promptComposer already models prompts as named, ordered sections
// (persona:metabot, safety:workspace, idbots:memory-strategy, idbots:base, …);
// this plugin receives that list verbatim through config and registers each on
// ctx.systemPrompt.section({name, order, text}). Section order follows the DSH
// convention (0 = deployment persona; tool guidance 100–199). Volatile per-turn
// context (memory projections, browser tabs, …) stays on the user-message path
// exactly as promptComposer does today — only the stable layer lives here.
//
// Config is written by the Electron main process when it generates the runtime
// config (lib/generate-runtime-config.mjs), so sections can differ per launch
// (per metabot persona) without code changes.

export const name = 'idbots-prompt-sections'
export const inject = ['systemPrompt']

export function apply(ctx, config = {}) {
  for (const section of config.sections ?? []) {
    if (typeof section.name !== 'string' || typeof section.text !== 'string') {
      throw new Error(`idbots-prompt-sections: section needs string name and text, got ${JSON.stringify(section).slice(0, 80)}`)
    }
    ctx.systemPrompt.section({
      name: section.name,
      order: Number.isFinite(section.order) ? section.order : 0,
      text: section.text,
    })
  }
}
