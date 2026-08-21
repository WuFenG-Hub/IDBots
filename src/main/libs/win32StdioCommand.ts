// Windows stdio command rewrite: Node's spawn() does not search PATHEXT the
// same way cmd.exe does, so a bare `npx` / `npm` hits EINVAL. MCP servers and
// DSH plugin installs must pass the `.cmd` / `.exe` form at the host boundary.

const BARE_TO_WIN32: Record<string, string> = {
  npx: 'npx.cmd',
  npm: 'npm.cmd',
  node: 'node.exe',
  python: 'python.exe',
  python3: 'python.exe',
};

function basenameOf(command: string): string {
  const trimmed = command.replace(/[\\/]+$/, '');
  const slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return (slash >= 0 ? trimmed.slice(slash + 1) : trimmed).toLowerCase();
}

/** Rewrite a stdio spawn command for win32. Identity on other platforms. */
export function rewriteWin32StdioCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const trimmed = String(command ?? '').trim();
  if (!trimmed || platform !== 'win32') return trimmed;
  if (/\.(cmd|bat|exe)$/i.test(trimmed)) return trimmed;
  const base = basenameOf(trimmed);
  const mapped = BARE_TO_WIN32[base];
  if (!mapped) return trimmed;
  if (base === trimmed.toLowerCase()) return mapped;
  const ext = mapped.slice(mapped.lastIndexOf('.'));
  return `${trimmed}${ext}`;
}

export function rewriteWin32McpStdioServer<T extends { transportType?: string; command?: string }>(
  server: T,
  platform: NodeJS.Platform = process.platform,
): T {
  if (platform !== 'win32' || server.transportType !== 'stdio' || !server.command) return server;
  const command = rewriteWin32StdioCommand(server.command, platform);
  if (command === server.command) return server;
  return { ...server, command };
}
