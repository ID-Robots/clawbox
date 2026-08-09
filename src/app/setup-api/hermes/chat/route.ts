export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { HERMES_BIN } from "@/lib/harness";

// Chat turn against the Hermes harness. Uses `hermes -z <message>` (one-shot),
// which — verified on-device — reuses Hermes' persistent default session, so
// multi-turn memory works without ClawBox threading context. The message is
// passed as an argv element (no shell), so user input can't inject a command.
//
// This is the desktop chat backend when the active harness is Hermes; OpenClaw
// keeps its gateway WebSocket. Streaming + per-chat sessions are a future
// upgrade (the Hermes serve WS supports them).

const HOME_DIR = process.env.HOME || "/home/clawbox";
const HERMES_TIMEOUT_MS = 90_000;
// A chat reply can't legitimately exceed this; cap the buffer so a runaway
// process can't grow it unbounded.
const MAX_OUTPUT_BYTES = 2_000_000;
// Hermes uses `vendor/model` IDs (routed via its base_url, default OpenRouter).
// ClawBox's chat model picker is OpenClaw-specific, so when the desktop chat
// doesn't send a Hermes model we fall back to a known-good default rather than
// Hermes' config default (which may not resolve on the configured provider).
const DEFAULT_MODEL = process.env.HERMES_DEFAULT_MODEL || "openai/gpt-4o-mini";

function runHermes(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    let settled = false;
    const child = spawn(HERMES_BIN, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: HOME_DIR,
      env: {
        ...process.env,
        HOME: HOME_DIR,
        PATH: `${path.dirname(HERMES_BIN)}:${process.env.PATH || ""}`,
      },
    });
    let out = "";
    let err = "";
    let outBytes = 0;
    let errBytes = 0;

    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    // The user hit Stop (or the request was aborted) — kill the process so the
    // model doesn't keep running for a reply nobody will read.
    const onAbort = () => {
      if (settled) return;
      cleanup();
      child.kill("SIGKILL");
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outBytes += chunk.length;
      if (outBytes > MAX_OUTPUT_BYTES) {
        cleanup();
        child.kill("SIGKILL");
        reject(new Error("Hermes output exceeded the size limit"));
        return;
      }
      out += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Same cap as stdout — stderr only feeds the error message, so once we
      // have enough for that, stop growing the buffer.
      if (errBytes >= MAX_OUTPUT_BYTES) return;
      errBytes += chunk.length;
      err += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      cleanup();
      child.kill("SIGKILL");
      reject(new Error("Hermes timed out"));
    }, HERMES_TIMEOUT_MS);

    child.on("error", (e) => {
      if (settled) return;
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      cleanup();
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `hermes exited with code ${code}`));
    });
  });
}

export async function POST(request: Request) {
  let body: { message?: string; model?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  // argv flag-smuggling guard (no shell is involved — spawn uses an arg array —
  // but a value starting with "-" could still be parsed by hermes as a flag,
  // e.g. `--version`). Model must match a strict charset and not start with "-";
  // a message starting with "-" gets a leading space so hermes reads it as the
  // prompt value (the UI shows ClawBox's own copy of the message, not this one).
  const rawModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_MODEL;
  const model = /^[A-Za-z0-9_./:-]+$/.test(rawModel) && !rawModel.startsWith("-") ? rawModel : DEFAULT_MODEL;
  const safeMessage = message.startsWith("-") ? ` ${message}` : message;
  const args = ["-z", safeMessage, "-m", model];

  try {
    const text = await runHermes(args, request.signal);
    return NextResponse.json({ text, harness: "hermes" });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // Client hit Stop / disconnected; the child was already killed.
      return new NextResponse(null, { status: 499 });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes chat failed" },
      { status: 502 },
    );
  }
}
