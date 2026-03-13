import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);
const ICONS_DIR = path.join(DATA_DIR, "icons");
const STORE_ICONS_BASE = "https://openclawhardware.dev/store/icons";

export async function POST(req: Request) {
  try {
    const { appId } = await req.json();
    if (!appId || typeof appId !== "string") {
      return NextResponse.json({ error: "appId is required" }, { status: 400 });
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

    // Run clawhub install
    let clawhubResult: { success: boolean; output?: string; error?: string } = { success: false };
    try {
      const { stdout, stderr } = await execFileAsync("clawhub", ["install", appId], {
        timeout: 30_000,
      });
      clawhubResult = { success: true, output: stdout || stderr };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[apps/install] clawhub install ${appId} failed:`, msg);
      clawhubResult = { success: false, error: msg };
    }

    return NextResponse.json({
      ok: true,
      appId,
      iconSaved,
      iconPath: iconSaved ? `/setup-api/apps/icon/${appId}` : null,
      clawhub: clawhubResult,
    });
  } catch {
    return NextResponse.json({ error: "Install failed" }, { status: 500 });
  }
}
