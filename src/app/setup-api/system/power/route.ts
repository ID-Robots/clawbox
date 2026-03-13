import { NextResponse } from "next/server";
import { execFile } from "child_process";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { action } = await req.json();

    if (action === "shutdown") {
      // Short delay so the response reaches the client
      setTimeout(() => {
        execFile("systemctl", ["poweroff"], { timeout: 10_000 });
      }, 1500);
      return NextResponse.json({ ok: true, action: "shutdown" });
    }

    if (action === "restart") {
      setTimeout(() => {
        execFile("systemctl", ["reboot"], { timeout: 10_000 });
      }, 1500);
      return NextResponse.json({ ok: true, action: "restart" });
    }

    return NextResponse.json({ error: "Invalid action. Use 'shutdown' or 'restart'." }, { status: 400 });
  } catch {
    return NextResponse.json({ error: "Failed to execute power action" }, { status: 500 });
  }
}
