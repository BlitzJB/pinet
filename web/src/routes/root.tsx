import { Link, Outlet } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getMe, loginUrl, logout } from "../lib/api";
import { PinetProvider } from "../lib/context";
import { ConnectionBadge } from "../components/ConnectionBadge";

function Splash() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex items-center gap-3 text-mist-400">
        <span className="h-3 w-3 animate-pulse rounded-full bg-brand-500" />
        Loading Pinet…
      </div>
    </div>
  );
}

function Login() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="w-full max-w-sm rounded-2xl border border-ink-800 bg-ink-900/80 p-8 text-center shadow-xl">
        <div className="mb-1 text-2xl font-semibold text-mist-200">Pinet</div>
        <p className="mb-6 text-sm text-mist-400">Remote control for pi coding-agent sessions.</p>
        <a
          href={loginUrl("/app/")}
          className="inline-flex w-full items-center justify-center rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-400"
        >
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

export function Root() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false, staleTime: 30_000 });

  if (me.isLoading) return <Splash />;
  if (me.isError || !me.data) return <Login />;

  return (
    <PinetProvider>
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-4 border-b border-ink-800 bg-ink-900/80 px-4 py-2.5">
          <Link to="/" className="text-sm font-semibold tracking-tight text-mist-200">
            Pinet
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            <Link to="/" className="text-mist-400 hover:text-mist-200" activeProps={{ className: "text-brand-400" }}>
              Sessions
            </Link>
            <Link to="/settings" className="text-mist-400 hover:text-mist-200" activeProps={{ className: "text-brand-400" }}>
              Settings
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-4">
            <ConnectionBadge />
            <span className="hidden text-xs text-mist-400 sm:inline">{me.data.email}</span>
            <button
              type="button"
              onClick={async () => {
                await logout();
                await queryClient.invalidateQueries({ queryKey: ["me"] });
              }}
              className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-mist-300 hover:bg-ink-800"
            >
              Sign out
            </button>
          </div>
        </header>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </PinetProvider>
  );
}
