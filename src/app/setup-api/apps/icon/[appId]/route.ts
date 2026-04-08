import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";

export const dynamic = "force-dynamic";

const ICONS_DIR = path.join(DATA_DIR, "icons");
const STORE_ICONS_BASE = "https://openclawhardware.dev/store/icons";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId } = await params;
  // Whitelist appId to prevent path traversal (e.g. "../../etc/passwd").
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(appId)) {
    return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
  }
  const iconPath = path.join(ICONS_DIR, `${appId}.png`);

  // Try local cached icon first
  try {
    const data = await fs.readFile(iconPath);
    return new NextResponse(data, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch {
    // Not cached locally
  }

  // Proxy from remote store and cache
  try {
    const res = await fetch(`${STORE_ICONS_BASE}/${appId}.png`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const buffer = Buffer.from(await res.arrayBuffer());

      // Cache locally (fire and forget)
      fs.mkdir(ICONS_DIR, { recursive: true })
        .then(() => fs.writeFile(iconPath, buffer))
        .catch(() => {});

      return new NextResponse(buffer, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400",
        },
      });
    }
  } catch {
    // Remote failed
  }

  return NextResponse.json({ error: "Icon not found" }, { status: 404 });
}
