import { NextResponse } from "next/server";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import { resetConfig } from "@/lib/config-store";

const execFile = promisify(execFileCb);

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    if (body.confirm !== true) {
      return NextResponse.json(
        { error: "Missing confirmation. Send { \"confirm\": true } to reset." },
        { status: 400 }
      );
    }

    await resetConfig();

    // Fire-and-forget: trigger factory reset via root service.
    // Uses --no-block because the service will stop/restart clawbox-setup,
    // killing this process before the service completes.
    const service = "clawbox-root-update@factory_reset.service";
    execFile("systemctl", ["reset-failed", service], { timeout: 10_000 })
      .catch(() => {});
    execFile("systemctl", ["start", "--no-block", service], { timeout: 10_000 })
      .catch(() => {});

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : "Failed to reset",
      },
      { status: 500 }
    );
  }
}
