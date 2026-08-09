import { NextResponse } from "next/server";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import { get, set } from "@/lib/config-store";
import { CHPASSWD_INPUT_PATH, CHPASSWD_SERVICE_NAME, chpasswdRecord } from "@/lib/chpasswd";
import { getSystemUsername, verifyPassword, isSafePasswordChars, bumpSessionGeneration, createSessionCookie, getSessionSigningSecret } from "@/lib/auth";
import { checkRateLimit, clientIp, resetRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

const execFile = promisify(execFileCb);

const PASSWORD_RATE_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };

// Cookies are marked Secure only over HTTPS (tunnel); plain-HTTP LAN must stay
// non-Secure or the browser would never send the cookie back.
function requestIsHttps(req: Request): boolean {
  const xfp = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (xfp) return xfp === "https";
  try {
    return new URL(req.url).protocol === "https:";
  } catch {
    return false;
  }
}

// Remaining lifetime (seconds) of the caller's current session cookie, so a
// re-issued cookie preserves roughly the chosen duration. Best effort — the
// cookie was already validated by middleware to reach this route. Returns null
// (→ caller falls back to a fresh 24h) when the cookie is absent, unparseable,
// or nearly expired; the caller just re-proved the current password, so a fresh
// window is acceptable there.
function remainingSessionSeconds(req: Request): number | null {
  const m = /(?:^|;\s*)clawbox_session=([^;]+)/.exec(req.headers.get("cookie") || "");
  if (!m) return null;
  try {
    const payload = decodeURIComponent(m[1]).split(".")[0];
    const data = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof data.exp !== "number") return null;
    const remaining = data.exp - Math.floor(Date.now() / 1000);
    return remaining > 60 ? Math.min(remaining, 86400) : null;
  } catch {
    return null;
  }
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
    await fs.writeFile(CHPASSWD_INPUT_PATH, chpasswdRecord(getSystemUsername(), password), {
      mode: 0o600,
    });
    try {
      await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "reset-failed", CHPASSWD_SERVICE_NAME], {
        timeout: 10_000,
      }).catch(() => {});
      await execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "start", CHPASSWD_SERVICE_NAME], {
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

    // On an actual password change, revoke every session minted under the old
    // password (bump the generation) — but re-issue the caller's OWN session at
    // the new generation so a routine change doesn't force-log-out the admin
    // mid-flow. First-boot setup (no prior password) has no live session, so it
    // neither bumps nor re-issues.
    if (passwordAlreadyConfigured) {
      const gen = await bumpSessionGeneration();
      // Re-issue is best-effort: the password change already succeeded, so a
      // failure to mint the replacement cookie must NOT turn into a 500 (that
      // would log the admin out — the exact outcome we're trying to avoid).
      // Worst case they just see the login screen, like setup/complete.
      try {
        const secret = await getSessionSigningSecret();
        const duration = remainingSessionSeconds(request) ?? 86400;
        const res = NextResponse.json({ success: true, reauthenticated: true });
        res.cookies.set("clawbox_session", createSessionCookie(duration, secret, gen), {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          maxAge: duration,
          secure: requestIsHttps(request),
        });
        return res;
      } catch {
        return NextResponse.json({ success: true });
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to set password" },
      { status: 500 }
    );
  }
}
