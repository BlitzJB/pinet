/**
 * Finding the `/command` or `@mention` the caret is sitting in.
 *
 * Kept pure and separate from the composer because the awkward parts are all
 * edge cases: a slash in the middle of a sentence is a path or a date, not a
 * command; a space closes a mention; replacing a token has to put the caret back
 * where the person expects it.
 */

export interface Token {
  kind: "command" | "mention";
  query: string;
  start: number;
  end: number;
}

export interface CommandInfo {
  name: string;
  description?: string | null;
  argumentHint?: string | null;
  source?: string;
}

export interface MenuItem {
  /** Stable identity, and what gets inserted. */
  value: string;
  /** The token text, `@` or `/` included. */
  insert: string;
  label: string;
  description?: string | null;
  hint?: string | null;
  /** Terminal-only commands are listed so they can explain themselves. */
  disabled?: boolean;
}

/** A mention ends at whitespace; a command name may contain `:` (skill:name). */
const isMentionChar = (char: string) => !/\s/.test(char);

/**
 * The token under the caret, if the caret is in one.
 *
 * Mentions can start anywhere. Commands only count at the very start of the
 * message, which is what keeps `/root/pinet what is here?` and `see src/lib/foo`
 * from opening a palette.
 */
export function activeToken(text: string, caret: number): Token | undefined {
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const at = before.lastIndexOf("@");
  const slash = before.lastIndexOf("/");

  const mentionOpen = at !== -1 && before.slice(at + 1).split("").every(isMentionChar);
  const commandOpen = slash === 0 && before.slice(1).split("").every(isMentionChar);

  // Whichever opened most recently wins, so `@a/b` is a mention, not a command.
  if (mentionOpen && (!commandOpen || at > slash)) {
    return { kind: "mention", query: before.slice(at + 1), start: at, end: extend(text, caret) };
  }
  if (commandOpen) {
    return { kind: "command", query: before.slice(1), start: 0, end: extend(text, caret) };
  }
  return undefined;
}

/** Consume the rest of the token, so accepting replaces all of what was typed. */
function extend(text: string, caret: number): number {
  let end = caret;
  while (end < text.length && isMentionChar(text[end])) end += 1;
  return end;
}

/** Swap the token for the accepted value, and say where the caret should land. */
export function replaceToken(text: string, token: Token, value: string): { text: string; caret: number } {
  const next = `${text.slice(0, token.start)}${value}${text.slice(token.end)}`;
  return { text: next, caret: token.start + value.length };
}

/**
 * Commands matching what has been typed: prefix first, then anywhere in the name
 * or the description, so `/sk` finds `skill:review` and `rev` finds `/review`.
 */
export function filterCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const needle = query.trim().toLowerCase();
  const scored: { command: CommandInfo; score: number }[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    const haystack = `${name} ${command.description ?? ""}`.toLowerCase();
    let score: number;
    if (!needle) score = 0;
    else if (name.startsWith(needle)) score = 1;
    else if (haystack.includes(needle)) score = 2;
    else continue;
    scored.push({ command, score });
  }
  scored.sort((a, b) => a.score - b.score || a.command.name.localeCompare(b.command.name));
  return scored.map((entry) => entry.command);
}

export function commandItems(commands: CommandInfo[], query: string): MenuItem[] {
  return filterCommands(commands, query).map((command) => ({
    value: command.name,
    insert: `/${command.name} `,
    label: `/${command.name}`,
    description: command.description,
    hint: command.argumentHint,
    disabled: command.source === "tui",
  }));
}

export function fileItems(files: string[]): MenuItem[] {
  return files.map((file) => ({ value: file, insert: `@${file} `, label: file }));
}

export const tuiOnlyNotice = (name: string) => `/${name} needs the terminal UI, so it isn't available from the portal.`;

/**
 * The command a message would run, if any — used to refuse a terminal-only
 * command before it is sent, rather than after a round trip.
 */
export function commandAtStart(text: string, commands: CommandInfo[]): CommandInfo | undefined {
  const token = activeToken(text, text.length);
  if (token?.kind === "command") {
    const typed = token.query.trim().split(/\s+/)[0];
    return commands.find((command) => command.name === typed);
  }
  // The caret has left the token, so fall back to reading the message itself.
  const match = /^\/([A-Za-z][A-Za-z0-9:_-]*)/.exec(text.trim());
  return match ? commands.find((command) => command.name === match[1]) : undefined;
}

/**
 * Whether the sheet should be in the tree.
 *
 * The bug this exists to prevent: an empty list means two different things — "still
 * looking" and "nothing matched". Treating them the same closed the sheet on every
 * keystroke while a fetch was in flight, so typing `@` made it flash.
 */
export function shouldShowSheet(itemCount: number, loading: boolean): boolean {
  return itemCount > 0 || loading;
}
