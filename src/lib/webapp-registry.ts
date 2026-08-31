import { getAll } from "@/lib/config-store";
import { boundPreferenceText } from "@/lib/preference-schema";
import { setPreferences } from "@/lib/preference-store";

interface InstalledMeta {
  name: string;
  color: string;
  iconUrl: string;
  webappUrl: string;
  launch?: "window";
  public?: boolean;
}

/**
 * Durably register a webapp on the desktop by writing the same preference keys
 * the live desktop writes when it consumes a `register_webapp` entry from the
 * owner-notice ring (`ui:pending-actions`, src/lib/pending-actions.ts — see
 * src/app/page.tsx). That handoff only lands if the desktop happens to be
 * open and polling — so a webapp created while the desktop is closed gets its
 * HTML saved but never reaches the app grid. Persisting here closes that gap:
 * the desktop reads `installed_apps` / `installed_meta` from
 * /setup-api/preferences on mount, so the app shows up on its next load.
 *
 * Idempotent (add-if-missing); also un-hides the app, mirroring the live
 * handler. The ring push stays in place for instant updates on an
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

  // setPreferences applies the preference rules — this does not go through
  // POST /setup-api/preferences, and the update carries over every entry read
  // above alongside the one being added.
  await setPreferences({
    "pref:installed_apps": installedApps.includes(appId) ? installedApps : [...installedApps, appId],
    "pref:installed_meta": {
      ...installedMeta,
      [appId]: {
        // A rebuild re-registers the app; the owner's launch/public flags on
        // the previous entry survive it, everything else is the fresh build's.
        ...(installedMeta[appId]?.launch ? { launch: installedMeta[appId].launch } : {}),
        ...(installedMeta[appId]?.public ? { public: true } : {}),
        name: boundPreferenceText(name, appId),
        color: opts.color || "#f97316",
        iconUrl: opts.iconUrl || "",
        webappUrl: opts.webappUrl || `/setup-api/webapps?app=${appId}`,
      },
    },
    // A freshly (re)created app shouldn't stay hidden.
    "pref:hidden_installed": hiddenInstalled.filter((id) => id !== appId),
  });
}
