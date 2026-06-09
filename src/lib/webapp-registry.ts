import { getAll, setMany } from "@/lib/config-store";

interface InstalledMeta {
  name: string;
  color: string;
  iconUrl: string;
  webappUrl: string;
}

/**
 * Durably register a webapp on the desktop by writing the same preference keys
 * the live desktop writes when it consumes a `register_webapp` ui:pending-action
 * (see src/app/page.tsx). That handoff only lands if the desktop happens to be
 * open and polling — so a webapp created while the desktop is closed gets its
 * HTML saved but never reaches the app grid. Persisting here closes that gap:
 * the desktop reads `installed_apps` / `installed_meta` from
 * /setup-api/preferences on mount, so the app shows up on its next load.
 *
 * Idempotent (add-if-missing); also un-hides the app, mirroring the live
 * handler. The ui:pending-action emit stays in place for instant updates on an
 * already-open desktop — this is the durability backstop.
 */
export async function registerWebappInPreferences(
  appId: string,
  name: string,
  opts: { color?: string; iconUrl?: string; webappUrl?: string } = {},
): Promise<void> {
  // One read of the config, not three — config-store.get() re-reads and
  // re-parses the whole file on each call, and reading the three keys together
  // also narrows the read-modify-write window.
  const prefs = await getAll();
  const installedApps = (prefs["pref:installed_apps"] as string[] | undefined) ?? [];
  const installedMeta = (prefs["pref:installed_meta"] as Record<string, InstalledMeta> | undefined) ?? {};
  const hiddenInstalled = (prefs["pref:hidden_installed"] as string[] | undefined) ?? [];

  await setMany({
    "pref:installed_apps": installedApps.includes(appId) ? installedApps : [...installedApps, appId],
    "pref:installed_meta": {
      ...installedMeta,
      [appId]: {
        name,
        color: opts.color || "#f97316",
        iconUrl: opts.iconUrl || "",
        webappUrl: opts.webappUrl || `/setup-api/webapps?app=${appId}`,
      },
    },
    // A freshly (re)created app shouldn't stay hidden.
    "pref:hidden_installed": hiddenInstalled.filter((id) => id !== appId),
  });
}
