import { useState } from "react";
import { Outlet, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { MenuIcon } from "lucide-react";
import { getMe, loginUrl } from "../lib/api";
import { PinetProvider } from "../lib/context";
import { SessionSidebar } from "../components/SessionSidebar";
import { ghostButton } from "../components/ui/surfaces";

function Splash() {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex items-center gap-3 text-muted-foreground">
        <span className="size-3 animate-pulse rounded-full bg-foreground/30" />
        Loading Pinet…
      </div>
    </div>
  );
}

function Login() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both w-full max-w-sm rounded-2xl border border-border/60 bg-card p-8 text-center shadow-xl duration-300 motion-reduce:animate-none">
        <div className="mb-1 text-2xl font-semibold tracking-tight">Pinet</div>
        <p className="mb-6 text-sm text-muted-foreground">Remote control for pi coding-agent sessions.</p>
        <a
          href={loginUrl("/app/")}
          className="inline-flex w-full items-center justify-center rounded-xl bg-foreground px-4 py-2.5 text-sm font-semibold text-background transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.98]"
        >
          Sign in with Google
        </a>
      </div>
    </div>
  );
}

function AppShell({ email }: { email: string }) {
  const [drawer, setDrawer] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const activeSessionId = pathname.match(/\/s\/([^/]+)/)?.[1];

  return (
    <div className="flex h-full">
      <div className="hidden md:flex">
        <SessionSidebar activeSessionId={activeSessionId} />
      </div>

      {drawer && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="fade-in animate-in duration-200 motion-reduce:animate-none">
            <SessionSidebar activeSessionId={activeSessionId} onNavigate={() => setDrawer(false)} />
          </div>
          <button type="button" aria-label="Close menu" onClick={() => setDrawer(false)} className="fade-in animate-in flex-1 bg-black/40 backdrop-blur-sm duration-200" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 md:hidden">
          <button type="button" aria-label="Open menu" onClick={() => setDrawer(true)} className={ghostButton + " size-8"}>
            <MenuIcon className="size-4" />
          </button>
          <span className="text-sm font-semibold">Pinet</span>
          <span className="ml-auto truncate text-[11px] text-muted-foreground">{email}</span>
        </div>
        <main className="min-h-0 flex-1">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function Root() {
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false, staleTime: 30_000 });
  if (me.isLoading) return <Splash />;
  if (me.isError || !me.data) return <Login />;
  return (
    <PinetProvider>
      <AppShell email={me.data.email} />
    </PinetProvider>
  );
}
