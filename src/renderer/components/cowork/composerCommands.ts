/**
 * Slash-command infrastructure for the cowork composer, ported from the DSH
 * web UI's '+ menu / command picker / claim token' interaction.
 *
 * The composer owns the presentation (claim token `/name ` rendered with a
 * highlight, ghost hint, picker listbox); hosts supply the catalog. Execution
 * is host-side and maps each command onto IDBots machinery (permission modes,
 * manual compaction, transcript export, session goal) instead of the DSH
 * runtime's command registry.
 */

/** One command offered by the composer's '/' picker. */
export interface ComposerCommand {
  /** Lowercase name without the leading slash (e.g. 'plan'). */
  readonly name: string;
  /** One-line summary shown in the picker. */
  readonly description: string;
  /**
   * Ghost hint rendered after the claimed token while no argument text has
   * been typed yet. Commands without a hint never claim — picking (or a bare
   * Enter on `/name`) executes them immediately, like DSH's no-input commands.
   */
  readonly hint?: string;
  /**
   * Runs the command with everything the user typed after the `/name ` token.
   * Resolves to a transient notice shown under the composer, or void.
   * `submitMessage` (when provided by the host) sends `text` through the
   * composer's normal submit path — used by commands that steer the argument
   * into the conversation (e.g. `/plan <task>`).
   */
  readonly run: (args: string, ctx: ComposerCommandContext) => Promise<string | void> | string | void;
}

export interface ComposerCommandContext {
  /** Submit a message through the composer's normal path (returns send success). */
  readonly submitMessage: (text: string) => Promise<boolean>;
}

/** A command claim held by the composer while the draft starts with `/name `. */
export interface ComposerClaim {
  readonly command: ComposerCommand;
  /** The claimed text including the trailing space (e.g. '/plan '). */
  readonly token: string;
  readonly hint: string;
}

const COMMAND_NAME_RE = /^[a-z][a-z0-9_-]*$/;

/** Build the claim token for a command that takes input. */
export function commandToken(command: ComposerCommand): string {
  return `/${command.name} `;
}

/**
 * Parse a draft's leading slash command the way the DSH submit adjudication
 * does: a bare `/name` (nothing after it) or a claimed `/name ` with args.
 * Returns null when the draft does not lead with a command-shaped token.
 */
export function parseLeadingCommand(
  draft: string,
  commands: readonly ComposerCommand[],
): { command: ComposerCommand; args: string } | null {
  const trimmed = draft.trimStart();
  if (!trimmed.startsWith('/')) return null;
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/.exec(trimmed);
  if (!match) return null;
  const name = match[1];
  const command = commands.find((entry) => entry.name === name);
  if (!command) return null;
  const rest = trimmed.slice(match[0].length);
  // Bare '/name' with nothing behind it is only a command when the draft has
  // no argument text at all; otherwise the remainder belongs to the command.
  const args = rest.replace(/^[\t\n\r ]+/, '');
  return { command, args };
}

/**
 * The '/'-picker query for a draft being typed: the text between the leading
 * slash and the first space, or null when the draft is not a leading slash
 * token (picker closed).
 */
export function slashQueryOf(draft: string): string | null {
  const match = /^\/([a-z0-9_-]*)$/.exec(draft);
  return match ? match[1] : null;
}

/**
 * Rank commands for a picker query. Ported from DSH's fuzzy scoring in
 * spirit: prefix beats substring beats description match; empty query lists
 * everything in name order.
 */
export function filterComposerCommands(
  commands: readonly ComposerCommand[],
  query: string,
): ComposerCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const scored: Array<{ command: ComposerCommand; score: number }> = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const description = command.description.toLowerCase();
    let score: number | null = null;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (description.includes(q)) score = 2;
    if (score !== null) scored.push({ command, score });
  }
  scored.sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name));
  return scored.map((entry) => entry.command);
}

/** Goal sub-commands accepted after a claimed `/goal ` token. */
export type GoalCommand =
  | { kind: 'show' }
  | { kind: 'create'; text: string }
  | { kind: 'edit'; text: string }
  | { kind: 'clear' }
  | { kind: 'pause' }
  | { kind: 'resume' };

/**
 * Parse `/goal` arguments with the DSH grammar: empty → show, `clear` /
 * `pause` / `resume` keywords, `edit <objective>`, anything else → create.
 */
export function parseGoalCommandArgs(args: string): GoalCommand {
  const trimmed = args.trim();
  if (!trimmed) return { kind: 'show' };
  if (trimmed === 'clear') return { kind: 'clear' };
  if (trimmed === 'pause') return { kind: 'pause' };
  if (trimmed === 'resume') return { kind: 'resume' };
  if (trimmed.startsWith('edit ')) {
    const text = trimmed.slice('edit '.length).trim();
    if (text) return { kind: 'edit', text };
  }
  return { kind: 'create', text: trimmed };
}

/** Validate a command-catalog name (mirrors the DSH registry rule). */
export function isValidCommandName(name: string): boolean {
  return COMMAND_NAME_RE.test(name);
}
