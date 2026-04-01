import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR, CONFIG_ROOT } from "@/lib/config-store";
import { reloadGateway, getSkillsDir, findOpenclawBin } from "@/lib/openclaw-config";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const ICONS_DIR = path.join(DATA_DIR, "icons");
const STORE_ICONS_BASE = "https://openclawhardware.dev/store/icons";


export async function POST(req: Request) {
  try {
    const { appId } = await req.json();
    if (!appId || typeof appId !== "string" || !/^[A-Za-z0-9_-]+$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }

    // Ensure icons directory exists
    await fs.mkdir(ICONS_DIR, { recursive: true });

    // Download icon from store
    const iconUrl = `${STORE_ICONS_BASE}/${appId}.png`;
    const iconPath = path.join(ICONS_DIR, `${appId}.png`);
    let iconSaved = false;

    try {
      const res = await fetch(iconUrl);
      if (res.ok) {
        const buffer = Buffer.from(await res.arrayBuffer());
        await fs.writeFile(iconPath, buffer);
        iconSaved = true;
      }
    } catch (err) {
      console.warn(`[apps/install] Failed to download icon for ${appId}:`, err);
    }

    // Run openclaw skills install
    const openclawBin = findOpenclawBin();
    const skillsDir = getSkillsDir();
    await fs.mkdir(path.join(skillsDir, "skills"), { recursive: true });

    let clawhubResult: { success: boolean; output?: string; error?: string } = { success: false };
    try {
      const { stdout, stderr } = await execFileAsync(openclawBin, [
        "skills", "install", appId,
        "--force",
      ], {
        timeout: 60_000,
        env: { ...process.env, PATH: `${path.dirname(openclawBin)}:${process.env.PATH}` },
      });
      clawhubResult = { success: true, output: stdout || stderr };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[apps/install] openclaw skills install ${appId} failed:`, msg);
      clawhubResult = { success: false, error: msg };
    }

    // Reload the OpenClaw gateway so it picks up the new skill
    let reloadError: string | undefined;
    if (clawhubResult.success) {
      try {
        await reloadGateway();
      } catch (err) {
        reloadError = err instanceof Error ? err.message : "Gateway reload failed";
        console.warn("[apps/install] Gateway reload failed after successful install:", reloadError);
      }
    }

    return NextResponse.json({
      ok: true,
      appId,
      iconSaved,
      iconPath: iconSaved ? `/setup-api/apps/icon/${appId}` : null,
      clawhub: clawhubResult,
      reloadError,
    });
  } catch (err) {
    console.error("[apps/install] Install failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Install failed" }, { status: 500 });
  }
}
