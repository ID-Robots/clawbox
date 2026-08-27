export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { hermesFailureMessage } from "@/lib/hermes-cli-message";
import { invalidateModelOptions } from "@/lib/hermes-model-options";

// Store an API key for a Hermes inference provider via `hermes auth add`. Hermes
// keeps the credential in its own pooled-auth store (~/.hermes), NOT ClawBox's
// config — this route is just a thin, validated bridge so the AI-provider panel
// can set a key without opening the Hermes dashboard.
//
// Only api-key providers are accepted here; OAuth providers (nous, openai-codex,
// copilot) authenticate through a browser flow, not a pasted key.
// NB: no "nous-api" — it is not a Hermes provider slug (verified on-device:
// absent from both CANONICAL_PROVIDERS and PROVIDER_REGISTRY, and
// normalize_provider doesn't alias it). Accepting it here would store a
// credential under a provider Hermes never reads. Nous is `nous`, and it
// authenticates by OAuth, not a pasted key.
const API_KEY_PROVIDERS = new Set([
  "openrouter", "anthropic", "gemini", "zai", "kimi-coding",
]);

// Printable ASCII, no whitespace/control chars, reasonable length. Passed as an
// argv element (no shell), but reject a leading "-" so hermes can't read the key
// as a flag.
const API_KEY_RE = /^[!-~]{8,512}$/;

/**
 * Take the pasted key out of any text on its way to a person or a log.
 *
 * The key is validated to printable non-space ASCII, so a plain substring swap
 * is exact — there is no encoding of it in the CLI's output that this would
 * miss and no regex escaping to get wrong.
 */
function redactKey(text: string, apiKey: string): string {
  return apiKey ? text.split(apiKey).join("<redacted>") : text;
}

export async function POST(request: Request) {
  let body: { provider?: string; apiKey?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

  if (!API_KEY_PROVIDERS.has(provider)) {
    return NextResponse.json({ error: "Provider does not accept an API key here" }, { status: 400 });
  }
  if (!apiKey || !API_KEY_RE.test(apiKey) || apiKey.startsWith("-")) {
    return NextResponse.json({ error: "Invalid API key" }, { status: 400 });
  }

  try {
    const r = await runHermesCli(
      ["auth", "add", provider, "--type", "api-key", "--api-key", apiKey],
      { timeoutMs: 20_000 },
    );
    if (r.code !== 0) {
      // Two separate things must not reach the save banner, and only one of
      // them was being thought about here.
      //
      // 1. The KEY. The old comment asserted hermes "may name the provider but
      //    not the secret" — true of a clean refusal, false of an argparse
      //    usage error, which prints the offending argv and the key is IN the
      //    argv. So it is redacted rather than assumed absent.
      // 2. The CRASH. `hermes auth add` is the first thing a customer runs when
      //    adding a provider, and a traceback here rendered verbatim: CPython
      //    frames naming /home/clawbox/.hermes, straight into Settings. That is
      //    the input PR #515 cleaned out of the chat bubble; the same parser
      //    cleans it here.
      console.error("[hermes provider-key] auth add exit", r.code, redactKey(r.stderr, apiKey));
      const reported = hermesFailureMessage(redactKey(r.stdout, apiKey), redactKey(r.stderr, apiKey));
      return NextResponse.json({ error: reported || "Failed to save API key" }, { status: 502 });
    }
  } catch (err) {
    // `runHermesCli` rejects only on a spawn failure, and it has already turned
    // that into path-free text (src/lib/hermes-cli-message.ts).
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "hermes auth add failed" },
      { status: 502 },
    );
  }

  // A new credential flips this provider's `authenticated` flag and unlocks its
  // model list, so the cached catalogue is now wrong — the panel's very next
  // request must see the provider as usable rather than wait out FRESH_MS.
  invalidateModelOptions();

  return NextResponse.json({ ok: true, provider });
}
