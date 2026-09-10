import { CODEX_MODELS, type ProviderModelOption } from "@/lib/provider-models";
import { coreChatgptRoute } from "@/lib/core-model-lifecycle";

/**
 * The models the ChatGPT account (the "OpenAI Codex" row) can be switched to on
 * THIS box — read from the installed core, not kept here.
 *
 * WHY IT MOVED OFF A CURATED LIST. `CODEX_MODELS` was the whole surface: the
 * picker offered it, both write paths accepted exactly it, and the refusal
 * sentence was built from it. One list beats three, but a hand-kept list still
 * cannot know what the next core ships — and it was wrong in BOTH directions at
 * once the moment a core bump was measured:
 *
 *   * `gpt-6-astra` was left out deliberately, on a turn that went to
 *     api.openai.com instead of chatgpt.com. That measurement was a property of
 *     the BOX, not of the model (see `coreChatgptRoute`): with an API key in
 *     play the core publishes the PLATFORM catalogue for `openai`, every row on
 *     it resolves to api.openai.com, and the same box sends the owner's own
 *     `gpt-5.5` there too — measured, 401, then failover. On 2026.9.3 the core
 *     lists `gpt-6-astra` FIRST in the openai manifest and files it as a
 *     dual-route model.
 *   * `gpt-5.4` and `gpt-5.4-mini` stay in the curated list, and 2026.9.3
 *     suppresses both on `chatgpt.com` — "retired from the ChatGPT-account
 *     Codex route". A box on that core would offer two rows that cannot run.
 *
 * So the surface follows the core's own manifest, and the curated list is what
 * it falls back to when no manifest can be read (CI, a box with no core yet, a
 * half-written file mid-upgrade). A model the account gains now reaches the
 * picker, both write guards and the refusal sentence with the next core, with
 * no ClawBox release.
 *
 * WHAT IS STILL OURS, and why it is a narrowing rather than a second list: the
 * core's manifest lists every openai model it ships, including rows that are
 * not on the subscription route at all. Three exclusions are applied to it,
 * each with its own reason below. They can only ever REMOVE a row the core
 * published — they cannot invent one — which is the opposite failure direction
 * from the curated list this replaces.
 *
 * NOT the live per-account catalogue, which would be better still: the core
 * builds the real list from `chatgpt.com/backend-api/codex/models` per account,
 * and nothing on 2026.8.1 or 2026.9.3 publishes it in a form ClawBox can ask
 * for. `coreChatgptRoute` carries that measurement. Plan gating therefore still
 * is not filtered here — an unentitled account sees the gpt-5.6 generation,
 * the turn 400s upstream, and the sign-in probe
 * (src/lib/codex-model-probe.ts) is what keeps a box off a row its plan cannot
 * run.
 */

/** The provider whose manifest carries the ChatGPT route (OpenClaw 2: `openai`). */
const CORE_PROVIDER = "openai";

/**
 * Ids that are aliases for a route rather than models on it: the core's own
 * `OPENAI_PLATFORM_ONLY_ROUTE_MODEL_IDS` on both measured cores
 * (`chat-latest`, bare `gpt-5.6`), which its own static Codex catalogue drops
 * from the ChatGPT list in `buildOpenAICodexStaticProviderConfig`.
 *
 * Neither core's manifest lists them, so this removes nothing today. It is
 * here because the manifest is now the INPUT: the day one is listed, an
 * unfiltered surface would offer an alias the ChatGPT route does not serve.
 */
const PLATFORM_ONLY_ALIASES: ReadonlySet<string> = new Set(["chat-latest", "gpt-5.6"]);

/**
 * Tiers the manifest lists that the ChatGPT account cannot run, by suffix.
 *
 *   * `-pro` — measured: the subscription path answers "model not supported
 *     when using Codex with a ChatGPT account" (developers.openai.com/codex
 *     /models). The core files them as dual-route, so only the platform half
 *     is real; the manifest carries `gpt-5.5-pro` and `gpt-5.4-pro`.
 *   * `-nano` — the core's own `OPENAI_CHATGPT_MODERN_MODEL_IDS` (its dual-route
 *     ids plus the subscription-only ones) omits `gpt-5.4-nano` on both
 *     measured cores while `OPENAI_PROVIDER_MODERN_MODEL_IDS` carries it: the
 *     core ships it for the platform route and not for this one.
 *
 * A suffix rule, not a generation rule. The generation allowlist this surface
 * used to carry could not spell the next model's name and hid two of them; a
 * tier suffix says nothing about WHEN a model shipped, and the day the core
 * suppresses one of these on `chatgpt.com` itself the suppression answers
 * first and this rule becomes redundant rather than wrong.
 */
const OFF_SURFACE_SUFFIXES: readonly string[] = ["-pro", "-nano"];

export interface ChatgptSurface {
  /** The rows to offer, newest-first in the order the source lists them. */
  models: readonly ProviderModelOption[];
  /** `core` when the installed core answered; `curated` when it could not. */
  source: "core" | "curated";
}

function offSurface(id: string): boolean {
  const lower = id.toLowerCase();
  if (PLATFORM_ONLY_ALIASES.has(lower)) return true;
  return OFF_SURFACE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * The curated row for `id`, when the shipped list carries one.
 *
 * It contributes the LABEL and the HINT, never the existence of the row. The
 * label matters because ours is not always the core's: the chat header's model
 * pill has ~142px for its text (chat-header-pills.ts), so
 * `gpt-5.3-codex-spark` ships as "GPT-5.3 Spark" rather than the core's
 * "GPT-5.3 Codex Spark", which would be the only label in any catalogue we ship
 * that truncates. The hint has no source at all on the device side — no
 * manifest, no enumeration carries one.
 */
function curatedRow(id: string): ProviderModelOption | undefined {
  return CODEX_MODELS.find((model) => model.id === id);
}

/** A readable label for a model the curated list has never heard of. */
function labelFor(id: string, name: string | undefined): string {
  const curated = curatedRow(id)?.label;
  if (curated) return curated;
  const trimmed = name?.trim();
  // The core's own display name, unless it is just the id again — 2026.9.3
  // ships `gpt-5.5-pro` with `name: "gpt-5.5-pro"`, and a label that repeats a
  // bare id reads as a bug in the picker rather than as a model name.
  return trimmed && trimmed.toLowerCase() !== id.toLowerCase() ? trimmed : id;
}

/**
 * The ChatGPT-route catalogue for this box.
 *
 * Synchronous on purpose: every caller is a guard on a write path or a picker
 * payload, and the read behind it is one cached, mtime-checked manifest — the
 * same one `coreRetiredModels` already reads on every catalogue request. An
 * async surface here would make `isCodexSupportedModelId` async in three
 * routes to save nothing.
 */
export function chatgptSurface(): ChatgptSurface {
  // FAILS OPEN on a throw, not just on a missing manifest. The callers are two
  // write guards and a picker payload: whatever an unreadable core does here, it
  // must come out as "offer the curated list", never as a 500 over a model
  // switch that should have been a plain accept or a plain refusal.
  let route: ReturnType<typeof coreChatgptRoute> = null;
  try {
    route = coreChatgptRoute(CORE_PROVIDER);
  } catch {
    route = null;
  }
  if (!route) return { models: CODEX_MODELS, source: "curated" };

  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  const add = (id: string, name?: string) => {
    if (seen.has(id) || offSurface(id) || route.offRoute.has(id)) return;
    seen.add(id);
    models.push({
      id,
      label: labelFor(id, name),
      // EMPTY for a model the curated list has never heard of, and that is the
      // honest answer: a hint is a sentence about a plan tier and a use case,
      // nothing on the device publishes one (neither the manifest nor an
      // enumeration carries a description), and inventing one for a model that
      // arrived with a core upgrade would be guessing at what the customer is
      // entitled to. The picker renders no hint line for an empty string.
      hint: curatedRow(id)?.hint ?? "",
    });
  };

  for (const row of route.listed) add(row.id, row.name);
  // After the listed rows, because a model the PLATFORM route suppresses is
  // absent from `models[]` entirely — `gpt-5.3-codex-spark` is in neither
  // core's list — and appending keeps it where the curated order put it: last,
  // behind the flagships.
  for (const id of route.subscriptionOnly) add(id);

  // Never an empty picker. A manifest that parses but lists nothing we would
  // offer is a shape this does not understand, and serving zero rows would
  // refuse every model on a box whose ChatGPT account works — the false failure
  // `core-model-lifecycle.ts` fails open to avoid, in the one direction that
  // matters here.
  if (models.length === 0) return { models: CODEX_MODELS, source: "curated" };
  return { models, source: "core" };
}

/** Just the ids, for a caller that only has to judge membership. */
export function chatgptSurfaceModelIds(): ReadonlySet<string> {
  return new Set(chatgptSurface().models.map((model) => model.id));
}
