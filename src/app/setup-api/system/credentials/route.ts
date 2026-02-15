import { NextResponse } from "next/server";
import { spawn } from "child_process";
import { set } from "@/lib/config-store";

const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 5;

const attempts = new Map<string, { count: number; firstAttempt: number }>();

function getClientIP(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = attempts.get(ip);
  if (!record || now - record.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }
  record.count++;
  return record.count <= RATE_LIMIT_MAX_ATTEMPTS;
}

function resetRateLimit(ip: string): void {
  attempts.delete(ip);
}

export async function POST(request: Request) {
  const clientIP = getClientIP(request);

  if (!checkRateLimit(clientIP)) {
    return NextResponse.json(
      { error: "Too many attempts. Please try again later." },
      { status: 429 }
    );
  }

  try {
    let body: { password?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON" },
        { status: 400 }
      );
    }

    const { password } = body;
    if (!password) {
      return NextResponse.json(
        { error: "Password is required" },
        { status: 400 }
      );
    }
    if (password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 }
      );
    }

    // Reject passwords with newlines or control characters to prevent injection
    if (/[\r\n\x00-\x1f\x7f]/.test(password)) {
      return NextResponse.json(
        { error: "Password must not contain control characters or newlines" },
        { status: 400 }
      );
    }

    // Use chpasswd via stdin to safely set password without shell injection
    await new Promise<void>((resolve, reject) => {
      const child = spawn("chpasswd", [], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim() || `chpasswd exited with code ${code}`));
      });
      child.stdin.write(`clawbox:${password}\n`);
      child.stdin.end();
    });

    resetRateLimit(clientIP);

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
