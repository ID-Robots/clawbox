export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { isPortOpen } from "@/lib/port-probe";

const execFileAsync = promisify(execFile);

const VNC_PORT = Number(process.env.VNC_PORT || 5900);
const WS_PORT = Number(process.env.VNC_WS_PORT || 6080);

export async function GET() {
  try {
    // Check if VNC server is running
    const vncUp = await isPortOpen(VNC_PORT);
    const wsUp = await isPortOpen(WS_PORT);

    if (!vncUp) {
      // Try to detect VNC server on display :1 (port 5901)
      const vnc1Up = await isPortOpen(5901);
      if (vnc1Up) {
        return NextResponse.json({
          available: wsUp,
          vncPort: 5901,
          wsPort: WS_PORT,
          error: wsUp ? undefined : "VNC server found on :1 (port 5901) but WebSocket proxy (websockify) is not running on port 6080. Run: websockify 6080 localhost:5901",
        });
      }

      return NextResponse.json({
        available: false,
        error: "No VNC server detected on port 5900 or 5901. Install and start a VNC server first.",
      });
    }

    if (!wsUp) {
      // VNC is up but websockify is not — try to auto-start it
      try {
        await execFileAsync("which", ["websockify"]);
        // websockify is installed, start it in background
        const proc = spawn("websockify", [String(WS_PORT), `localhost:${VNC_PORT}`], {
          detached: true,
          stdio: "ignore",
        });
        proc.unref();

        // Wait a moment for it to start
        await new Promise((r) => setTimeout(r, 1000));
        const wsNowUp = await isPortOpen(WS_PORT);

        return NextResponse.json({
          available: wsNowUp,
          vncPort: VNC_PORT,
          wsPort: WS_PORT,
          error: wsNowUp ? undefined : "Failed to auto-start websockify",
        });
      } catch {
        return NextResponse.json({
          available: false,
          vncPort: VNC_PORT,
          wsPort: WS_PORT,
          error: `VNC server running on port ${VNC_PORT} but websockify not installed. Run: sudo apt install websockify && websockify ${WS_PORT} localhost:${VNC_PORT}`,
        });
      }
    }

    return NextResponse.json({
      available: true,
      vncPort: VNC_PORT,
      wsPort: WS_PORT,
    });
  } catch (err) {
    return NextResponse.json({
      available: false,
      error: err instanceof Error ? err.message : "Failed to check VNC status",
    }, { status: 500 });
  }
}
