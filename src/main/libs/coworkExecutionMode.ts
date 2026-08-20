/**
 * Sandbox and auto execution modes are temporarily retired: few users
 * used the VM, and it still boots the Claude SDK. Every session runs locally.
 * Callers should keep accepting the historical union so re-enabling sandbox
 * does not require a schema change.
 */
export function resolveCoworkExecutionMode(
  _mode?: string | null
): 'auto' | 'local' | 'sandbox' {
  return 'local';
}
