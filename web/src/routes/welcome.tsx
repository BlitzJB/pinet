import { TerminalIcon } from "lucide-react";

export function WelcomePage() {
  return (
    <div className="grid h-full place-items-center px-6">
      <div className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both flex max-w-md flex-col items-center gap-4 text-center duration-300 motion-reduce:animate-none">
        <div className="grid size-12 place-items-center rounded-2xl border border-border/60 bg-foreground/[0.03]">
          <TerminalIcon className="size-5 text-muted-foreground" />
        </div>
        <h1 className="text-xl font-semibold tracking-tight">Pick a session</h1>
        <p className="text-sm text-muted-foreground">
          Choose a session from the sidebar to view its live transcript and talk to the agent. Sessions appear here once a host
          has run <code className="rounded bg-foreground/[0.06] px-1.5 py-0.5 font-mono text-[12px]">/pinet setup</code>.
        </p>
      </div>
    </div>
  );
}
