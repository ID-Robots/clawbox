import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "@/lib/config-store";

export const dynamic = "force-dynamic";

const ICONS_DIR = path.join(DATA_DIR, "icons");
const STORE_ICONS_BASE = "https://clawbox.com/store/icons";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ appId: string }> }
) {
  const { appId } = await params;
  // Whitelist appId to prevent path traversal (e.g. "../../etc/passwd").
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(appId)) {
    return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
  }
  const iconPath = path.join(ICONS_DIR, `${appId}.png`);

  // Try local cached icon first. Served with `no-cache` plus an ETag rather
  // than `immutable`: the file under an id can CHANGE now — a web app's
  // generated icon (src/lib/webapp-icon.ts) is removed with the app, and a
  // different app can take the same id and get a different picture. Under
  // `immutable` a browser that had seen the first icon would show it for a
  // year without asking. `no-cache` costs one conditional request per icon
  // per desktop load, answered 304 from a stat when nothing changed.
  try {
    const stat = await fs.stat(iconPath);
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
    const cacheHeaders = { ETag: etag, "Cache-Control": "public, no-cache" };
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: cacheHeaders });
    }
    const data = await fs.readFile(iconPath);
    return new NextResponse(data, {
      headers: { "Content-Type": "image/png", ...cacheHeaders },
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
