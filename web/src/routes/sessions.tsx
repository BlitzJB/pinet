import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from "@tanstack/react-table";
import { usePinet } from "../lib/context";
import type { ServerSession } from "../lib/api";

const column = createColumnHelper<ServerSession>();

export function SessionsPage() {
  const connection = usePinet();
  const [filter, setFilter] = useState("");
  const [sorting, setSorting] = useState<SortingState>([{ id: "name", desc: false }]);

  const catalog = useQuery({
    queryKey: ["catalog"],
    queryFn: () => connection.list(),
    refetchInterval: 4_000,
    enabled: true,
  });

  const columns = useMemo(
    () => [
      column.accessor((row) => row.meta?.name ?? "(unnamed)", {
        id: "name",
        header: "Session",
        cell: (info) => <span className="font-medium text-mist-200">{info.getValue()}</span>,
      }),
      column.accessor((row) => row.hostName ?? row.hostId, { id: "host", header: "Host" }),
      column.accessor((row) => row.meta?.cwd ?? "", { id: "cwd", header: "Working dir", cell: (info) => <span className="font-mono text-xs text-mist-400">{info.getValue()}</span> }),
      column.accessor((row) => (row.hostConnected ? "online" : "offline"), {
        id: "state",
        header: "State",
        cell: (info) => <span className={info.getValue() === "online" ? "text-ok-400" : "text-bad-400"}>{info.getValue()}</span>,
      }),
      column.display({
        id: "action",
        header: "",
        cell: ({ row }) => (
          <Link
            to="/s/$sessionId"
            params={{ sessionId: row.original.sessionId }}
            className="rounded-lg bg-brand-500/90 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-400"
          >
            Open
          </Link>
        ),
      }),
    ],
    [],
  );

  const sessions = catalog.data ?? [];
  const table = useReactTable({
    data: sessions,
    columns,
    state: { globalFilter: filter, sorting },
    onGlobalFilterChange: setFilter,
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    globalFilterFn: (row, _columnId, value) => {
      const needle = String(value).toLowerCase();
      return [row.original.meta?.name, row.original.hostName, row.original.meta?.cwd, row.original.sessionId]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle));
    },
  });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold text-mist-200">Sessions</h1>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter…"
          className="ml-auto w-56 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm outline-none focus:border-brand-500"
        />
        <button
          type="button"
          onClick={() => void catalog.refetch()}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-mist-300 hover:bg-ink-800"
        >
          Refresh
        </button>
      </div>

      {catalog.isLoading ? (
        <p className="text-sm text-mist-400">Loading sessions…</p>
      ) : catalog.isError ? (
        <p className="text-sm text-bad-400">Could not load sessions: {String((catalog.error as Error)?.message ?? catalog.error)}</p>
      ) : sessions.length === 0 ? (
        <p className="text-sm text-mist-400">No sessions. Start a host and run <code className="rounded bg-ink-800 px-1">/pinet setup</code>.</p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-ink-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-ink-900 text-xs uppercase tracking-wide text-mist-400">
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id}>
                  {group.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className="cursor-pointer px-4 py-2.5 font-medium select-none"
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === "asc" ? " ↑" : header.column.getIsSorted() === "desc" ? " ↓" : ""}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr key={row.id} className="border-t border-ink-800 hover:bg-ink-850/60">
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-2.5">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
