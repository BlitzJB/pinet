import { useCallback, useMemo } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { addSide, closePane, paneAction, paneList, parseSide, sideParam } from "./panes";

/**
 * Single source of truth for the pane layout. The primary session comes from the
 * route path, side panes from the `?side=` search param, so every consumer
 * (sidebar, pane chrome) navigates through the same helpers instead of each
 * re-deriving it.
 */
export function usePanes() {
  const navigate = useNavigate();
  const primary = useRouterState({ select: (state) => state.location.pathname.match(/\/s\/([^/]+)/)?.[1] });
  const sideRaw = useRouterState({
    select: (state) => (state.location.search as { side?: string } | undefined)?.side,
  });
  const side = useMemo(() => parseSide(sideRaw), [sideRaw]);
  const panes = useMemo(() => paneList(primary, side), [primary, side]);

  /** Whether "open to the side" is available for a session, and why not. */
  const availability = useCallback((id: string) => paneAction(primary, side, id), [primary, side]);

  /** Layout search to use when navigating to a row, dropping that row's own pane. */
  const searchFor = useCallback(
    (id: string) => ({ side: sideParam(side.filter((pane) => pane !== id)) }),
    [side],
  );

  const openToSide = useCallback(
    (id: string) => {
      if (!primary) {
        void navigate({ to: "/s/$sessionId", params: { sessionId: id } });
        return;
      }
      const next = addSide(primary, side, id);
      if (next === side) return;
      void navigate({ to: "/s/$sessionId", params: { sessionId: primary }, search: { side: sideParam(next) } });
    },
    [navigate, primary, side],
  );

  const close = useCallback(
    (id: string) => {
      if (!primary) return;
      const next = closePane(primary, side, id);
      if (!next.primary) {
        void navigate({ to: "/" });
        return;
      }
      void navigate({
        to: "/s/$sessionId",
        params: { sessionId: next.primary },
        search: { side: sideParam(next.side) },
      });
    },
    [navigate, primary, side],
  );

  return { primary, side, panes, availability, searchFor, openToSide, close };
}
