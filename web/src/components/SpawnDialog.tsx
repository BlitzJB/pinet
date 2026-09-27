import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeftIcon, FolderIcon, Loader2Icon } from "lucide-react";
import { cn } from "../lib/utils";
import { ghostButton } from "./ui/surfaces";

export interface SpawnCapabilityInfo {
  mode?: string;
  cwd?: string;
  active?: number;
  max?: number;
}

export interface SpawnTarget {
  sessionId: string;
  capability: SpawnCapabilityInfo;
}

/**
 * Create a session on a host's spawner.
 *
 * The spawner owns a directory and everything under it, so the picker only ever
 * walks inside that scope — and it works in paths relative to the root, which is
 * all the host accepts. Picking a subdirectory is optional: leaving it at "." is
 * the spawner's own directory, which is what the old inline form always did.
 */
export function SpawnDialog({
  open,
  hostLabel,
  spawners,
  onClose,
  load,
  onCreate,
}: {
  open: boolean;
  hostLabel: string;
  /** Spawners on this account: started by hand on a host with /rc. */
  spawners: { spawnerId: string; label: string; root: string; max?: number }[];
  onClose: () => void;
  load: (spawnerId: string, path?: string) => Promise<{ path?: string; entries?: string[]; ok?: boolean; error?: string }>;
  onCreate: (options: { spawnerId: string; name?: string; dir?: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [spawnerId, setSpawnerId] = useState<string>("");
  const [path, setPath] = useState(".");
  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Callers pass fresh callbacks and a freshly filtered array on every render, so
   * effects must not depend on those identities: doing so reset `path` to "." on
   * every re-render, which is how picking /root then home-jev sent "home-jev"
   * (relative to "/") and came back dir_out_of_scope.
   */
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!open) return;
    setName("");
    setPath(".");
    setError(null);
  }, [open]);

  // Only ever fixes an invalid selection; it must not touch the navigation state.
  useEffect(() => {
    setSpawnerId((current) => (spawners.some((entry) => entry.spawnerId === current) ? current : (spawners[0]?.spawnerId ?? "")));
  }, [spawners]);

  useEffect(() => {
    if (!open || !spawnerId) return;
    let cancelled = false;
    setLoading(true);
    loadRef.current(spawnerId, path)
      .then((result) => {
        if (cancelled) return;
        if (result.error) {
          setError(result.error);
          return;
        }
        setEntries(result.entries ?? []);
        setError(null);
      })
      .catch((cause) => !cancelled && setError(String((cause as Error)?.message ?? cause)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, spawnerId, path]);

  if (!open) return null;

  const selected = spawners.find((entry) => entry.spawnerId === spawnerId);
  const root = selected?.root ?? "";
  // A spawner rooted at "/" must not render "//root".
  const absolute = path === "." ? root : `${root === "/" ? "" : root.replace(/\/$/, "")}/${path}`;
  const up = () => setPath((current) => (current === "." ? "." : (current.split("/").slice(0, -1).join("/") || ".")));

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" />
      <div className="relative w-full max-w-md rounded-2xl border border-border/60 bg-background p-4 shadow-2xl">
        <h2 className="text-[14px] font-medium">New session</h2>
        <p className="mt-0.5 text-[12px] text-muted-foreground">
          on <span className="text-foreground/80">{hostLabel}</span>
        </p>

        {/* Spawners are started by hand on the host (/rc); this only picks one. */}
        {spawners.length > 1 ? (
          <select
            value={spawnerId}
            onChange={(event) => {
              setSpawnerId(event.target.value);
              setPath(".");
            }}
            className="mt-3 w-full rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-[13px] outline-none focus:border-foreground/30"
          >
            {spawners.map((entry) => (
              <option key={entry.spawnerId} value={entry.spawnerId}>
                {entry.label} — {entry.root}
              </option>
            ))}
          </select>
        ) : (
          <p className="mt-3 truncate text-[12px] text-muted-foreground" title={root}>
            Spawner: <span className="text-foreground/80">{selected?.label ?? "none"}</span>
          </p>
        )}

        {spawners.length === 0 && (
          <p className="mt-2 rounded-lg bg-foreground/[0.04] px-2.5 py-2 text-[11.5px] leading-snug text-muted-foreground">
            No spawner is running on this host. Start one in a directory there with <code className="text-foreground/80">/rc</code>, then come
            back — sessions are created inside its scope.
          </p>
        )}

        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Session name (optional)"
          className="mt-3 w-full rounded-lg border border-border/60 bg-background px-2.5 py-1.5 text-[13px] outline-none focus:border-foreground/30"
        />

        <div className="mt-3 rounded-xl border border-border/60">
          <div className="flex items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
            <button
              type="button"
              onClick={up}
              disabled={path === "."}
              className={cn(ghostButton, "size-6 rounded-md p-0 disabled:opacity-30")}
              title="Parent directory"
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            <span className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground" title={absolute}>
              {absolute}
            </span>
            {loading && <Loader2Icon className="size-3 animate-spin text-muted-foreground/50 motion-reduce:animate-none" />}
          </div>
          <div className="max-h-44 overflow-y-auto p-1">
            {entries.length === 0 && !loading && !error && (
              <p className="px-2 py-1.5 text-[11.5px] text-muted-foreground/60">No subdirectories here</p>
            )}
            {entries.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setPath((current) => (current === "." ? entry : `${current}/${entry}`))}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-colors hover:bg-foreground/[0.04]"
              >
                <FolderIcon className="size-3.5 shrink-0 text-muted-foreground/50" />
                <span className="truncate">{entry}</span>
              </button>
            ))}
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground/60">The session starts in this directory. Pick a subdirectory above to change it.</p>

        {error && <p className="mt-2 text-[11.5px] text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className={cn(ghostButton, "h-auto rounded-full px-3 py-1.5 text-[12.5px]")}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !spawnerId}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onCreate({ spawnerId, name: name.trim() || undefined, dir: path === "." ? undefined : path });
              } catch (cause) {
                setError(String((cause as Error)?.message ?? cause));
                setBusy(false);
                return;
              }
              setBusy(false);
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-[12.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {busy && <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" />}
            Create session
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
