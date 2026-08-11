import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR, getAll as configGetAll, setMany as configSetMany } from "@/lib/config-store";
import { getSkillsDir } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { appId } = await req.json();
    if (!appId || typeof appId !== "string" || !/^(?!-)[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }

    // Remove the skill directory (with path traversal guard)
    const skillRoot = path.resolve(getSkillsDir(), "skills");
    const skillDir = path.resolve(skillRoot, appId);
    if (!skillDir.startsWith(skillRoot + path.sep)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }
    await fs.rm(skillDir, { recursive: true, force: true });

    // Remove cached icon from the same location the install/icon routes use
    // (DATA_DIR/icons). The old hardcoded ~/clawbox/data/icons path diverged
    // whenever CLAWBOX_ROOT != $HOME/clawbox, orphaning the PNG on disk.
    const iconPath = path.join(DATA_DIR, "icons", `${appId}.png`);
    await fs.rm(iconPath, { force: true }).catch(() => {});

    // Keep the desktop's `installed_apps` and `installed_meta` preferences
    // in sync — same reason as the install route: MCP / CLI uninstalls would
    // otherwise leave stale entries in the Store's Installed tab and a
    // phantom desktop icon until the next page mount.
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
      if (Object.keys(updates).length > 0) {
        await configSetMany(updates);
      }
    } catch (err) {
      console.warn("[uninstall] Failed to update installed_apps/meta preferences:", err instanceof Error ? err.message : err);
    }

    // No gateway bounce: removing the skill directory is a change under a
    // watched skill root, so the agent drops the skill on its next turn.
    return NextResponse.json({ ok: true, appId });
  } catch (err) {
    console.error("[uninstall] Uninstall failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Uninstall failed" }, { status: 500 });
  }
}
