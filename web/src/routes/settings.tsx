import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, LogOutIcon } from "lucide-react";
import { clearDevice } from "../lib/device";
import { getMe, listDevices, logout, revokeDevice } from "../lib/api";
import { isIosSafari, isStandalone, useInstallPrompt } from "../lib/pwa";
import { cn } from "../lib/utils";
import { mono, paper } from "../components/ui/surfaces";
import { Avatar } from "../components/Avatar";
import { InstallButton } from "../components/InstallButton";

function InstallRow() {
  const { canInstall, installed } = useInstallPrompt();
  const standalone = isStandalone();
  const ios = isIosSafari() && !standalone;
  const available = canInstall || ios;
  const done = installed || standalone;

  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="font-medium">Install Pinet</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {done
            ? "Pinet is installed on this device."
            : available
              ? "Add Pinet to your home screen for a full-screen, app-like experience."
              : "This browser doesn't offer app installation."}
        </p>
      </div>
      {done ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400">
          <CheckIcon className="size-3.5" /> Installed
        </span>
      ) : available ? (
        <InstallButton />
      ) : null}
    </div>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false });
  const devices = useQuery({ queryKey: ["devices"], queryFn: listDevices, retry: false });

  return (
    <div className="mx-auto max-w-2xl space-y-8 overflow-y-auto px-6 py-8">
      <section className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both duration-300 motion-reduce:animate-none">
        <h1 className="mb-3 text-lg font-semibold tracking-tight">Account</h1>
        <div className={cn(paper, "rounded-2xl p-4 text-sm")}>
          <div className="mb-4 flex items-center gap-3">
            <Avatar name={me.data?.name} email={me.data?.email} src={me.data?.avatarUrl} className="size-10 text-[13px]" />
            <div className="min-w-0">
              <p className="truncate font-medium">{me.data?.name ?? "—"}</p>
              <p className="truncate text-xs text-muted-foreground">{me.data?.email ?? "—"}</p>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Authenticator app</span>
            <span className={me.data?.mfaEnrolled ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}>
              {me.data?.mfaEnrolled ? "enabled" : "not set up"}
            </span>
          </div>
          {!me.data?.mfaEnrolled && (
            <a
              href="/auth/mfa/setup"
              className="mt-4 inline-block rounded-lg bg-foreground px-3 py-1.5 text-xs font-semibold text-background transition-[opacity,scale] duration-150 hover:opacity-90 active:scale-[0.98]"
            >
              Set up authenticator app
            </a>
          )}
        </div>
      </section>

      <section className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both duration-300 [animation-delay:60ms] motion-reduce:animate-none">
        <h2 className="mb-3 text-lg font-semibold tracking-tight">App</h2>
        <div className={cn(paper, "rounded-2xl p-4 text-sm")}>
          <InstallRow />
        </div>
      </section>

      <section className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both duration-300 [animation-delay:120ms] motion-reduce:animate-none">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-lg font-semibold tracking-tight">Devices</h2>
          <button
            type="button"
            onClick={() => void devices.refetch()}
            className="ml-auto rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            Refresh
          </button>
        </div>
        <div className={cn(paper, "overflow-hidden rounded-2xl")}>
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {(devices.data ?? []).map((device) => (
                <tr key={device.id} className="border-t border-border/60">
                  <td className="px-4 py-2.5">{device.name}</td>
                  <td className={cn("px-4 py-2.5 text-muted-foreground", mono)}>{device.kind}</td>
                  <td className="px-4 py-2.5">
                    <span className={device.revoked ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}>
                      {device.revoked ? "revoked" : "active"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {!device.revoked && (
                      <button
                        type="button"
                        onClick={async () => {
                          await revokeDevice(device.id);
                          await devices.refetch();
                        }}
                        className="rounded-lg px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {devices.data?.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-center text-muted-foreground">
                    No devices yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <button
          type="button"
          onClick={async () => {
            await clearDevice();
            queryClient.clear();
            location.reload();
          }}
          className="mt-3 rounded-lg px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
        >
          Forget this browser's device keys
        </button>
      </section>

      <section className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both duration-300 [animation-delay:180ms] motion-reduce:animate-none">
        <h2 className="mb-3 text-lg font-semibold tracking-tight">Session</h2>
        <div className={cn(paper, "flex items-center justify-between gap-4 rounded-2xl p-4 text-sm")}>
          <div className="min-w-0">
            <p className="font-medium">Sign out</p>
            <p className="mt-0.5 text-xs text-muted-foreground">End this browser's session. Enrolled device keys are kept.</p>
          </div>
          <button
            type="button"
            onClick={async () => {
              await logout();
              await queryClient.invalidateQueries({ queryKey: ["me"] });
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:bg-destructive/10 hover:text-destructive"
          >
            <LogOutIcon className="size-3.5" /> Sign out
          </button>
        </div>
      </section>
    </div>
  );
}
