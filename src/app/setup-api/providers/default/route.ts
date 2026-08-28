export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getActiveHarness } from "@/lib/harness";
import { isPlausibleHermesProviderId } from "@/lib/hermes-providers";
import { isProviderEnabled } from "@/lib/provider-enablement";
import { POST as setHermesPairing } from "@/app/setup-api/hermes/models/route";
import {
  GET as readChatModelState,
  POST as setChatModel,
} from "@/app/setup-api/chat/model/route";

/**
 * "Make this provider the default."
 *
 * ONE endpoint for both harnesses, so the Settings UI can offer the affordance
 * without knowing which one it is running on. The edition question is answered
 * here, once, on the server — which is the only place that can answer it
 * without a round-trip anyway.
 *
 * WHY IT DELEGATES rather than writing config itself. Each harness already has
 * a route that does exactly this write, and each of those writes is more
 * delicate than it looks:
 *
 *   - Hermes must set `model.provider` and `model.default` as a PAIR, provider
 *     first, and roll the provider back if the model write fails — `hermes
 *     config set` cannot atomically clear `model.default`, so a half-write
 *     strands the box on provider A with provider B's model id.
 *   - OpenClaw must extend `models.providers.<p>.models` when the chosen id
 *     is not seeded, sweep the per-session model overrides with
 *     `source: "user"`, re-gate the provider plugins, and restart the gateway.
 *
 * Re-implementing either of those here would be a second copy that has to be
 * kept correct forever. Calling the handler is a plain async function call —
 * these are not privileged objects — and it means this route inherits every
 * validation and rollback the harness route already performs, including the
 * ones added after this file was written.
 */
export async function POST(request: Request) {
  let body: { provider?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const provider = typeof body.provider === "string" ? body.provider.trim() : "";
  // Charset guard before the value reaches either harness. Both delegates
  // validate again against their own allowlists — this only rejects the shapes
  // that should never have been sent, and keeps a value that could be read as a
  // CLI flag out of the call entirely.
  if (!provider || !isPlausibleHermesProviderId(provider)) {
    return NextResponse.json({ error: "Invalid provider" }, { status: 400 });
  }

  // The owner's switch, checked before either harness is asked. A provider
  // switched off may still hold a working credential, so neither delegate
  // would refuse it on its own — and promoting it would put the box's default
  // on a provider the owner just said not to use.
  if (!(await isProviderEnabled(provider))) {
    return NextResponse.json(
      { error: "That provider is switched off. Switch it on first.", kind: "provider_disabled", provider },
      { status: 409 },
    );
  }

  const harness = await getActiveHarness();

  if (harness === "hermes") {
    // Provider only, no model. That is deliberate: the models route then writes
    // that provider's OWN recommended default, which is the correct model for a
    // "make this the default" gesture and the one thing a caller here cannot
    // pick safely — sending a model would risk pairing a vendor with another
    // vendor's id.
    const res = await setHermesPairing(
      new Request("http://localhost/setup-api/hermes/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      }),
    );
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return NextResponse.json(data, { status: res.status });
    return NextResponse.json({ ok: true, provider, model: data.model ?? null });
  }

  // OpenClaw has no "provider" key to write — the default IS a fully-qualified
  // `<provider>/<modelId>` in `agents.defaults.model.primary`. So resolve the
  // model this provider is currently represented by, from the same state the
  // chat header reads, and set that.
  const stateRes = await readChatModelState();
  const state = (await stateRes.json().catch(() => ({}))) as {
    options?: { provider?: string; model?: string | null; available?: boolean }[];
  };
  const option = (state.options ?? []).find(
    (candidate) => candidate.provider === provider && candidate.available && candidate.model,
  );
  if (!option?.model) {
    // Not "unknown provider" — the provider is known, it just has no credential
    // on this box yet, and the fix is to connect it rather than to retry.
    return NextResponse.json(
      { error: "provider_unconfigured", provider },
      { status: 409 },
    );
  }

  const res = await setChatModel(
    new Request("http://localhost/setup-api/chat/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: option.model }),
    }),
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  return NextResponse.json({ ok: true, provider, model: option.model });
}
