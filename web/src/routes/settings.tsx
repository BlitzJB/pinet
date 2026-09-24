import { useQuery, useQueryClient } from "@tanstack/react-query";
import { clearDevice } from "../lib/device";
import { getMe, listDevices, revokeDevice } from "../lib/api";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const me = useQuery({ queryKey: ["me"], queryFn: getMe, retry: false });
  const devices = useQuery({ queryKey: ["devices"], queryFn: listDevices, retry: false });

  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
      <section>
        <h1 className="mb-3 text-lg font-semibold text-mist-200">Account</h1>
        <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-mist-400">Email</span>
            <span className="text-mist-200">{me.data?.email ?? "—"}</span>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-mist-400">Multi-factor (authenticator app)</span>
            <span className={me.data?.mfaEnrolled ? "text-ok-400" : "text-warn-400"}>{me.data?.mfaEnrolled ? "enabled" : "not set up"}</span>
          </div>
          {!me.data?.mfaEnrolled && (
            <a href="/auth/mfa/setup" className="mt-3 inline-block rounded-lg bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-400">
              Set up authenticator app
            </a>
          )}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-lg font-semibold text-mist-200">Devices</h2>
          <button
            type="button"
            onClick={() => void devices.refetch()}
            className="ml-auto rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-mist-300 hover:bg-ink-800"
          >
            Refresh
          </button>
        </div>
        <div className="overflow-hidden rounded-xl border border-ink-800">
          <table className="w-full text-left text-sm">
            <thead className="bg-ink-900 text-xs uppercase tracking-wide text-mist-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {(devices.data ?? []).map((device) => (
                <tr key={device.id} className="border-t border-ink-800">
                  <td className="px-4 py-2.5 text-mist-200">{device.name}</td>
                  <td className="px-4 py-2.5 text-mist-400">{device.kind}</td>
                  <td className="px-4 py-2.5">
                    <span className={device.revoked ? "text-bad-400" : "text-ok-400"}>{device.revoked ? "revoked" : "active"}</span>
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {!device.revoked && (
                      <button
                        type="button"
                        onClick={async () => {
                          await revokeDevice(device.id);
                          await devices.refetch();
                        }}
                        className="rounded-lg border border-ink-700 px-2.5 py-1 text-xs text-bad-400 hover:bg-bad-400/10"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {devices.data?.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-4 text-center text-mist-400">
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
          className="mt-3 rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-mist-300 hover:bg-ink-800"
        >
          Forget this browser's device keys
        </button>
      </section>
    </div>
  );
}
