/**
 * Slash commands and file mentions, resolved on the host.
 *
 * Two things are worth knowing before reading this.
 *
 * pi's `prompt()` already dispatches extension commands, prompt templates and
 * skill commands — so those pass through untouched, and all the portal has to do
 * is tell the user they exist. The built-ins are the opposite: they live in the
 * terminal UI (`/settings` opens a menu, `/tree` walks branches, `/quit` exits), so
 * the ones with a programmatic equivalent are mapped onto session APIs here and the
 * rest are refused *out loud*. A command that quietly does nothing is worse than
 * one that says why.
 *
 * Mentions are not a protocol feature at all: pi never expands `@path`, the agent
 * simply reads the file with its own tools. So the portal passes the text through
 * unchanged and supplies the one thing that makes mentions usable — completion.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Built-ins the portal can execute, mapped onto session APIs by the extension. */
export const PORTAL_BUILTINS = [
  { name: "compact", description: "Compact the session context", argumentHint: "[instructions]" },
  { name: "model", description: "Select the model", argumentHint: "<provider/model>" },
  { name: "thinking", description: "Set the thinking level", argumentHint: "<level>" },
  { name: "name", description: "Rename this session", argumentHint: "<name>" },
  { name: "session", description: "Show session info and stats" },
];

/** Built-ins that only make sense with a terminal: refused, with a reason. */
export const TUI_ONLY_BUILTINS = [
  "settings", "tree", "scoped-models", "export", "import", "share", "bug", "copy",
  "changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "new",
  "resume", "reload", "quit",
];

const COMMAND_RE = /^\/([A-Za-z][A-Za-z0-9:_-]*)(?:\s+([\s\S]*))?$/;

/** `/compact focus on the parser` -> `{ name, args }`; anything else -> undefined. */
export function parseCommand(text) {
  const match = COMMAND_RE.exec(String(text ?? "").trim());
  if (!match) return undefined;
  return { name: match[1], args: (match[2] ?? "").trim() };
}

/**
 * What the composer offers: our built-ins first, then whatever the session
 * registered (extensions, prompt templates, skills), then the terminal-only ones so
 * they are discoverable and can explain themselves.
 */
export function commandCatalogue({ commands = [], portalBuiltins = PORTAL_BUILTINS, tuiOnly = TUI_ONLY_BUILTINS } = {}) {
  const seen = new Set();
  const list = [];
  for (const command of portalBuiltins) {
    seen.add(command.name);
    list.push({ name: command.name, description: command.description ?? null, argumentHint: command.argumentHint ?? null, source: "builtin" });
  }
  for (const command of commands) {
    const name = typeof command?.name === "string" ? command.name : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push({
      name,
      description: typeof command.description === "string" ? command.description : null,
      argumentHint: typeof command.argumentHint === "string" ? command.argumentHint : null,
      source: typeof command.source === "string" ? command.source : "extension",
    });
  }
  for (const name of tuiOnly) {
    if (seen.has(name)) continue;
    seen.add(name);
    list.push({ name, description: "Terminal only", argumentHint: null, source: "tui" });
  }
  return list.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Decide what a message starting with a slash means.
 *
 * Only commands we recognise are intercepted. `/root/pinet` and an unknown `/foo`
 * fall through to the agent as ordinary text, so a path that happens to start with
 * a slash keeps working and a typo gets answered instead of swallowed.
 */
export function resolveCommand(text, { commands = [], portalBuiltins = PORTAL_BUILTINS, tuiOnly = TUI_ONLY_BUILTINS } = {}) {
  const parsed = parseCommand(text);
  if (!parsed) return { kind: "none", text };
  if (portalBuiltins.some((command) => command.name === parsed.name)) {
    return { kind: "portal", name: parsed.name, args: parsed.args, text };
  }
  if (commands.some((command) => command?.name === parsed.name)) {
    return { kind: "passthrough", name: parsed.name, args: parsed.args, text };
  }
  if (tuiOnly.includes(parsed.name)) return { kind: "tui-only", name: parsed.name, args: parsed.args, text };
  return { kind: "none", text };
}

export const tuiOnlyNotice = (name) => `/${name} needs the terminal UI, so it isn't available from the portal.`;

/** Directories that are never worth listing, and would swamp the results. */
export const DEFAULT_IGNORES = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", "out",
  "target", ".next", ".cache", ".turbo", "coverage", ".DS_Store",
]);

/**
 * Every file under `root`, as paths relative to it.
 *
 * Bounded in both directions: at most `max` entries and `maxDepth` levels, and
 * symlinks are listed but never followed, so a link pointing outside the session
 * cannot pull the whole filesystem in. This feeds completion, not a file browser —
 * the caller has already been told the session's cwd.
 */
export function walkFiles(root, { max = 4_000, maxDepth = 8, ignores = DEFAULT_IGNORES } = {}) {
  const found = [];
  const walk = (dir, prefix, depth) => {
    if (found.length >= max || depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= max) return;
      if (ignores.has(entry.name)) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      // `isDirectory()` is false for symlinks, so they are listed but not entered.
      if (entry.isDirectory()) walk(join(dir, entry.name), relative, depth + 1);
      else found.push(relative);
    }
  };
  walk(root, "", 1);
  return found;
}

/**
 * Rank paths for a mention prefix: exact basename, then basename prefix, then a
 * path prefix, then anywhere. Ties go to the shallower path, which is almost always
 * the one meant.
 */
export function filterPaths(paths, prefix, limit = 40) {
  const needle = String(prefix ?? "").toLowerCase();
  const scored = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let score;
    if (!needle) score = 3;
    else if (base === needle) score = 0;
    else if (base.startsWith(needle)) score = 1;
    else if (lower.startsWith(needle)) score = 2;
    else if (lower.includes(needle)) score = 3;
    else continue;
    scored.push({ path, score, depth: (path.match(/\//g) ?? []).length });
  }
  scored.sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((entry) => entry.path);
}
