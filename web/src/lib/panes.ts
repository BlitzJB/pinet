/** Multi-pane helpers: the primary session comes from the route, side panes from ?side= */

export const MAX_PANES = 4;

/** Parse the `side` search param into an ordered, de-duplicated list of session ids. */
export function parseSide(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const id = String(value ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Serialise side panes back to the search param (undefined when empty). */
export function sideParam(ids: string[]): string | undefined {
  const clean = parseSide(ids);
  return clean.length ? clean.join(",") : undefined;
}

/** Sessions to render: primary first, then side panes, capped. */
export function paneList(primary: string | undefined, side: string[]): string[] {
  const list = primary ? [primary, ...side.filter((id) => id !== primary)] : side;
  return list.slice(0, MAX_PANES);
}

/** Why "open to the side" may be unavailable for `id`. */
export function paneAction(
  primary: string | undefined,
  side: string[],
  id: string,
): { allowed: boolean; reason?: string } {
  const panes = paneList(primary, side);
  if (panes.includes(id)) return { allowed: false, reason: "Already open in this view" };
  if (panes.length >= MAX_PANES) return { allowed: false, reason: `Limited to ${MAX_PANES} panes` };
  return { allowed: true };
}

/** Add `id` as a side pane (no-op when already present or when there is no primary). */
export function addSide(primary: string | undefined, side: string[], id: string): string[] {
  if (!primary || id === primary || side.includes(id)) return side;
  if (paneList(primary, side).length >= MAX_PANES) return side;
  return [...side, id];
}

/** Remove a pane and report what the route should become. */
export function closePane(
  primary: string,
  side: string[],
  id: string,
): { primary?: string; side: string[] } {
  if (id !== primary) return { primary, side: side.filter((pane) => pane !== id) };
  const rest = side.filter((pane) => pane !== id);
  return rest.length ? { primary: rest[0], side: rest.slice(1) } : { side: [] };
}
