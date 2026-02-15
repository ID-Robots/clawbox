import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { get, set } from "@/lib/config-store";

export const dynamic = "force-dynamic";

const HOTSPOT_ENV_PATH = path.join(
  process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox",
  "data",
  "hotspot.env"
);

export async function GET() {
  const ssid = ((await get("hotspot_ssid")) as string) || "ClawBox-Setup";
  const hasPassword = !!(await get("hotspot_password"));
  return NextResponse.json({ ssid, hasPassword });
}

export async function POST(request: Request) {
  try {
    let body: { ssid?: string; password?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { ssid, password } = body;

    if (!ssid || !ssid.trim()) {
      return NextResponse.json(
        { error: "Hotspot name is required" },
        { status: 400 }
      );
    }

    if (ssid.length > 32) {
      return NextResponse.json(
        { error: "Hotspot name must be 32 characters or less" },
        { status: 400 }
      );
    }

    if (password && password.length < 8) {
      return NextResponse.json(
        { error: "Hotspot password must be at least 8 characters" },
        { status: 400 }
      );
    }

    if (password && password.length > 63) {
      return NextResponse.json(
        { error: "Hotspot password must be 63 characters or less" },
        { status: 400 }
      );
    }

    await set("hotspot_ssid", ssid.trim());
    await set("hotspot_password", password || undefined);

    // Write shell-sourceable env file for start-ap.sh
    const envLines = [`HOTSPOT_SSID=${shellQuote(ssid.trim())}`];
    if (password) {
      envLines.push(`HOTSPOT_PASSWORD=${shellQuote(password)}`);
    }
    await fs.mkdir(path.dirname(HOTSPOT_ENV_PATH), { recursive: true });
    await fs.writeFile(HOTSPOT_ENV_PATH, envLines.join("\n") + "\n", {
      mode: 0o600,
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Failed to save hotspot settings",
      },
      { status: 500 }
    );
  }
}

/** Safely quote a value for shell assignment */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
