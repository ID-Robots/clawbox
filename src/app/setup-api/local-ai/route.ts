export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { get, setMany } from "@/lib/config-store";
import { stopLocalAiProvider } from "@/lib/local-ai-runtime";
import { externalEngineSelected } from "@/lib/external-engine";
import { readConfig as readOpenClawConfig, inferConfiguredLocalModel, runOpenclawConfigSet, openclawIsAbsent } from "@/lib/openclaw-config";
import { readGatewayConfigBaseline, restartGatewayAnsweringEarly, settleConfigWrite } from "@/lib/gateway-hot-apply";
import { getActiveHarness } from "@/lib/harness";
import { HermesLocalRemovalError, removeLocalAiFromHermes } from "@/lib/hermes-local-ai";
import { CLAWBOX_AI_CHAT_MODEL, CLAWBOX_AI_PROVIDER } from "@/lib/clawbox-ai-models";
import { DISABLED_PROVIDERS_KEY, parseDisabledProviders } from "@/lib/provider-status";
import { readChatModelStateUnfiltered, POST as setChatModel } from "@/app/setup-api/chat/model/route";

const CLAWBOX_HOME_DIR = process.env.CLAWBOX_HOME_DIR || process.env.HOME || "/home/clawbox";

/** A llama.cpp or Ollama model ref — the provider rule `inferConfiguredLocalModel` reads. */
function isLocalModelRef(ref: unknown): boolean {
  if (typeof ref !== "string") return false;
  const provider = ref.split("/")[0].trim().toLowerCase();
  return provider.startsWith("llamacpp") || provider.startsWith("ollama");
}

/**
 * The fallback the configure route writes when there is no local model to use
 * (`ensureFallbackModel`): ClawBox AI, on a box signed in to it, unless the
 * owner switched it off. Turning Local AI on replaced it with the local model,
 * so turning it off puts it back rather than leave the box with no backup.
 */
async function clawboxAiFallback(config: Awaited<ReturnType<typeof readOpenClawConfig>>): Promise<string | null> {
  const apiKey = config.models?.providers?.[CLAWBOX_AI_PROVIDER]?.apiKey;
  if (typeof apiKey !== "string" || !apiKey.startsWith("claw_")) return null;
  if (parseDisabledProviders(await get(DISABLED_PROVIDERS_KEY)).has("clawai")) return null;
  return CLAWBOX_AI_CHAT_MODEL;
}

/**
 * Move a local PRIMARY back to the cloud model the box was on — the chat
 * picker's remembered primary row — through chat/model's own POST, the
 * delegation providers/default makes, so the session sweep, Tool Search and
 * the compaction model follow the primary as on any pick. True when it moved
 * (a 502 carrying a warning is a write that landed while the gateway settles).
 */
async function movePrimaryOffLocal(): Promise<boolean> {
  try {
    const target = (await readChatModelStateUnfiltered()).primary?.model;
    if (typeof target !== "string" || !target || isLocalModelRef(target)) return false;
    const res = await setChatModel(new Request("http://localhost/setup-api/chat/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `automatic`: the owner turned Local AI off, they did not pick this model.
      body: JSON.stringify({ model: target, automatic: true }),
    }));
    if (res.ok) return true;
    const data = (await res.json().catch(() => ({}))) as { warning?: unknown };
    return res.status === 502 && typeof data.warning === "string" && data.warning !== "";
  } catch (err) {
    console.error("[local-ai] Moving the chat off the local model failed:", err);
    return false;
  }
}

export async function POST(request: Request) {
  let body: { action?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.action !== "disable") {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  }

  // While an external AI engine is the Local AI (TASK-2376) its own Remove
  // is "turn Local AI off": it puts back what the box had before, which this
  // path cannot — it would clear the store keys that remember it.
  if (await externalEngineSelected()) {
    return NextResponse.json(
      {
        error: "An external AI engine is selected as Local AI. Use Remove in Settings → Local AI → External engine.",
        code: "external_engine_selected",
      },
      { status: 409 },
    );
  }

  try {
    const config = await readOpenClawConfig();
    const inferredLocal = inferConfiguredLocalModel(config);

    // Which runtime is actually up. The OpenClaw config answers on an OpenClaw
    // box; on a Hermes one it is empty of models by definition, so this used to
    // resolve to nothing and "turn Local AI off" left the model RESIDENT — up
    // to 3.2 GB of an 8 GB box, and for Ollama a unit that also stays enabled
    // across reboots (the enable path persists it). Our own config store knows
    // what we started, so it is the fallback. Read before the clear below.
    const stored = await get("local_ai_provider");
    const runningProvider = inferredLocal?.provider
      ?? (stored === "llamacpp" || stored === "ollama" ? stored : null);

    if (runningProvider === "llamacpp" || runningProvider === "ollama") {
      await stopLocalAiProvider(runningProvider);
    }

    await setMany({
      local_ai_configured: false,
      local_ai_provider: undefined,
      local_ai_model: undefined,
      local_ai_configured_at: undefined,
    });

    // Clearing the OpenClaw fallback only applies where OpenClaw exists. On the
    // Hermes SKU there is no binary to spawn (it would ENOENT); the Hermes
    // unregister below is what actually takes effect there.
    //
    // A failure here is REPORTED, not swallowed: the model is stopped, so a
    // fallback list that still names it sends the next turn that falls back to
    // an endpoint with nothing behind it. It is a qualification rather than a
    // refusal, though — the stop and the flag clear above are the steps this
    // click is for, and they landed — so it rides the `warning` channel the
    // panel already paints amber, and a retry re-runs only what is left.
    //
    // Through `runOpenclawConfigSet`, not a raw spawn, precisely BECAUSE the
    // outcome is now shown to the owner: that wrapper retries the
    // `ConfigMutationConflictError` this route races (it writes while the
    // gateway is reloading on the stop above), and settles a spawn killed at
    // its deadline by reading the assignment back off disk — `openclaw config
    // set` writes early and then spends seconds validating catalogs, so on a
    // Jetson the value routinely lands inside the window a 30 s timeout kills
    // in. A hand-rolled `execFile` would have turned both into an amber banner
    // over a write that succeeded. It also resolves the binary per call, so a
    // web server that started mid-reinstall does not freeze a stale path.
    let warning: string | null = null;
    // Set below, answered after the gateway has the clear: the branch also
    // fires on a licensed `dual` box running Hermes, where OpenClaw exists and
    // its gateway does too — so returning from inside it would drop the
    // fallback warning and skip making the clear above take effect.
    let hermesUnregisterFailed = false;
    const openclawPresent = !openclawIsAbsent();
    const gatewayBaseline = openclawPresent ? await readGatewayConfigBaseline() : null;
    // Only the local models leave the list. Writing `[]` here took every other
    // backup with them, so a primary that then failed (a limit, an outage)
    // failed the chat instead of falling back.
    const listedFallbacks = config.agents?.defaults?.model?.fallbacks;
    const fallbacks = Array.isArray(listedFallbacks) ? listedFallbacks : [];
    if (openclawPresent && fallbacks.some(isLocalModelRef)) {
      const kept = fallbacks.filter((ref) => !isLocalModelRef(ref));
      if (kept.length === 0) {
        const clawboxAi = await clawboxAiFallback(config);
        if (clawboxAi) kept.push(clawboxAi);
      }
      const cleared = await runOpenclawConfigSet(
        ["agents.defaults.model.fallbacks", JSON.stringify(kept), "--json"],
        { cwd: CLAWBOX_HOME_DIR, env: { ...process.env, HOME: CLAWBOX_HOME_DIR } },
      ).then(
        () => true,
        (err) => {
          console.error("[local-ai] Failed to clear the OpenClaw fallback list:", err);
          return false;
        },
      );
      if (!cleared) {
        // Only reached when the list does name a local model, so a box running
        // one as primary with no local fallback is never told about an entry
        // that was never there.
        warning = "Local AI is stopped, but clearing OpenClaw's fallback model list failed. Turn it off again to finish.";
      }
    }

    // A local PRIMARY goes back to the cloud model (TASK-2127). Stopping the
    // server and clearing the flags is not enough while
    // `agents.defaults.model.primary` still names it: the Local AI proxy wakes
    // llama-server on the next turn, and a board measured the chat going on
    // answering on Gemma after "Turn off Local AI".
    if (openclawPresent && isLocalModelRef(config.agents?.defaults?.model?.primary)) {
      if (!(await movePrimaryOffLocal())) {
        const stuck = "Local AI is stopped, but the chat could not be moved back to the cloud model. Pick one in the chat header.";
        warning = warning ? `${warning} ${stuck}` : stuck;
      }
    }

    // Hermes keeps its own providers block, so disabling here has to unregister
    // there too — otherwise the picker keeps offering a model that is no longer
    // running, which fails only once the customer actually sends a message.
    if ((await getActiveHarness()) === "hermes") {
      // `wasDefault` is the round-trip half: when the local model was the
      // device's active provider, removeLocalAiFromHermes clears the selection
      // (leaving it set with the providers block gone 502s every chat turn with
      // "Unknown provider 'clawlocal'"), and we remember that it WAS the
      // selection so re-enabling puts the device back where it was rather than
      // on nothing.
      //
      // The failure is ANSWERED rather than logged. On this SKU the unregister
      // is the only step that reaches the customer: the OpenClaw clear above is
      // skipped (no binary) and there is no OpenClaw gateway to apply
      // anything to, so a swallowed failure left `providers.clawlocal` in
      // config.yaml and the route still said `{success:true}` — Settings showed
      // Local AI off while Hermes' own pickers went on offering the stopped
      // model, and the owner learned otherwise from a chat turn. The steps that
      // did run stand: a retry has only this one left to do.
      // Recorded even when the removal FAILS. A partial unset can clear
      // `model.provider` and leave a providers key, and the refusal is the last
      // moment that fact exists: the retry reads a selection that is already
      // gone, so the flag would be lost for good and re-enabling Local AI would
      // leave the device on nothing.
      let wasDefault = false;
      const removal = await removeLocalAiFromHermes().catch((err) => {
        console.error("[local-ai] Hermes local provider removal failed:", err);
        if (err instanceof HermesLocalRemovalError) wasDefault = err.wasDefault;
        return null;
      });
      hermesUnregisterFailed = !removal;
      if (removal?.wasDefault || wasDefault) {
        await setMany({ local_ai_was_default: true });
      }
    }

    // The clear is `agents.defaults.model.fallbacks`, which the gateway
    // hot-applies: this used to restart clawbox-gateway on every "Turn off Local
    // AI" click to make it take effect (TASK-1535). The restart stays only as
    // the fallback for a gateway that could not confirm the change, answered
    // early and never awaited for readiness — the route answers `{success:true}`
    // for the config change either way. Nothing to do on the Hermes-only
    // edition, which has no OpenClaw gateway.
    if (openclawPresent) {
      const settlement = await settleConfigWrite({
        before: config,
        after: await readOpenClawConfig(),
        baseline: gatewayBaseline,
        label: "local-ai",
      });
      if (settlement === "restart-required") {
        await restartGatewayAnsweringEarly().catch((err) => {
          console.error("[local-ai] Gateway restart after turning Local AI off failed:", err);
        });
      }
    }

    if (hermesUnregisterFailed) {
      // The panel paints `error` red on a non-2xx and never looks at `warning`
      // there, so a box that hit both failures gets both sentences or it gets
      // one of them told wrongly.
      // Covers all three refusals `removeLocalAiFromHermes` can raise — a key
      // that demonstrably survived, one the config could not be read back for,
      // and one where the selection could not be read at all so nothing was
      // attempted — because the route sees only that it threw. "May still be
      // offered" understates the third (there it definitely still is), and the
      // action it asks for is the same in all three.
      const failed = "Local AI was stopped, but removing it from Hermes could not be confirmed — it may still be offered as a provider. Try turning Local AI off again.";
      return NextResponse.json(
        { error: warning ? `${failed} ${warning}` : failed },
        { status: 502 },
      );
    }

    return NextResponse.json({ success: true, ...(warning ? { warning } : {}) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to disable Local AI" },
      { status: 500 },
    );
  }
}
