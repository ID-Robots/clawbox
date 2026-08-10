export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import {
  getModelOptions,
  invalidateModelOptions,
  isAllowedProvider,
  isPairAllowed,
  isSafeModelId,
  shouldEnforcePairing,
  scopeFromPayload,
  type HermesModelOption,
  type ModelOptionsPayload,
} from "@/lib/hermes-model-options";

// Hermes' provider/model configuration.
//
// GET  (unscoped)        → legacy { models, current } + the live per-provider
//                          catalogue, the configured provider, and reasoning.
// GET  ?provider=<slug>  → that provider's models ONLY, with an in-scope
//                          default. This is the REQ 1 contract: `current` is
//                          "" whenever the saved model belongs to a different
//                          provider, so a foreign vendor's id can never even
//                          reach the browser.
// GET  ?refresh=1        → bust Hermes' per-provider disk cache and re-fetch
//                          every provider's live /v1/models list.
// POST { provider?, model? } → persist via `hermes config set`, rejecting any
//                          pairing whose model is not in that provider's live
//                          list.
//
// The catalogue itself is LIVE (see src/lib/hermes-model-options.ts); nothing
// here hardcodes a model id.

function flag(value: string | null): boolean {
  return value === "1" || value === "true";
}

/** Union of every authenticated provider's models — the shape the desktop chat
 *  and the panel's initial paint have always consumed. */
function unionModels(payload: ModelOptionsPayload): HermesModelOption[] {
  const seen = new Set<string>();
  const models: HermesModelOption[] = [];
  for (const row of payload.providers) {
    // `null` = source can't tell (disk catalog / cold start); include those, but
    // never a row Hermes explicitly reports as having no credentials.
    if (row.authenticated === false) continue;
    for (const m of row.models) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      models.push(m);
    }
  }
  return models;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const refresh = flag(url.searchParams.get("refresh"));
  const provider = (url.searchParams.get("provider") || "").trim();

  try {
    if (provider) {
      const scoped = await getModelOptions({ refresh });
      if (!isAllowedProvider(scoped, provider)) {
        return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
      }
      return NextResponse.json(await scopeFromPayload(scoped, provider));
    }

    const payload = await getModelOptions({ refresh });
    const models = unionModels(payload);
    const current = payload.current.model;
    // Keep the saved model present in the unscoped list even when its provider
    // row is missing (dashboard down), so the panel doesn't blank the select.
    if (current && !models.some((m) => m.id === current)) {
      models.unshift({ id: current, description: "current" });
    }
    return NextResponse.json({
      models,
      current,
      provider: payload.current.provider,
      reasoning: payload.reasoning,
      providers: payload.providers.map((row) => ({
        id: row.id,
        name: row.name,
        authenticated: row.authenticated,
        isUserDefined: row.isUserDefined,
        source: row.source,
        total: row.total,
        ...(row.warning ? { warning: row.warning } : {}),
      })),
      source: payload.source,
      stale: payload.stale,
      fetchedAt: payload.fetchedAt,
    });
  } catch {
    // Never surface the dashboard origin, its password, or the hermes binary
    // path — a model listing failure is not worth leaking topology over.
    return NextResponse.json({ error: "Couldn't load models" }, { status: 502 });
  }
}

// Set the Hermes default model and/or inference provider. Persists via
// `hermes config set` (the same store the GET above reads back), so the change
// survives restarts and applies to `hermes -z` chats.
export async function POST(request: Request) {
  let body: { model?: string; provider?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const provider = typeof body.provider === "string" ? body.provider.trim() : "";

  if (!model && !provider) {
    return NextResponse.json({ error: "model or provider is required" }, { status: 400 });
  }
  // Reject flag-smuggling (a value starting with "-") and any charset the
  // config store shouldn't see. `runHermesCli` never uses a shell, but a
  // leading "-" could still be parsed by hermes as an option.
  if (model && !isSafeModelId(model)) {
    return NextResponse.json({ error: "Invalid model id" }, { status: 400 });
  }

  let payload: ModelOptionsPayload;
  try {
    payload = await getModelOptions();
  } catch {
    return NextResponse.json({ error: "Couldn't load models" }, { status: 502 });
  }

  if (provider && !isAllowedProvider(payload, provider)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 400 });
  }

  const previousProvider = payload.current.provider;
  const targetProvider = provider || previousProvider;
  if (!targetProvider) {
    return NextResponse.json({ error: "No provider configured" }, { status: 409 });
  }

  // Resolve the model we will actually write. A provider switch NEVER carries
  // the old provider's model across — that is precisely the reported bug
  // (pick Anthropic, keep saving deepseek). When the caller didn't name a
  // model we take that provider's own recommended default.
  let targetModel = model;
  if (!targetModel) {
    if (targetProvider === previousProvider) {
      targetModel = payload.current.model;
    } else {
      targetModel = (await scopeFromPayload(payload, targetProvider)).defaultModel;
    }
  }

  if (!targetModel) {
    // Empty scope = we have no model to pair with this provider. Writing
    // model.provider on its own would strand the config in exactly the
    // mismatched state this route exists to prevent (and `hermes config set`
    // cannot atomically clear model.default), so refuse.
    //
    // A STALE payload is a different failure from "no credentials": the
    // fallback manifest only ever carries openrouter+nous, so it cannot see a
    // provider's credentials at all. Saying "has no credentials yet" there is
    // simply false, so it gets its own code and its own copy.
    return NextResponse.json(
      {
        error: payload.stale ? "catalog_unavailable" : "provider_unauthenticated",
        provider: targetProvider,
      },
      { status: 409 },
    );
  }

  // A stale payload, or a CREDENTIALED provider whose row could not be
  // enumerated, is NOT evidence that the pairing is wrong — without that
  // tolerance a dashboard outage made even a no-op re-save of the device's own
  // current pairing fail with a 400. An UNAUTHENTICATED provider is different:
  // it serves nothing, so any model paired with it must be rejected (that is
  // REQ 1's server-side defence). shouldEnforcePairing draws exactly that line.
  if (
    shouldEnforcePairing(payload, targetProvider)
    && !isPairAllowed(payload, targetProvider, targetModel)
  ) {
    return NextResponse.json(
      { error: `Model "${targetModel}" is not available from provider "${targetProvider}"` },
      { status: 400 },
    );
  }

  // Only text WE produced is safe to echo back — a raw spawn rejection can
  // carry the hermes binary path.
  class ConfigSetError extends Error {}
  const setKey = async (key: string, value: string) => {
    const r = await runHermesCli(["config", "set", key, value]);
    if (r.code !== 0) throw new ConfigSetError(r.stderr || `Failed to set ${key}`);
  };

  try {
    // Provider first, then model. If the model write fails afterwards we roll
    // the provider back, so a partial failure can never leave the device on
    // provider A with provider B's model.
    const providerChanged = targetProvider !== previousProvider;
    if (providerChanged) await setKey("model.provider", targetProvider);
    try {
      // After a provider switch the model is written UNCONDITIONALLY. The
      // "already equal, skip it" shortcut compares against `payload.current`,
      // which comes from a cache that can be up to FRESH_MS old (or that a
      // concurrent writer has since moved past); a wrong "equal" there left
      // provider=new with the old provider's model on disk — precisely the
      // state this route exists to prevent.
      if (providerChanged || targetModel !== payload.current.model) {
        await setKey("model.default", targetModel);
      }
    } catch (err) {
      if (providerChanged && previousProvider) {
        // runHermesCli RESOLVES with a non-zero `code` on a failed command and
        // only rejects on spawn failure, so the exit code has to be inspected —
        // a `.catch(() => {})` alone would report a rollback that never happened.
        const rolledBack = await runHermesCli(["config", "set", "model.provider", previousProvider])
          .then((r) => r.code === 0)
          .catch(() => false);
        if (!rolledBack) {
          throw new ConfigSetError(
            `Couldn't set the model, and the provider could not be restored — this device is now set to "${targetProvider}" without a matching model. Pick a model for it and save again.`,
          );
        }
      }
      throw err;
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof ConfigSetError ? err.message : "hermes config failed" },
      { status: 502 },
    );
  } finally {
    // The device's selection changed (or attempted to) — never serve the old
    // `current` from cache.
    invalidateModelOptions();
  }

  return NextResponse.json({ ok: true, model: targetModel, provider: targetProvider });
}
