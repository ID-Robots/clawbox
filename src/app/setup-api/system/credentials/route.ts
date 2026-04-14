import { NextResponse } from "next/server";
import { execFile as execFileCb, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import * as configStore from "@/lib/config-store";
import * as auth from "@/lib/auth";
import { checkRateLimit, clientIp, resetRateLimit } from "@/lib/rate-limit";
import { CLAWBOX_ROOT } from "@/lib/runtime-paths";

export const dynamic = "force-dynamic";

const PROJECT_ROOT = CLAWBOX_ROOT;
const execFile = promisify(execFileCb);
const CHPASSWD_INPUT_PATH = path.join(
  PROJECT_ROOT,
  "data",
  ".chpasswd-input"
);

const PASSWORD_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };
const PASSWORD_CONTROL_CHAR_RE = /[\r\n\x00-\x1f\x7f]/;
const SAFE_USERNAME_RE = /^[a-z_][a-z0-9_-]{0,31}\$?$/i;

function isSafePassword(password: string): boolean {
  if (typeof auth.isSafePasswordChars === "function") {
    return auth.isSafePasswordChars(password);
  }
  return !PASSWORD_CONTROL_CHAR_RE.test(password);
}

function isSafeSystemUsername(username: string | undefined): username is string {
  if (!username) return false;
  const trimmed = username.trim();
  return trimmed.length > 0 && !trimmed.includes(":") && SAFE_USERNAME_RE.test(trimmed);
}

function getConfiguredSystemUsername(): string {
  const candidates: Array<string | undefined> = [];
  if (typeof auth.getSystemUsername === "function") {
    try {
      candidates.push(auth.getSystemUsername());
    } catch {
      // Fall through to environment-based candidates below.
    }
  }
  candidates.push(process.env.CLAWBOX_USER, process.env.SUDO_USER, process.env.USER);

  for (const candidate of candidates) {
    if (isSafeSystemUsername(candidate)) {
      return candidate.trim();
    }
  }

  console.warn("[credentials] Invalid system username detected; falling back to 'clawbox'");
  return "clawbox";
}

async function readPasswordConfiguredFlag(): Promise<boolean> {
  return !!(await configStore.get("password_configured"));
}

async function verifyCurrentPassword(password: string): Promise<boolean> {
  if (auth.useLocalPasswordAuth()) {
    return auth.verifyLocalPassword(password);
  }
  return auth.verifyPassword(password);
}

async function applyX64SystemPassword(currentPassword: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const command = `/usr/sbin/chpasswd < '${CHPASSWD_INPUT_PATH}'`;
    const child = spawn(
      "/usr/bin/sudo",
      ["-k", "-S", "-p", "", "/bin/sh", "-c", command],
      {
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || "Failed to update system password"));
    });

    child.stdin.write(`${currentPassword}\n`);
    child.stdin.end();
  });
}

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
    if (!isSafePassword(password)) {
      return NextResponse.json({ error: "Password must not contain control characters or newlines" }, { status: 400 });
    }
    const isX64Install = process.env.CLAWBOX_INSTALL_MODE === "x64";
    const usesLocalPasswordAuth = auth.useLocalPasswordAuth();
    const requiresCurrentPassword = isX64Install && !usesLocalPasswordAuth;

    // After the initial setup, require the current password to make a change.
    // During first-boot setup (no password configured yet), CredentialsStep
    // calls this without `currentPassword` to set the initial value.
    const passwordAlreadyConfigured = await readPasswordConfiguredFlag();
    if (requiresCurrentPassword || passwordAlreadyConfigured) {
      if (!currentPassword) {
        return NextResponse.json({ error: "Current password is required" }, { status: 400 });
      }
      const ok = await verifyCurrentPassword(currentPassword);
      if (!ok) {
        return NextResponse.json({ error: "Current password is incorrect" }, { status: 401 });
      }
    }

    // Write password to a secure temp file, then delegate to the root
    // systemd service (clawbox-root-update@chpasswd) since the main
    // service runs as clawbox with NoNewPrivileges=true.
    if (usesLocalPasswordAuth) {
      await auth.setLocalPassword(password);
    } else {
      await fs.mkdir(path.dirname(CHPASSWD_INPUT_PATH), { recursive: true });
      await fs.writeFile(CHPASSWD_INPUT_PATH, `${getConfiguredSystemUsername()}:${password}\n`, {
        mode: 0o600,
      });
    }
    try {
      if (!usesLocalPasswordAuth) {
        if (requiresCurrentPassword) {
          await applyX64SystemPassword(currentPassword!);
        } else {
          const serviceName = "clawbox-root-update@chpasswd.service";
          await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "reset-failed", serviceName], {
            timeout: 10_000,
          }).catch(() => {});
          await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "start", serviceName], {
            timeout: 30_000,
          });
        }
      }
    } catch (err) {
      // Clean up the input file on failure
      if (!usesLocalPasswordAuth) {
        await fs.unlink(CHPASSWD_INPUT_PATH).catch(() => {});
      }
      throw err;
    }
    if (!usesLocalPasswordAuth) {
      await fs.unlink(CHPASSWD_INPUT_PATH).catch(() => {});
    }

    resetRateLimit("password", ip);

    await configStore.set("password_configured", true);
    await configStore.set("password_configured_at", new Date().toISOString());

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set password" },
      { status: 500 }
    );
  }
}
