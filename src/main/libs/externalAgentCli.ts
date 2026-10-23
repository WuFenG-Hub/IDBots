/**
 * External agent CLI detection for the DSH bash policy gate.
 *
 * Agent CLIs such as cursor-agent / claude / codex spawn their own tool
 * loops whose child processes (ripgrep, node, …) walk the filesystem. On
 * macOS every TCC access those children trigger is attributed to THIS app
 * as the responsible process, which is what produced the recurring
 * "IDBots wants to access other apps' data" dialogs (2026-10-23 incident:
 * a Bot session looping cursor-agent every ~30min generated 48 TCC
 * requests in 24h — AllFiles, MediaLibrary, Downloads/Desktop/Documents,
 * AppData, AppBundles, Photos — none of them answerable permanently,
 * because each new child binary re-prompts).
 *
 * The detector is a pure string classifier so the policy decision in
 * coworkRunner.evaluateDshToolPolicy stays unit-testable. It mirrors the
 * delete-analyzer's segment model: split on shell connectives, skip
 * VAR=value / sudo prefixes, resolve the executable basename, and recurse
 * into sh -c payloads (bounded depth). It deliberately stays conservative
 * about what it does NOT catch (command substitution, aliases): the gate
 * is a prompt reducer with a human in the loop, not a security boundary,
 * so a miss costs nothing beyond the pre-gate behavior.
 */

/**
 * Agent CLI executable basenames that self-drive filesystem access. Kept
 * to unambiguous names on purpose: generic words like `agent` (ssh-agent,
 * gpg-agent) or `goose` (the DB migration tool) must never trip the gate.
 */
const EXTERNAL_AGENT_CLI_EXECUTABLES = new Set([
  'cursor-agent',
  'claude',
  'codex',
  'gemini',
  'aider',
  'opencode',
]);

/** Package runners whose first positional argument is the real executable. */
const PACKAGE_RUNNER_EXECUTABLES = new Set(['npx', 'bunx']);

/** Shell wrappers whose `-c` payload is a nested command line. */
const SHELL_WRAPPER_EXECUTABLES = new Set(['bash', 'sh', 'zsh']);

/** Same token shape as coworkRunner.tokenizeShellSegment. */
function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(segment)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

/** Executable basename, lowercased, with Windows script suffixes stripped. */
function normalizeExecutable(token: string | undefined): string {
  if (!token) return '';
  const base = token.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

/** Package-runner argument → package name (`cursor-agent@latest` → `cursor-agent`). */
function normalizePackageName(token: string | undefined): string {
  if (!token) return '';
  if (token.startsWith('@')) return token.toLowerCase();
  return token.split('@')[0].toLowerCase();
}

/**
 * Return the matched agent CLI name when the command line invokes one,
 * null otherwise. Only the segment HEAD (the executable position) and
 * package-runner / shell-wrapper payloads are inspected, so mentions in
 * arguments or output text (`echo "ask cursor-agent"`) never match.
 */
export function detectExternalAgentCli(command: string, depth = 0): string | null {
  if (!command.trim()) return null;
  for (const segment of command.split(/&&|\|\||[;\n|]/)) {
    const tokens = tokenizeShellSegment(segment);
    let head = 0;
    while (head < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[head]) || tokens[head] === 'sudo')) {
      head += 1;
    }
    let executable = normalizeExecutable(tokens[head]);
    let args = tokens.slice(head + 1);
    if (executable === 'env') {
      let i = 0;
      while (i < args.length && (args[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]))) {
        i += 1;
      }
      executable = normalizeExecutable(args[i]);
      args = args.slice(i + 1);
    }
    if (!executable) continue;
    if (EXTERNAL_AGENT_CLI_EXECUTABLES.has(executable)) return executable;
    if (PACKAGE_RUNNER_EXECUTABLES.has(executable)) {
      const pkg = normalizePackageName(args.find((token) => !token.startsWith('-')));
      if (EXTERNAL_AGENT_CLI_EXECUTABLES.has(pkg)) return pkg;
    }
    if ((executable === 'pnpm' || executable === 'yarn') && args[0] === 'dlx') {
      const pkg = normalizePackageName(args.slice(1).find((token) => !token.startsWith('-')));
      if (EXTERNAL_AGENT_CLI_EXECUTABLES.has(pkg)) return pkg;
    }
    if (SHELL_WRAPPER_EXECUTABLES.has(executable) && depth < 2) {
      const payloadIndex = args.findIndex((token) => token === '-c');
      const payload = payloadIndex >= 0 ? args[payloadIndex + 1] : undefined;
      if (typeof payload === 'string' && payload.trim()) {
        const nested = detectExternalAgentCli(payload, depth + 1);
        if (nested) return nested;
      }
    }
  }
  return null;
}
