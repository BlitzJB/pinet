import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRightIcon, Loader2Icon, MessageSquareIcon, MoreVerticalIcon, PanelRightIcon, PencilIcon, PlusIcon, SearchIcon, ServerIcon, SettingsIcon } from "lucide-react";
import { getMe, type ServerSession } from "../lib/api";
import { useConnectionState, usePinet } from "../lib/context";
import { groupSessionsByHost } from "../lib/session-groups";
import { cn } from "../lib/utils";
import { usePanes } from "../lib/use-panes";
import { AnchoredMenu, menuItem } from "./ui/AnchoredMenu";
import { RenameInput } from "./ui/RenameInput";
import { Avatar } from "./Avatar";

const COLLAPSE_KEY = "pinet.collapsedHosts";

const spawnChip = (active: boolean) =>
  cn(
    "rounded-full px-2 py-0.5 text-[11px] transition-colors disabled:opacity-40",
    active ? "bg-foreground text-background" : "bg-foreground/[0.06] text-muted-foreground hover:bg-foreground/10",
  );

function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function ConnectionDot() {
  const state = useConnectionState();
  const style =
    state.status === "connected"
      ? "bg-emerald-500"
      : state.status === "error"
        ? "bg-destructive"
        : "bg-amber-400 animate-pulse motion-reduce:animate-none";
  return (
    <span
      title={`${state.status}${state.error ? `: ${state.error}` : ""}`}
      className={cn("size-2 shrink-0 rounded-full", style)}
    />
  );
}

/** Session row actions (presentational; availability is resolved by the caller). */
function RowMenu({
  anchor,
  availability,
  onClose,
  onRename,
  onOpenSide,
}: {
  anchor: HTMLElement;
  availability: { allowed: boolean; reason?: string };
  onClose: () => void;
  onRename: () => void;
  onOpenSide: () => void;
}) {
  return (
    <AnchoredMenu anchor={anchor} onClose={onClose}>
      <button type="button" role="menuitem" className={menuItem} onClick={onRename}>
        <PencilIcon className="size-3.5 text-muted-foreground" />
        Rename
      </button>
      <button
        type="button"
        role="menuitem"
        className={menuItem}
        disabled={!availability.allowed}
        title={availability.reason}
        onClick={onOpenSide}
      >
        <PanelRightIcon className="size-3.5 text-muted-foreground" />
        Open to the side
      </button>
    </AnchoredMenu>
  );
}

export function SessionSidebar({ onNavigate }: { onNavigate?: () => void }) {
  const connection = usePinet();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { primary: activeSessionId, side: sidePaneIds, availability, searchFor, openToSide } = usePanes();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false, staleTime: 30_000 });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => connection.list(), refetchInterval: 5_000 });
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [editing, setEditing] = useState<string | null>(null);
  const [localNames, setLocalNames] = useState<Record<string, string>>({});
  const [spawnHost, setSpawnHost] = useState<string | null>(null);
  const [spawnName, setSpawnName] = useState("");
  const [spawnMode, setSpawnMode] = useState("session");
  const [spawnBusy, setSpawnBusy] = useState(false);
  const [spawnError, setSpawnError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);

  // A rename is shown immediately; once the coordinator's catalog agrees (host
  // has published the new meta) the local override is no longer needed.
  useEffect(() => {
    if (!catalog.data) return;
    setLocalNames((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const session of catalog.data!) {
        if (next[session.sessionId] && session.meta?.name === next[session.sessionId]) {
          delete next[session.sessionId];
          changed = true;
        }
      }
      return changed ? next : previous;
    });
  }, [catalog.data]);

  const sessions = (catalog.data ?? []).map((session) =>
    localNames[session.sessionId]
      ? { ...session, meta: { ...(session.meta ?? {}), name: localNames[session.sessionId] } }
      : session,
  );
  const groups = groupSessionsByHost(sessions, filter);
  const menuPane = menu ? availability(menu.id) : { allowed: false };
  const searching = filter.trim().length > 0;

  function toggleHost(hostId: string) {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        /* private mode */
      }
      return next;
    });
  }

  async function submitSpawn(event: FormEvent, group: { hostId: string; sessions: ServerSession[] }) {
    event.preventDefault();
    const target =
      group.sessions.find((session) => session.sessionId === activeSessionId)?.sessionId ?? group.sessions[0]?.sessionId;
    if (!target) return;
    setSpawnBusy(true);
    setSpawnError(null);
    try {
      const result = await connection.spawn(target, { name: spawnName.trim() || undefined, mode: spawnMode });
      setSpawnHost(null);
      setSpawnName("");
      setSpawnMode("session");
      onNavigate?.();
      void queryClient.invalidateQueries({ queryKey: ["catalog"] });
      if (result.sessionId) void navigate({ to: "/s/$sessionId", params: { sessionId: result.sessionId } });
    } catch (error) {
      setSpawnError(String((error as Error)?.message ?? error));
    } finally {
      setSpawnBusy(false);
    }
  }

  async function saveName(sessionId: string, name: string) {
    setEditing(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    setLocalNames((previous) => ({ ...previous, [sessionId]: trimmed }));
    try {
      await connection.rename(sessionId, trimmed);
    } catch {
      setLocalNames((previous) => {
        const next = { ...previous };
        delete next[sessionId];
        return next;
      });
    }
    void queryClient.invalidateQueries({ queryKey: ["catalog"] });
  }

  return (
    <aside className="flex h-full w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-4 py-3.5">
        <span className="text-sm font-semibold tracking-tight">Pinet</span>
        <ConnectionDot />
      </div>

      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 rounded-lg bg-foreground/[0.04] px-2.5 py-1.5 transition-colors focus-within:bg-foreground/[0.06]">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Search sessions"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {catalog.isLoading && <p className="px-2 py-2 text-xs text-muted-foreground">Loading…</p>}
        {!catalog.isLoading && groups.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {searching ? "No matching sessions." : <>No sessions. Run <code>/pinet setup</code> on a host.</>}
          </p>
        )}

        {groups.map((group) => {
          const isCollapsed = !searching && collapsed.has(group.hostId);
          const capability = group.sessions.find((session) => session.meta?.spawn)?.meta?.spawn;
          const canSpawn = Boolean(capability && capability.mode !== "off");
          const spawnTitle = capability
            ? capability.mode === "session"
              ? `New session in ${capability.cwd}`
              : `New session (${capability.mode}${capability.git ? "" : ", needs a git repo"})`
            : "New session";
          return (
            <section key={group.hostId} className="mb-1">
              <div className="flex items-center gap-0.5 pt-2.5 pb-1.5">
                <button
                  type="button"
                  onClick={() => toggleHost(group.hostId)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-0.5 text-start transition-colors hover:bg-foreground/[0.03]"
                  title={group.hostId}
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform duration-200",
                      !isCollapsed && "rotate-90",
                    )}
                  />
                  <ServerIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                    {group.hostName}
                  </span>
                  <span
                    className={cn("size-1.5 shrink-0 rounded-full", group.hostConnected ? "bg-emerald-500" : "bg-foreground/20")}
                    title={group.hostConnected ? "host online" : "host offline"}
                  />
                  {capability && capability.active > 0 && (
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60" title={`${capability.active} spawned session(s)`}>
                      +{capability.active}
                    </span>
                  )}
                  <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{group.sessions.length}</span>
                </button>
                {canSpawn && (
                  <button
                    type="button"
                    aria-label={`New session on ${group.hostName}`}
                    title={spawnTitle}
                    onClick={() => {
                      setSpawnError(null);
                      setSpawnHost((value) => (value === group.hostId ? null : group.hostId));
                    }}
                    className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                  >
                    <PlusIcon className="size-3.5" />
                  </button>
                )}
              </div>

              {spawnHost === group.hostId && (
                <form onSubmit={(event) => void submitSpawn(event, group)} className="mx-1.5 mb-1 rounded-xl border border-border/60 bg-foreground/[0.02] p-2">
                  <input
                    autoFocus
                    value={spawnName}
                    onChange={(event) => setSpawnName(event.target.value)}
                    placeholder="Session name (optional)"
                    className="w-full rounded-md border border-border/60 bg-background px-2 py-1 text-[12.5px] outline-none focus:border-blue-500"
                  />
                  <div className="mt-2 flex items-center gap-1">
                    <button type="button" onClick={() => setSpawnMode("session")} className={spawnChip(spawnMode === "session")}>
                      Same dir
                    </button>
                    <button type="button" disabled title="Worktree mode is coming soon" className={spawnChip(false)}>
                      Worktree
                    </button>
                    <button
                      type="submit"
                      disabled={spawnBusy || !capability?.mode}
                      className="ms-auto inline-flex items-center gap-1 rounded-full bg-foreground px-2.5 py-1 text-[11.5px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {spawnBusy && <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" />}
                      Create
                    </button>
                  </div>
                  {capability && (
                    <p className="mt-1.5 truncate text-[10.5px] text-muted-foreground/60" title={capability.cwd}>
                      starts in {capability.cwd}
                    </p>
                  )}
                  {spawnError && <p className="mt-1 text-[11px] text-destructive">{spawnError}</p>}
                </form>
              )}

              {!isCollapsed &&
                group.sessions.map((session) => {
                  const active = session.sessionId === activeSessionId;
                  if (editing === session.sessionId) {
                    return (
                      <div key={session.sessionId} className="px-2.5 py-1">
                        <RenameInput
                          value={session.meta?.name ?? ""}
                          onSave={(name) => void saveName(session.sessionId, name)}
                          onCancel={() => setEditing(null)}
                        />
                      </div>
                    );
                  }
                  return (
                    <Link
                      key={session.sessionId}
                      to="/s/$sessionId"
                      params={{ sessionId: session.sessionId }}
                      search={() => searchFor(session.sessionId)}
                      onClick={onNavigate}
                      className={cn(
                        "group flex items-center gap-2.5 rounded-lg py-2 ps-8 pe-1.5 transition-colors",
                        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-foreground/[0.04]",
                      )}
                    >
                      <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-[13px]">{session.meta?.name ?? "(unnamed)"}</span>
                      {sidePaneIds.includes(session.sessionId) && (
                        <PanelRightIcon
                          className="size-3 shrink-0 text-muted-foreground/50"
                          aria-label="Open in a side pane"
                        />
                      )}
                      <button
                        type="button"
                        aria-label="Session actions"
                        aria-haspopup="menu"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setMenu({ id: session.sessionId, anchor: event.currentTarget });
                        }}
                        className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-40 transition-opacity hover:bg-foreground/[0.08] hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                      >
                        <MoreVerticalIcon className="size-3.5" />
                      </button>
                    </Link>
                  );
                })}
            </section>
          );
        })}
      </div>

      <div className="border-t border-sidebar-border p-2.5">
        <Link
          to="/settings"
          onClick={onNavigate}
          className="group/account flex items-center gap-2.5 rounded-xl p-1.5 transition-colors hover:bg-foreground/[0.04]"
        >
          <Avatar name={me.data?.name} email={me.data?.email} src={me.data?.avatarUrl} />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[12.5px] font-medium text-foreground/90">
              {me.data?.name?.trim() || me.data?.email?.split("@")[0] || "Account"}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground/75" title={me.data?.email}>
              {me.data?.email}
            </span>
          </span>
          <SettingsIcon className="size-4 shrink-0 text-muted-foreground/40 transition-colors duration-200 group-hover/account:text-muted-foreground" />
        </Link>
      </div>
      {menu && (
        <RowMenu
          anchor={menu.anchor}
          availability={menuPane}
          onClose={() => setMenu(null)}
          onRename={() => {
            setEditing(menu.id);
            setMenu(null);
            onNavigate?.();
          }}
          onOpenSide={() => {
            const target = menu.id;
            setMenu(null);
            onNavigate?.();
            openToSide(target);
          }}
        />
      )}
    </aside>
  );
}
