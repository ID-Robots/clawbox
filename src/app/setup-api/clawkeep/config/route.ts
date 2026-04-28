import { NextRequest, NextResponse } from "next/server";

import { ClawKeepError, readConfigToml, writeConfigToml } from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

const MAX_TOML_BYTES = 64 * 1024; // arbitrary sanity ceiling — config.toml is normally < 2 KB

export async function GET() {
  try {
    const toml = await readConfigToml();
    return new NextResponse(toml, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read config" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.text();
    if (body.length === 0) {
      return NextResponse.json(
        { error: "empty body" },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    if (body.length > MAX_TOML_BYTES) {
      return NextResponse.json(
        { error: "config too large" },
        { status: 413, headers: { "Cache-Control": "no-store" } },
      );
    }
    await writeConfigToml(body);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const status = err instanceof ClawKeepError ? err.status : 500;
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to write config" },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
