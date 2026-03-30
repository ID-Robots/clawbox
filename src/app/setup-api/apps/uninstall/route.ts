import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
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
    try {
      await fs.rm(skillDir, { recursive: true, force: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `Failed to remove skill: ${msg}` }, { status: 500 });
    }

    // Remove cached icon
    const iconPath = path.join(HOME, "clawbox", "data", "icons", `${appId}.png`);
    await fs.rm(iconPath, { force: true }).catch(() => {});

    // Reload gateway so agent drops the skill
    await reloadGateway();

    return NextResponse.json({ ok: true, appId });
  } catch (err) {
    console.error("[uninstall] Uninstall failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Uninstall failed" }, { status: 500 });
  }
}
