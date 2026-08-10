export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
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
      // Never echo the key back in an error. hermes stderr may name the
      // provider but not the secret.
      return NextResponse.json({ error: r.stderr || "Failed to save API key" }, { status: 502 });
    }
  } catch (err) {
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
