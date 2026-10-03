/**
 * Turning a raw tool call into something worth reading.
 *
 * The host hands over `name` and the arguments as a JSON string, which is enough to
 * render a card but not enough to *read* one: `{"path":"src/foo.mjs"}` is not what
 * happened, "Read src/foo.mjs" is. Everything here is pure so it can be tested, and
 * defensive because tool arguments come from a model and are not to be trusted.
 */

export type ToolKind = "read" | "edit" | "write" | "bash" | "search" | "list" | "web" | "todo" | "agent" | "other";

export interface DiffLine {
  kind: "add" | "remove" | "context" | "gap";
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface ToolView {
  kind: ToolKind;
  /** What happened: "Read", "Ran", "Edited". */
  verb: string;
  /** What it happened to: a path, a command, a pattern, a URL. */
  target?: string;
  /** Anything worth knowing at a glance: "42 lines", "3 matches", "exit 1". */
  detail?: string;
  additions?: number;
  deletions?: number;
  diff?: DiffLine[];
}

/** Tool arguments arrive as a JSON string. Anything unexpected yields undefined. */
export function parseToolArgs(args?: string): Record<string, unknown> | undefined {
  const text = String(args ?? "").trim();
  if (!text || text[0] !== "{") return undefined;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);

/** First line, trimmed — a command or pattern shown inline should stay one line. */
const oneLine = (value: string, max = 160): string => {
  const line = value.split("\n")[0].trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

export const lineCount = (text?: string): number => (text ? text.split("\n").filter((line) => line !== "").length : 0);

/**
 * A unified diff between two blocks of text.
 *
 * The common prefix and suffix are trimmed first, because an edit usually changes a
 * small middle inside a large unchanged file — that keeps the real work small enough
 * for an LCS, and keeps the diff focused. A pathological pair (both sides huge and
 * unrelated) falls back to removals followed by additions rather than blowing up.
 */
export function diffLines(before: string, after: string, { context = 3, maxCells = 160_000 }: { context?: number; maxCells?: number } = {}): DiffLine[] {
  const a = String(before ?? "").split("\n");
  const b = String(after ?? "").split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const body: DiffLine[] = [];

  if (midA.length * midB.length > maxCells) {
    // Too large to align: report it honestly as a replacement.
    for (let i = 0; i < midA.length; i += 1) body.push({ kind: "remove", text: midA[i], oldLine: start + i + 1 });
    for (let j = 0; j < midB.length; j += 1) body.push({ kind: "add", text: midB[j], newLine: start + j + 1 });
  } else {
    const n = midA.length;
    const m = midB.length;
    // Longest common subsequence, walked backwards into a table of lengths.
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        table[i][j] = midA[i] === midB[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        body.push({ kind: "context", text: midA[i], oldLine: start + i + 1, newLine: start + j + 1 });
        i += 1;
        j += 1;
      } else if (table[i + 1][j] >= table[i][j + 1]) {
        body.push({ kind: "remove", text: midA[i], oldLine: start + i + 1 });
        i += 1;
      } else {
        body.push({ kind: "add", text: midB[j], newLine: start + j + 1 });
        j += 1;
      }
    }
    while (i < n) {
      body.push({ kind: "remove", text: midA[i], oldLine: start + i + 1 });
      i += 1;
    }
    while (j < m) {
      body.push({ kind: "add", text: midB[j], newLine: start + j + 1 });
      j += 1;
    }
  }

  const lead = Math.max(0, start - context);
  const lines: DiffLine[] = [];
  if (lead > 0) lines.push({ kind: "gap", text: `${lead} unchanged line${lead === 1 ? "" : "s"} above` });
  for (let i = lead; i < start; i += 1) lines.push({ kind: "context", text: a[i], oldLine: i + 1, newLine: i + 1 });
  lines.push(...body);

  const trailing = Math.min(context, a.length - endA);
  for (let i = 0; i < trailing; i += 1) {
    lines.push({ kind: "context", text: a[endA + i], oldLine: endA + i + 1, newLine: endB + i + 1 });
  }
  const remaining = a.length - endA - trailing;
  if (remaining > 0) lines.push({ kind: "gap", text: `${remaining} unchanged line${remaining === 1 ? "" : "s"} below` });
  return lines;
}

export function summarizeDiff(diff: DiffLine[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff) {
    if (line.kind === "add") additions += 1;
    else if (line.kind === "remove") deletions += 1;
  }
  return { additions, deletions };
}

/** Every old/new pair an edit tool may carry, whether one or many. */
function editPairs(args: Record<string, unknown>): { before: string; after: string }[] {
  const pairs: { before: string; after: string }[] = [];
  const edits = args.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (!edit || typeof edit !== "object") continue;
      const record = edit as Record<string, unknown>;
      pairs.push({ before: str(record.oldText) ?? "", after: str(record.newText) ?? "" });
    }
  }
  if (pairs.length === 0 && (str(args.oldText) !== undefined || str(args.newText) !== undefined)) {
    pairs.push({ before: str(args.oldText) ?? "", after: str(args.newText) ?? "" });
  }
  return pairs;
}

/** The exit code, if the shell output ends with one of the usual shapes. */
function exitCode(output?: string): string | undefined {
  const match = /(?:exit code|exited with|exit status)[: ]+(\d+)/i.exec(String(output ?? ""));
  return match ? `exit ${match[1]}` : undefined;
}

/**
 * Describe a tool call the way a person would: what was done, to what, and anything
 * worth knowing without expanding it.
 */
export function describeTool(name: string, args?: string, output?: string): ToolView {
  const tool = String(name ?? "").toLowerCase();
  const parsed = parseToolArgs(args) ?? {};
  const path = str(parsed.path) ?? str(parsed.filePath) ?? str(parsed.file);

  if (tool === "read") {
    const lines = lineCount(output);
    return { kind: "read", verb: "Read", target: path, detail: lines > 0 ? `${lines} lines` : undefined };
  }

  if (tool === "edit") {
    const pairs = editPairs(parsed);
    const diff = pairs.flatMap((pair) => diffLines(pair.before, pair.after));
    const { additions, deletions } = summarizeDiff(diff);
    return { kind: "edit", verb: "Edited", target: path, additions, deletions, diff: diff.length > 0 ? diff : undefined };
  }

  if (tool === "write") {
    const content = str(parsed.content) ?? "";
    const diff = diffLines("", content);
    const { additions } = summarizeDiff(diff);
    return { kind: "write", verb: "Wrote", target: path, additions, deletions: 0, detail: `${lineCount(content)} lines`, diff };
  }

  if (tool === "bash" || tool === "shell" || tool === "run") {
    const command = str(parsed.command) ?? str(parsed.cmd);
    return { kind: "bash", verb: "Ran", target: command ? oneLine(command) : undefined, detail: exitCode(output) };
  }

  if (tool === "grep" || tool === "search") {
    const pattern = str(parsed.pattern) ?? str(parsed.query);
    const matches = lineCount(output);
    return {
      kind: "search",
      verb: "Searched",
      target: pattern ? `"${oneLine(pattern, 60)}"` : undefined,
      detail: matches > 0 ? `${matches} match${matches === 1 ? "" : "es"}` : "no matches",
    };
  }

  if (tool === "find" || tool === "glob") {
    const files = lineCount(output);
    return { kind: "search", verb: "Found", target: str(parsed.pattern) ?? str(parsed.glob), detail: files > 0 ? `${files} files` : "none" };
  }

  if (tool === "ls" || tool === "list" || tool === "list_dir") {
    const entries = lineCount(output);
    return { kind: "list", verb: "Listed", target: path, detail: entries > 0 ? `${entries} entries` : "empty" };
  }

  if (tool === "webfetch" || tool === "fetch" || tool === "web_search" || tool === "websearch") {
    const url = str(parsed.url) ?? str(parsed.query);
    return { kind: "web", verb: "Fetched", target: url ? oneLine(url) : undefined };
  }

  if (tool === "todo" || tool === "todos" || tool === "todowrite") {
    const todos = Array.isArray(parsed.todos) ? parsed.todos : [];
    const done = todos.filter((todo) => todo && typeof todo === "object" && (todo as Record<string, unknown>).status === "completed").length;
    return { kind: "todo", verb: "Updated", target: "the task list", detail: todos.length > 0 ? `${done}/${todos.length} done` : undefined };
  }

  if (tool.startsWith("subagent") || tool === "task" || tool === "agent") {
    return { kind: "agent", verb: "Delegated", target: str(parsed.agent) ?? str(parsed.task) };
  }

  // Unknown tool: show its name and the first argument that looks meaningful.
  const first = Object.values(parsed).find((value) => typeof value === "string") as string | undefined;
  return { kind: "other", verb: name || "Tool", target: first ? oneLine(first) : undefined };
}

/**
 * Split a path for display: the directory recedes, the file name stays legible. This
 * is the single cheapest thing that makes a list of paths scannable.
 */
export function splitPath(path: string): { dir: string; base: string } {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? { dir: "", base: path } : { dir: path.slice(0, slash + 1), base: path.slice(slash + 1) };
}

/** Cap a block of text, reporting honestly how much was left out. */
export function truncateLines(text: string, max: number): { text: string; hidden: number; total: number } {
  const lines = String(text ?? "").split("\n");
  if (lines.length <= max) return { text: String(text ?? ""), hidden: 0, total: lines.length };
  return { text: lines.slice(0, max).join("\n"), hidden: lines.length - max, total: lines.length };
}

/**
 * A one-line summary of a group of tool calls, in the shape a person would say it:
 * "Read 4 files and ran 2 commands". Counts are per kind, most frequent first.
 */
export function summarizeTools(views: ToolView[]): string {
  if (views.length === 0) return "Activity";
  const plural: Record<ToolKind, [string, string]> = {
    read: ["file", "files"],
    edit: ["file", "files"],
    write: ["file", "files"],
    bash: ["command", "commands"],
    search: ["search", "searches"],
    list: ["listing", "listings"],
    web: ["page", "pages"],
    todo: ["task list", "task lists"],
    agent: ["agent", "agents"],
    other: ["step", "steps"],
  };
  const counts = new Map<ToolKind, number>();
  for (const view of views) counts.set(view.kind, (counts.get(view.kind) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${count} ${plural[kind][count === 1 ? 0 : 1]}`);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`.replace(/^./, (c) => c.toUpperCase());
}
