import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

const POWER_ACTIONS: Record<string, string> = {
  shutdown: "poweroff",
  restart: "reboot",
};

export async function POST(req: Request) {
  let action: unknown;
  try {
    ({ action } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const systemctlAction = typeof action === "string" ? POWER_ACTIONS[action] : undefined;
  if (!systemctlAction) {
    return NextResponse.json(
      { error: "Invalid action. Use 'shutdown' or 'restart'." },
      { status: 400 },
    );
  }

  try {
    // Dispatch the power command and wait for systemd to accept it BEFORE
    // responding. `systemctl poweroff|reboot` enqueues the job and returns 0
    // promptly (the actual teardown happens a moment later as units stop), so
    // awaiting here lets us surface a genuine dispatch failure — missing sudo,
    // denied privilege, systemctl not found — as a real 500 instead of the old
    // fire-and-forget path that always reported success. The response still
    // flushes to the client because the enqueue returns well before the web
    // server's own unit is torn down.
    await execFileAsync(
      "/usr/bin/sudo",
      ["/usr/bin/systemctl", systemctlAction],
      { timeout: 10_000 },
    );
    return NextResponse.json({ ok: true, action });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to execute power action" },
      { status: 500 },
    );
  }
}
