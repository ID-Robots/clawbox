export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { WEBAPPS_DIR, APP_ID_RE } from "@/lib/code-projects";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * GET /setup-api/webapps?app=<appId>           — serve index.html
 * GET /setup-api/webapps?app=<appId>&file=x.js — serve asset file
 */
export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("app");
  if (!appId || !APP_ID_RE.test(appId)) {
    return NextResponse.json({ error: "Invalid app ID" }, { status: 400 });
  }

  const file = request.nextUrl.searchParams.get("file") || "index.html";

  // Prevent path traversal
  const appDir = path.join(WEBAPPS_DIR, appId);
  const filePath = path.resolve(appDir, file);
  if (!filePath.startsWith(appDir + path.sep) && filePath !== appDir) {
    return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
  }

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    return new NextResponse(content, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
      },
    });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
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
