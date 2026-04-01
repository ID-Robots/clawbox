export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";

const WEBAPPS_DIR = path.join(
  process.env.CLAWBOX_ROOT || "/home/clawbox/clawbox",
  "data",
  "webapps"
);

const APP_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** GET /setup-api/webapps?app=<appId> — serve the webapp HTML */
export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("app");
  if (!appId || !APP_ID_RE.test(appId)) {
    return NextResponse.json({ error: "Invalid app ID" }, { status: 400 });
  }

  const htmlPath = path.join(WEBAPPS_DIR, appId, "index.html");
  try {
    const html = await fs.readFile(htmlPath, "utf-8");
    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json({ error: "App not found" }, { status: 404 });
  }
}

/** POST /setup-api/webapps — create/update a webapp */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appId, html, name, color, icon } = body;

    if (!appId || !APP_ID_RE.test(appId)) {
      return NextResponse.json({ error: "Invalid app ID" }, { status: 400 });
    }
    if (!html || typeof html !== "string") {
      return NextResponse.json({ error: "HTML content required" }, { status: 400 });
    }
    if (Buffer.byteLength(html, "utf-8") > 1_048_576) {
      return NextResponse.json({ error: "HTML content too large (max 1MB)" }, { status: 413 });
    }

    const appDir = path.join(WEBAPPS_DIR, appId);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(path.join(appDir, "index.html"), html, "utf-8");

    // Save metadata
    await fs.writeFile(
      path.join(appDir, "meta.json"),
      JSON.stringify({ name: name || appId, color: color || "#f97316", icon: icon || "" }),
      "utf-8"
    );

    return NextResponse.json({
      success: true,
      url: `/setup-api/webapps?app=${appId}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create webapp" },
      { status: 500 }
    );
  }
}
