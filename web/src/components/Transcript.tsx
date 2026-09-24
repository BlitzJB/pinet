import { useState } from "react";
import type { DisplayEntry } from "../lib/pinet";
import { Markdown } from "./Markdown";

function ToolBlock({ entry }: { entry: DisplayEntry }) {
  const [open, setOpen] = useState(false);
  const lines = String(entry.text ?? entry.body ?? "").split("\n");
  const shown = open ? lines : lines.slice(0, 12);
  const hidden = lines.length - shown.length;
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-900/60 px-3 py-2">
      <button type="button" onClick={() => setOpen((value) => !value)} className="flex w-full items-center gap-2 text-left text-sm">
        <span className={entry.error ? "text-bad-400" : "text-ok-400"}>{entry.error ? "✖" : "✔"}</span>
        <span className="font-mono text-xs text-brand-400">{entry.title ?? "tool"}</span>
        {hidden > 0 && <span className="ml-auto text-xs text-mist-400">+{hidden} lines</span>}
        {open && lines.length > 12 && <span className="ml-auto text-xs text-mist-400">collapse</span>}
      </button>
      {shown.length > 0 && (
        <pre className="mt-2 max-h-[420px] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-mist-300">{shown.join("\n")}</pre>
      )}
    </div>
  );
}

export function EntryBlock({ entry }: { entry: DisplayEntry }) {
  if (entry.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand-600/90 px-4 py-2 text-white shadow">
          <div className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-white/70">you</div>
          <div className="whitespace-pre-wrap break-words text-[15px]">{entry.text ?? entry.body}</div>
        </div>
      </div>
    );
  }

  if (entry.kind === "assistant") {
    return (
      <div className="rounded-2xl rounded-bl-sm border border-ink-700 bg-ink-850/70 px-4 py-3">
        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ok-400">pi</div>
        {entry.text ? <Markdown text={entry.text} /> : null}
        {entry.tools?.length ? (
          <div className="mt-2 space-y-1">
            {entry.tools.map((tool, index) => (
              <div key={index} className="font-mono text-xs text-mist-400">
                <span className="text-brand-400">$ {tool.name}</span> {tool.args}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  if (entry.kind === "tool") return <ToolBlock entry={entry} />;

  return (
    <div className="px-1 text-xs text-mist-400">
      <span className="mr-1 text-mist-400/70">[{entry.title ?? entry.kind ?? "remote"}]</span>
      {entry.body}
    </div>
  );
}

export function Transcript({ entries }: { entries: DisplayEntry[] }) {
  if (entries.length === 0) {
    return <div className="grid h-full place-items-center text-sm text-mist-400">No entries yet.</div>;
  }
  return (
    <div className="space-y-4">
      {entries.map((entry, index) => (
        <EntryBlock key={entry.id ?? index} entry={entry} />
      ))}
    </div>
  );
}
