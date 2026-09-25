import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareIcon, SearchIcon } from "lucide-react";
import { getMe, logout } from "../lib/api";
import { useConnectionState, usePinet } from "../lib/context";
import { cn } from "../lib/utils";
import { mono } from "./ui/surfaces";
import { InstallButton } from "./InstallButton";

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

export function SessionSidebar({ activeSessionId, onNavigate }: { activeSessionId?: string; onNavigate?: () => void }) {
  const connection = usePinet();
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false, staleTime: 30_000 });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: () => connection.list(), refetchInterval: 5_000 });
  const [filter, setFilter] = useState("");

  const sessions = (catalog.data ?? []).filter((session) => {
    if (!filter) return true;
    const needle = filter.toLowerCase();
    return [session.meta?.name, session.hostName, session.meta?.cwd, session.sessionId]
      .filter(Boolean)
      .some((field) => String(field).toLowerCase().includes(needle));
  });

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
        {!catalog.isLoading && sessions.length === 0 && (
          <p className="px-2 py-2 text-xs text-muted-foreground">No sessions. Run <code>/pinet setup</code> on a host.</p>
        )}
        {sessions.map((session) => {
          const active = session.sessionId === activeSessionId;
          return (
            <Link
              key={session.sessionId}
              to="/s/$sessionId"
              params={{ sessionId: session.sessionId }}
              onClick={onNavigate}
              className={cn(
                "group flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors",
                active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-foreground/[0.04]",
              )}
            >
              <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-[13px]">{session.meta?.name ?? "(unnamed)"}</span>
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  session.hostConnected ? "bg-emerald-500" : "bg-foreground/20",
                )}
                title={session.hostConnected ? "host online" : "host offline"}
              />
            </Link>
          );
        })}
      </div>

      <div className="flex flex-col gap-2 border-t border-sidebar-border px-3 py-3">
        <div className="truncate text-[11px] text-muted-foreground">{me.data?.email}</div>
        <InstallButton />
        <div className="flex items-center gap-2">
          <Link
            to="/settings"
            onClick={onNavigate}
            className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            Settings
          </Link>
          <button
            type="button"
            onClick={async () => {
              await logout();
              await queryClient.invalidateQueries({ queryKey: ["me"] });
            }}
            className={cn(mono, "ml-auto rounded-lg px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground")}
          >
            Sign out
          </button>
        </div>
      </div>
    </aside>
  );
}
