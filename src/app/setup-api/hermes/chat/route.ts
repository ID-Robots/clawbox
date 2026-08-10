export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { spawn } from "child_process";
import path from "path";
import { StringDecoder } from "string_decoder";
import { HERMES_BIN } from "@/lib/harness";
import { runHermesCli } from "@/lib/hermes-cli";
import {
  HERMES_AUTO_PROVIDER,
  isHermesCliProvider,
  isPlausibleHermesProviderId,
  isSafeHermesModelId,
} from "@/lib/hermes-providers";
import { isHermesReasoningLevel } from "@/lib/hermes-reasoning";
import {
  getModelOptions,
  isAllowedProvider,
  isPairAllowed,
  shouldEnforcePairing,
  type ModelOptionsPayload,
} from "@/lib/hermes-model-options";

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
    // Decode ACROSS chunk boundaries. `chunk.toString()` per chunk turns any
    // multi-byte sequence straddling a pipe boundary into U+FFFD — and this
    // product ships a Bulgarian UI, so Cyrillic (and emoji) replies are the
    // normal case, not an edge case. Byte caps still count raw `chunk.length`.
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");

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
      out += outDecoder.write(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (settled) return;
      errBytes += chunk.length;
      // A failing hermes can spew unbounded stderr. Once it clears the cap the
      // run is already a loss — kill the child (don't let it keep burning CPU
      // until the timeout) and reject with what we captured. Mirrors stdout.
      if (errBytes > MAX_OUTPUT_BYTES) {
        cleanup();
        child.kill("SIGKILL");
        reject(new Error(err.trim() || "Hermes error output exceeded the size limit"));
        return;
      }
      err += errDecoder.write(chunk);
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
      // A missing binary surfaces as ENOENT with the full spawn path in the
      // message (`spawn /home/clawbox/.local/bin/hermes ENOENT`). Don't leak
      // that path to the client — report the actionable cause instead.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("Hermes is not installed on this device"));
        return;
      }
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      cleanup();
      // Flush whatever partial sequence the decoders are still holding.
      out += outDecoder.end();
      err += errDecoder.end();
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `hermes exited with code ${code}`));
    });
  });
}

// Hermes session ids are timestamped slugs: 20260810_194609_7568b9. Strict on
// purpose — this value reaches argv, and anything looser could smuggle a flag.
const SESSION_ID_RE = /^[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$/;

/**
 * The id of the most recently touched session. `hermes sessions list` prints a
 * table whose last column is the id; there is no --json. Best-effort: a failure
 * only costs conversation continuity on the NEXT turn, never this reply, so it
 * must not throw into the response path.
 */
async function latestSessionId(): Promise<string> {
  try {
    const r = await runHermesCli(["sessions", "list", "--limit", "1"], {
      timeoutMs: 10_000,
      env: { COLUMNS: "200" },
    });
    if (r.code !== 0) return "";
    for (const line of r.stdout.split(/\r?\n/)) {
      const match = /([0-9]{8}_[0-9]{6}_[0-9a-f]{6})\s*$/.exec(line.trim());
      if (match) return match[1];
    }
  } catch {
    /* continuity is best-effort */
  }
  return "";
}

export async function POST(request: Request) {
  let body: {
    message?: string;
    model?: string;
    provider?: string;
    reasoning?: string;
    sessionId?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const rawModel = typeof body.model === "string" ? body.model.trim() : "";
  const rawProvider = typeof body.provider === "string" ? body.provider.trim() : "";
  const rawReasoning = typeof body.reasoning === "string" ? body.reasoning.trim() : "";
  const rawSessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (rawSessionId && !SESSION_ID_RE.test(rawSessionId)) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }

  // Every value below reaches argv. No shell is involved (spawn takes an array)
  // but a value starting with "-" would still be parsed by hermes as a flag, so
  // each one is either a membership test against a literal set or a strict
  // charset check that cannot match a leading "-". These come from fixed
  // dropdowns, so an unrecognised value is a bug or an attack — reject it
  // rather than silently running the turn with different settings.
  if (rawModel && !isSafeHermesModelId(rawModel)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }
  if (rawReasoning && !isHermesReasoningLevel(rawReasoning)) {
    return NextResponse.json({ error: "Invalid reasoning level" }, { status: 400 });
  }
  // "auto" is ClawBox's pseudo-provider for "let Hermes decide", not a slug the
  // CLI knows — it maps to omitting the flag entirely, which is exactly what
  // hermes does without an override.
  const wantsProvider = Boolean(rawProvider) && rawProvider !== HERMES_AUTO_PROVIDER;
  if (wantsProvider && !isPlausibleHermesProviderId(rawProvider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  // The catalogue is process-cached (60 s fresh / 6 h stale-serve) and the chat
  // header warms it on mount, so in steady state this costs nothing. It is only
  // consulted for the checks a static list cannot make; when it is unavailable
  // we fall back to the static allowlist and let hermes itself judge the
  // pairing — a chat turn must not become impossible because the dashboard
  // blinked.
  let payload: ModelOptionsPayload | null = null;
  if (wantsProvider || rawModel) {
    try {
      payload = await getModelOptions();
    } catch {
      payload = null;
    }
  }

  // Canonical slug OR a user-defined provider the live dashboard reports.
  if (wantsProvider) {
    const known = payload ? isAllowedProvider(payload, rawProvider) : isHermesCliProvider(rawProvider);
    if (!known) {
      return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
    }
  }

  if (payload) {
    // The provider this turn will ACTUALLY run on: the override when one is
    // given, otherwise config.yaml's model.provider — because that is exactly
    // what hermes falls back to. `current` comes from `hermes config get`, so
    // it is accurate even when the model lists themselves are stale.
    const effectiveProvider = wantsProvider ? rawProvider : payload.current.provider;

    // Same pairing gate the config POST enforces: a provider must never run a
    // foreign vendor's model id. shouldEnforcePairing decides when we actually
    // know enough to judge — it skips a stale payload (a fallback manifest, not
    // the provider's truth) and a CREDENTIALED provider we couldn't enumerate,
    // but still enforces on an UNAUTHENTICATED one (which serves nothing, so
    // any model paired with it is wrong).
    if (
      rawModel
      && effectiveProvider
      && shouldEnforcePairing(payload, effectiveProvider)
      && !isPairAllowed(payload, effectiveProvider, rawModel)
    ) {
      return NextResponse.json(
        { error: `Model "${rawModel}" is not available from provider "${effectiveProvider}"` },
        { status: 400 },
      );
    }

    // --provider WITHOUT -m makes hermes fall back to config.yaml's
    // model.default, which belongs to the CONFIGURED provider. Overriding one
    // half of the pair would run provider A against provider B's model id (on
    // this device: clawai's bare `deepseek-v4-pro` against anthropic).
    if (
      wantsProvider
      && !rawModel
      && payload.current.provider
      && payload.current.provider !== rawProvider
    ) {
      return NextResponse.json(
        { error: `No model is available for provider "${rawProvider}"` },
        { status: 409 },
      );
    }
  }

  // A message starting with "-" gets a leading space so hermes reads it as the
  // prompt value (the UI shows ClawBox's own copy of the message, not this one).
  const safeMessage = message.startsWith("-") ? ` ${message}` : message;
  const args = ["-z", safeMessage];
  // No model → omit -m and let hermes use config.yaml's model.default, which is
  // by definition valid for the configured provider. (The previous hardcoded
  // `openai/gpt-4o-mini` fallback was actively wrong on a ClawBox AI device:
  // model.provider=clawai only accepts BARE deepseek ids and answers a
  // vendor-prefixed one with HTTP 400 "Model not allowed".)
  if (rawModel) args.push("-m", rawModel);
  if (wantsProvider) args.push("--provider", rawProvider);
  if (rawReasoning) args.push("--reasoning", rawReasoning);
  // Continue the SAME conversation. Without this every turn is a fresh `-z`
  // run with its own session, so the agent has no idea what "it" refers to in
  // a follow-up — asking "is it removed now?" got "what are we trying to
  // remove?". We resume by explicit ID, never `--continue <name>`: that flag
  // ignores the name and silently resumes the most recent session in the
  // workspace, which would splice unrelated chats (and the agent's own cron
  // runs) into each other.
  if (rawSessionId) args.push("--resume", rawSessionId);

  try {
    const text = await runHermes(args, request.signal);
    // Report the session this turn belongs to so the next one can resume it.
    // Re-read every turn rather than only on the first: whether `--resume`
    // continues in place or forks a new row is Hermes' business, and this way
    // the client always carries the id that actually holds the history.
    const sessionId = (await latestSessionId()) || rawSessionId || undefined;
    return NextResponse.json({ text, harness: "hermes", ...(sessionId ? { sessionId } : {}) });
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
