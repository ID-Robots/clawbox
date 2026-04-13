import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const dynamic = "force-dynamic";

let cache: { online: boolean; checkedAt: number; latencyMs: number | null } | null = null;
const TTL_MS = 5_000;

async function check(): Promise<{ online: boolean; latencyMs: number | null }> {
  try {
    const t0 = Date.now();
    await execFileAsync("ping", ["-c", "1", "-W", "2", "-n", "1.1.1.1"], { timeout: 3000 });
    return { online: true, latencyMs: Date.now() - t0 };
  } catch {
    return { online: false, latencyMs: null };
  }
}

export async function GET() {
  const now = Date.now();
  if (!cache || now - cache.checkedAt > TTL_MS) {
    const result = await check();
    cache = { ...result, checkedAt: now };
  }
  return NextResponse.json({ online: cache.online, latencyMs: cache.latencyMs, checkedAt: cache.checkedAt });
}
