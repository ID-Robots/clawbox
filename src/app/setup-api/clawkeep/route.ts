import { NextRequest, NextResponse } from "next/server";
import {
  configureClawKeepTargets,
  getClawKeepStatus,
  initClawKeep,
  snapClawKeep,
  syncClawKeep,
} from "@/lib/clawkeep";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const sourcePath = req.nextUrl.searchParams.get("sourcePath")?.trim() ?? "";
  if (!sourcePath) {
    return NextResponse.json({ error: "sourcePath is required" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    return NextResponse.json(await getClawKeepStatus(sourcePath), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load ClawKeep status" },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";
  const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : "";
  if (!sourcePath) {
    return NextResponse.json({ error: "sourcePath is required" }, { status: 400 });
  }

  try {
    switch (action) {
      case "init":
        return NextResponse.json(await initClawKeep(sourcePath));
      case "configure": {
        if (typeof body.password === "string" && body.password.trim().length > 0 && body.password.trim().length < 8) {
          return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
        }
        const localPath = typeof body.localPath === "string"
          ? body.localPath
          : (typeof body.targetPath === "string" ? body.targetPath : "");
        const cloudEnabled = !!body.cloudEnabled;
        if (!localPath.trim() && !cloudEnabled) {
          return NextResponse.json({ error: "Choose a local folder, cloud backup, or both" }, { status: 400 });
        }
        return NextResponse.json(
          await configureClawKeepTargets(sourcePath, {
            localPath,
            cloudEnabled,
            password: typeof body.password === "string" ? body.password : undefined,
          }),
        );
      }
      case "snap":
        return NextResponse.json(await snapClawKeep(sourcePath, typeof body.message === "string" ? body.message : undefined));
      case "sync":
        return NextResponse.json(await syncClawKeep(sourcePath));
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "ClawKeep action failed" },
      { status: 400 },
    );
  }
}
