import { NextResponse } from "next/server";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { get, set } from "@/lib/config-store";
import { getSystemUsername, verifyPassword, isSafePasswordChars } from "@/lib/auth";
import { checkRateLimit, clientIp, resetRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const PROJECT_ROOT = process.env.CLAWBOX_ROOT || process.env.CONFIG_ROOT || "/home/clawbox/clawbox";
const execFile = promisify(execFileCb);
const CHPASSWD_INPUT_PATH = path.join(
  PROJECT_ROOT,
  "data",
  ".chpasswd-input"
);

const PASSWORD_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };

export async function POST(request: Request) {
  const ip = clientIp(request);

  if (!checkRateLimit("password", ip, PASSWORD_RATE_LIMIT)) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    let body: { password?: string; currentPassword?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
    }

    const { password, currentPassword } = body;
    if (!password) {
      return NextResponse.json({ error: "Password is required" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
    }
    if (!isSafePasswordChars(password)) {
      return NextResponse.json({ error: "Password must not contain control characters or newlines" }, { status: 400 });
    }

    // After the initial setup, require the current password to make a change.
    // During first-boot setup (no password configured yet), CredentialsStep
    // calls this without `currentPassword` to set the initial value.
    const passwordAlreadyConfigured = !!(await get("password_configured"));
    if (passwordAlreadyConfigured) {
      if (!currentPassword) {
        return NextResponse.json({ error: "Current password is required" }, { status: 400 });
      }
      const ok = await verifyPassword(currentPassword);
      if (!ok) {
        return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
      }
    }

    // Write password to a secure temp file, then delegate to the root
    // systemd service (clawbox-root-update@chpasswd) since the main
    // service runs as clawbox with NoNewPrivileges=true.
    await fs.mkdir(path.dirname(CHPASSWD_INPUT_PATH), { recursive: true });
    await fs.writeFile(CHPASSWD_INPUT_PATH, `${getSystemUsername()}:${password}\n`, {
      mode: 0o600,
    });
    try {
      const serviceName = "clawbox-root-update@chpasswd.service";
      await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "reset-failed", serviceName], {
        timeout: 10_000,
      }).catch(() => {});
      await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "start", serviceName], {
        timeout: 30_000,
      });
    } catch (err) {
      // Clean up the input file on failure
      await fs.unlink(CHPASSWD_INPUT_PATH).catch(() => {});
      throw err;
    }

    resetRateLimit("password", ip);

    await set("password_configured", true);
    await set("password_configured_at", new Date().toISOString());

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set password" },
      { status: 500 }
    );
  }
}
