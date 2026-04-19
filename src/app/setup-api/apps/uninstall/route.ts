import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { getAll as configGetAll, setMany as configSetMany } from "@/lib/config-store";
import { reloadGateway, getSkillsDir } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

const HOME = process.env.HOME || "/home/clawbox";

export async function POST(req: Request) {
  try {
    const { appId } = await req.json();
    if (!appId || typeof appId !== "string" || !/^[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }

    // Remove the skill directory (with path traversal guard)
    const skillRoot = path.resolve(getSkillsDir(), "skills");
    const skillDir = path.resolve(skillRoot, appId);
    if (!skillDir.startsWith(skillRoot + path.sep)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }
    await fs.rm(skillDir, { recursive: true, force: true });

    // Remove cached icon
    const iconPath = path.join(HOME, "clawbox", "data", "icons", `${appId}.png`);
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

    // Reload gateway so agent drops the skill
    try {
      await reloadGateway();
    } catch (err) {
      console.warn("[uninstall] reloadGateway failed:", err instanceof Error ? err.message : err);
    }

    return NextResponse.json({ ok: true, appId });
  } catch (err) {
    console.error("[uninstall] Uninstall failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Uninstall failed" }, { status: 500 });
  }
}
