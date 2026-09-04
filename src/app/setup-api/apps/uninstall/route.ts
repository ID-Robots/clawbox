import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR, getAll as configGetAll, setMany as configSetMany } from "@/lib/config-store";
import { setPreferences } from "@/lib/preference-store";
import { clearSkillEntry, openclawSkillRoot } from "@/lib/openclaw-config";
import { refreshSkillsCache } from "@/lib/openclaw-skill-info";
import { kvDelete } from "@/lib/kv-store";
import { WEBAPPS_DIR } from "@/lib/code-projects";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { appId } = await req.json();
    if (!appId || typeof appId !== "string" || !/^(?!-)[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }

    // Remove the skill directory (with path traversal guard).
    //
    // ONLY where there is an OpenClaw to have one. This route is deliberately
    // reachable on Hermes — openclaw-apps-server.ts records why: the MCP
    // `app_uninstall` tool posts here, so the agent can still remove a webapp
    // whose store the UI has hidden, and refusing would strand those apps in
    // the prefs with nothing able to delete them. What must not follow from
    // that is a delete under a path the edition does not have: `getSkillsDir()`
    // falls back to ~/clawd, and this line resolved <appId> under it and
    // answered {ok:true} for the removal it had not made.
    const skillRoot = openclawSkillRoot();
    // What actually happened to the skill half, so the answer can say it.
    //   true  — a skill directory was there and is gone
    //   false — this box has a skills root and nothing of that name was in it
    //   null  — there is no OpenClaw skills root on this device to look in
    // `{ok:true}` alone said the same thing for all three, which is the half of
    // the wrong-directory delete that a guard on its own does not close.
    let skillRemoved: boolean | null = null;
    if (skillRoot) {
      const skillDir = path.resolve(skillRoot, appId);
      if (!skillDir.startsWith(skillRoot + path.sep)) {
        return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
      }
      skillRemoved = await fs
        .stat(skillDir)
        .then(() => true)
        .catch(() => false);
      await fs.rm(skillDir, { recursive: true, force: true });
    }

    // Remove the deployed webapp, if this app is one. `webapp_create`,
    // `webapp_update` and `code_project_build` all deploy to
    // data/webapps/<appId>/, and /setup-api/webapps serves straight off that
    // directory — so an uninstall that only dropped the preference left the
    // page live at /setup-api/webapps?app=<appId> for anyone who still had the
    // URL, while the desktop said the app was gone. code_project_delete's own
    // guidance ("any copy already installed on the desktop stays until it is
    // removed with app_uninstall") promises this removal.
    const webappRoot = path.resolve(WEBAPPS_DIR);
    const webappDir = path.resolve(webappRoot, appId);
    if (!webappDir.startsWith(webappRoot + path.sep)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }
    await fs.rm(webappDir, { recursive: true, force: true });

    // Remove cached icon from the same location the install/icon routes use
    // (DATA_DIR/icons). The old hardcoded ~/clawbox/data/icons path diverged
    // whenever CLAWBOX_ROOT != $HOME/clawbox, orphaning the PNG on disk.
    const iconPath = path.join(DATA_DIR, "icons", `${appId}.png`);
    await fs.rm(iconPath, { force: true }).catch(() => {});

    // The skill's `skills.entries.<id>` in openclaw.json goes too, or a later
    // install under the same id silently inherits `enabled: false`. Best
    // effort, like the icon: the files are already gone. Same edition
    // condition as the directory above — not because the call would write
    // anything on a box with no config (it returns early on a missing entry,
    // before `writeConfig` is reached), but because on the hermes SKU there is
    // no OpenClaw configuration for this route to own, and a leftover
    // ~/.openclaw/openclaw.json on that SKU is not ours to rewrite.
    if (skillRoot) {
      await clearSkillEntry(appId).catch((err) => {
        console.warn("[uninstall] Failed to clear the skill's openclaw.json entry:", err instanceof Error ? err.message : err);
      });
    }

    // Keep the desktop's `installed_apps` and `installed_meta` preferences
    // in sync — same reason as the install route: MCP / CLI uninstalls would
    // otherwise leave stale entries in the Store's Installed tab and a
    // phantom desktop icon until the next page mount. These routes are the
    // only writers of the two keys; the desktop reads them.
    try {
      const all = await configGetAll();
      const currentApps = all["pref:installed_apps"];
      const currentMeta = all["pref:installed_meta"];
      const updates: Record<string, unknown> = {};

      if (Array.isArray(currentApps)) {
        const next = (currentApps as string[]).filter((id) => id !== appId);
        if (next.length !== currentApps.length) {
          updates["pref:installed_apps"] = next;
        }
      }
      if (currentMeta && typeof currentMeta === "object" && appId in (currentMeta as Record<string, unknown>)) {
        const metaMap = { ...(currentMeta as Record<string, unknown>) };
        delete metaMap[appId];
        updates["pref:installed_meta"] = metaMap;
      }
      // setPreferences applies the preference rules — this does not go through
      // POST /setup-api/preferences, and removing one entry writes the rest of
      // the collection back out with it.
      await setPreferences(updates);
      // The window's saved form values. A delete, not a preference write, so
      // it goes straight to the store: setPreferences drops an undefined.
      const settingsKey = `pref:app_${appId}_settings`;
      if (settingsKey in all) await configSetMany({ [settingsKey]: undefined });
    } catch (err) {
      console.warn("[uninstall] Failed to update installed_apps/meta preferences:", err instanceof Error ? err.message : err);
    }

    // What the installed-app window kept in KV for this app: the form draft,
    // the enabled flag it used to mirror, and the window size. Left behind,
    // the flag made a reinstalled skill open as "Disabled".
    for (const key of [
      `clawbox-app-settings-${appId}`,
      `clawbox-skill-enabled-${appId}`,
      `clawbox-winsize-installed-${appId}`,
    ]) {
      try {
        kvDelete(key);
      } catch (err) {
        console.warn(`[uninstall] Failed to drop KV key ${key}:`, err instanceof Error ? err.message : err);
      }
    }

    // No gateway bounce: removing the skill directory is a change under a
    // watched skill root, so the agent drops the skill on its next turn. The
    // skill-info cache rescans behind this reply.
    refreshSkillsCache();
    return NextResponse.json({ ok: true, appId, skillRemoved });
  } catch (err) {
    console.error("[uninstall] Uninstall failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Uninstall failed" }, { status: 500 });
  }
}
