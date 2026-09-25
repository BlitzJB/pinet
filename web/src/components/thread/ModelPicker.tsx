import { useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, ChevronDownIcon, CpuIcon, SearchIcon } from "lucide-react";
import { cn } from "../../lib/utils";
import type { ModelInfo } from "../../lib/pinet";
import { ComposerMenu } from "../ui/ComposerMenu";
import { ghostButton } from "../ui/surfaces";

/** Model catalogue picker. The list is fetched on first open and cached by the connection. */
export function ModelPicker({
  model,
  disabled,
  load,
  onSelect,
}: {
  model?: { provider: string; id: string; name?: string } | null;
  disabled?: boolean;
  load: () => Promise<ModelInfo[]>;
  onSelect: (provider: string, modelId: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  async function fetchModels() {
    setLoading(true);
    setError(null);
    try {
      setModels(await load());
    } catch (cause) {
      setError(String((cause as Error)?.message ?? cause));
    } finally {
      setLoading(false);
    }
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && models === null && !loading) void fetchModels();
  }

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = (models ?? []).filter(
      (item) => !needle || `${item.name} ${item.id} ${item.provider} ${item.providerName ?? ""}`.toLowerCase().includes(needle),
    );
    const byProvider = new Map<string, ModelInfo[]>();
    for (const item of filtered) {
      const key = item.providerName || item.provider;
      const list = byProvider.get(key) ?? [];
      list.push(item);
      byProvider.set(key, list);
    }
    return [...byProvider.entries()];
  }, [models, query]);

  return (
    <div className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={toggle}
        aria-label="Choose model"
        title={model ? `${model.provider}/${model.id}` : "Choose a model"}
        className={cn(ghostButton, "h-auto max-w-[11rem] gap-1.5 rounded-full px-2.5 py-1 text-xs disabled:opacity-40")}
      >
        <CpuIcon className="size-3.5 shrink-0" />
        <span className="hidden truncate sm:inline">{model?.id ?? "model"}</span>
        <ChevronDownIcon className={cn("size-3 shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>

      <ComposerMenu open={open} align="start" className="w-72 p-0">
        <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            tabIndex={open ? 0 : -1}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setOpen(false);
            }}
            placeholder="Search models"
            className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div className="max-h-72 overflow-y-auto p-1.5">
          {loading && <p className="px-2 py-3 text-[12px] text-muted-foreground">Loading models…</p>}
          {error && <p className="px-2 py-3 text-[12px] text-destructive">{error}</p>}
          {!loading && !error && groups.length === 0 && (
            <p className="px-2 py-3 text-[12px] text-muted-foreground">{models === null ? "—" : "No matching models."}</p>
          )}
          {groups.map(([providerName, items]) => (
            <div key={providerName}>
              <div className="px-2 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-muted-foreground/60 uppercase">
                {providerName}
              </div>
              {items.map((item) => {
                const current = item.provider === model?.provider && item.id === model?.id;
                return (
                  <button
                    key={`${item.provider}/${item.id}`}
                    type="button"
                    tabIndex={open ? 0 : -1}
                    onClick={() => {
                      onSelect(item.provider, item.id, item.name);
                      setOpen(false);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left text-[13px] transition-colors",
                      current ? "bg-foreground/[0.06]" : "hover:bg-foreground/[0.04]",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {typeof item.contextWindow === "number" && (
                      <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums">
                        {Math.round(item.contextWindow / 1000)}k
                      </span>
                    )}
                    {current && <CheckIcon className="size-3.5 shrink-0 text-emerald-500" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </ComposerMenu>
    </div>
  );
}
