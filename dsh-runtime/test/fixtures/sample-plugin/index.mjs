// Test fixture: a minimal external DSH plugin package. Mounted from an
// absolute-path composition entry (the plugin-install flow's entry shape) it
// registers a prompt section with a stable marker so E2E can assert the
// plugin actually ran inside the composed runtime.

export const name = 'dsh-sample-section'
export const inject = ['systemPrompt']

export function apply(ctx) {
  const systemPrompt = ctx.get('systemPrompt')
  if (!systemPrompt) throw new Error('sample plugin: no systemPrompt service')
  systemPrompt.section({
    name: 'sample:marker',
    order: 900,
    text: 'SAMPLE_PLUGIN_MARKER: external plugin mounted.',
  })
}
