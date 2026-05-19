export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";

// Bridges the host browser's clipboard with the guest X CLIPBOARD via
// `xclip`. Avoids the RFB ClientCutText Latin-1 limitation that mangles
// Cyrillic / CJK / emoji on the basic noVNC paste path, and works over
// plain HTTP (no `navigator.clipboard.readText()` permission required —
// the textarea in the paste modal captures the text natively).
const MAX_CLIPBOARD_BYTES = 1_048_576;
const XCLIP_TIMEOUT_MS = 5_000;

async function getVncDisplay(): Promise<string> {
  if (process.env.CLAWBOX_VNC_DISPLAY) return process.env.CLAWBOX_VNC_DISPLAY;
  try {
    const envFile = path.join(os.homedir(), ".cache", "clawbox", "vnc-display.env");
    const raw = await fs.readFile(envFile, "utf8");
    const match = raw.match(/CLAWBOX_VNC_DISPLAY=(:\d+)/);
    if (match) return match[1];
  } catch {
    // No marker yet — fall through to the default x11vnc display.
  }
  return ":99";
}

interface XclipResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runXclip(args: string[], display: string, input?: string): Promise<XclipResult> {
  return new Promise((resolve, reject) => {
    const isWrite = input !== undefined;
    // For writes, xclip forks a daemon that keeps owning the X selection
    // until another client claims it — if Node inherits its stdout/stderr,
    // the `close` event never fires (the daemon holds those pipes open).
    // Detach those streams so we observe only the parent's exit.
    const proc = spawn("xclip", args, {
      env: { ...process.env, DISPLAY: display },
      stdio: isWrite ? ["pipe", "ignore", "ignore"] : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: XclipResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      proc.kill("SIGTERM");
      settle({ stdout, stderr: `${stderr}\n[xclip] timed out`, code: -1 });
    }, XCLIP_TIMEOUT_MS);
    if (proc.stdout) {
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    }
    if (proc.stderr) {
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf8"); });
    }
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      settle({ stdout, stderr, code: code ?? -1 });
    });
    if (isWrite && proc.stdin) {
      proc.stdin.end(input, "utf8");
    }
  });
}

export async function GET() {
  try {
    const display = await getVncDisplay();
    const { stdout, code, stderr } = await runXclip(
      ["-selection", "clipboard", "-out"],
      display,
    );
    if (code !== 0) {
      // xclip returns non-zero when the selection is empty; treat that as
      // an empty string rather than an error so the UI can render "(empty)".
      const isEmpty = stderr.includes("There is no owner");
      if (isEmpty) {
        return NextResponse.json({ text: "" }, { headers: { "Cache-Control": "no-store" } });
      }
      return NextResponse.json(
        { error: `xclip exit ${code}: ${stderr.slice(0, 200)}` },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
    return NextResponse.json({ text: stdout }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "xclip read failed" },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return NextResponse.json({ error: "request body must be JSON" }, { status: 400 });
  }
  const body = (parsed ?? {}) as { text?: unknown };
  const text = typeof body.text === "string" ? body.text : "";
  if (text.length === 0) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  if (Buffer.byteLength(text, "utf8") > MAX_CLIPBOARD_BYTES) {
    return NextResponse.json({ error: "text exceeds 1 MiB cap" }, { status: 413 });
  }

  try {
    const display = await getVncDisplay();
    const { code, stderr } = await runXclip(
      ["-selection", "clipboard", "-in"],
      display,
      text,
    );
    if (code !== 0) {
      return NextResponse.json(
        { error: `xclip exit ${code}: ${stderr.slice(0, 200)}` },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "xclip write failed" },
      { status: 500 },
    );
  }
}
