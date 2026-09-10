import { CODEX_MODELS, type ProviderModelOption } from "@/lib/provider-models";
import { coreChatgptRoute } from "@/lib/core-model-lifecycle";
import { CHATGPT_DEFAULT_MODEL_ID } from "@/lib/chatgpt-subscription";

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
 * It can only ever ADD to the curated list, never narrow it below it: the
 * manifest is the core's static SEED, not its effective catalogue (both cores
 * declare `modelCatalog.discovery = {"openai": "runtime"}`, and the box's own
 * enumeration answers more rows than the seed lists), so a chatgpt-route model
 * that moves out of the seed into the discovered half must not take the row and
 * the write guard with it. Only the core's explicit `chatgpt.com` suppressions
 * remove a row. That is the fail-open direction `core-model-lifecycle.ts`
 * insists on everywhere else, and it is what keeps the guarantee the curated
 * array had by construction: a model this box has been running cannot stop
 * being selectable because a file changed shape.
 *
 * NOT the live per-account catalogue, which would be better still: the core
 * builds the real list from `chatgpt.com/backend-api/codex/models` per account,
 * and nothing on 2026.8.1 or 2026.9.3 publishes it in a form ClawBox can ask
 * for. `coreChatgptRoute` carries that measurement.
 *
 * NOT the core's own route contract either, and that is a judgement rather than
 * an oversight: `dist/extensions/openai/model-route-contract.js` exports
 * `OPENAI_CHATGPT_MODERN_MODEL_IDS` (its dual-route ids plus the
 * subscription-only ones) — the answer per model, with no credential, and it
 * would make two of the three narrowings below unnecessary. It is rejected
 * because reading it means `await import()`ing a core INTERNAL by absolute path:
 * it is not in the package's `exports` map, it executes core module code inside
 * the web server, and it would make this surface async — it is read by two write
 * guards on a request path. The manifest is data, already read by this repo for
 * retirements, at the same stable path, and parsed rather than executed. If the
 * core ever publishes the contract through its `exports` map or a CLI, that is
 * the better source and this note is where to start.
 *
 * Plan gating is still not filtered here — an unentitled account sees the
 * gpt-5.6 generation, the turn 400s upstream, and the sign-in probe
 * (src/lib/codex-model-probe.ts) is what keeps a box off a row its plan cannot
 * run.
 *
 * The one spelling a core bump cannot reach is the browser's pre-fetch paint:
 * `useProviderCatalog` renders `PROVIDER_CATALOGS.codex` (the curated array,
 * flagged `fallback: true`) until the catalogue request lands, so on a core that
 * has retired a curated row the picker can show it for that instant. A click in
 * that window is refused with a clean 400 by the guard below rather than
 * written, and the browser cannot read a manifest — so it is accepted, not
 * fixed.
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
  /**
   * `routeStated` ids skip the tier narrowing: an `api.openai.com` suppression
   * is the core saying the PLATFORM route cannot reach this model, which outranks
   * a guess made from the shape of its name. Without that, a future
   * `gpt-6-astra-pro` shipped the way `gpt-5.3-codex-spark` is shipped today
   * would be hidden by the `-pro` rule from the one surface that can run it —
   * and `codex-surface-follows-core.test.ts` would go red on a box while staying
   * vacuous on CI. `route.offRoute` still applies to everything: an explicit
   * "retired from this route" is never overridden.
   */
  const add = (id: string, name?: string, routeStated = false) => {
    if (seen.has(id) || route.offRoute.has(id)) return;
    if (!routeStated && offSurface(id)) return;
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
  for (const id of route.subscriptionOnly) add(id, undefined, true);
  // WIDEN, never narrow: a curated row the manifest's seed does not list stays
  // offered unless the core suppressed it on this route. See the header — the
  // seed is not the effective catalogue, and a row that merely fell out of it
  // must not stop being selectable on a box that has been running it. On both
  // measured cores this pass adds nothing, which is the point: it changes the
  // failure direction, not the list.
  for (const model of CODEX_MODELS) add(model.id);

  // Never an empty picker, and the list here is deliberately UNFILTERED — the
  // one place this file does not honour a suppression, so the reason is worth
  // spelling out.
  //
  // Since the widening pass above runs unconditionally, `models` already IS the
  // curated list minus the core's `chatgpt.com` suppressions, unioned with the
  // core's own rows. Reaching zero therefore means the core has suppressed EVERY
  // curated id on this route, so filtering this fallback through the same
  // suppressions would return the empty array — the same thing, spelled longer.
  //
  // And an empty surface is the one shape this module must not produce:
  // `isCodexSupportedModelId` would refuse every model while naming none, and
  // `chatgptDefaultModelId` would hand `configure` a default its own guard
  // refuses, so a ChatGPT sign-in could not complete at all. A row that 400s
  // upstream carrying the core's own error is the better of two bad answers in
  // that corner, and it is the fail-open direction `core-model-lifecycle.ts`
  // takes everywhere else. Pinned by
  // `codex-picker-astra.test.ts > keeps a last-resort list rather than emptying
  // the picker`.
  if (models.length === 0) return { models: CODEX_MODELS, source: "curated" };
  return { models, source: "core" };
}

/**
 * The id a fresh ChatGPT sign-in lands on before the entitlement probe runs.
 *
 * `gpt-5.5` while the surface carries it — it is the newest model every ChatGPT
 * tier can run, Free included, which is the whole reason it is the floor — and
 * otherwise the surface's first row.
 *
 * It has to be ASKED rather than assumed, because the same request that
 * computes this default is the one that then judges it: `configure` writes the
 * default and calls `offSurfaceCodexModelMessage` ninety lines later. While the
 * default was a constant and the guard was the same curated array, the two
 * could not disagree. Now that the guard follows the core, a core that retires
 * `gpt-5.5` from the ChatGPT route — the exact move 2026.9.3 made for `gpt-5.4`
 * and `gpt-5.4-mini`, and both measured manifests already carry `gpt-5.5` as
 * `status: "deprecated"` — would make a ChatGPT sign-in 400 on its own default
 * with no other door: setup could not complete.
 *
 * The first row rather than a second hand-kept name: it is the core's own
 * order, and the core lists its newest first.
 */
export function chatgptDefaultModelId(): string {
  return defaultIdFrom(chatgptSurface().models);
}

function defaultIdFrom(models: readonly ProviderModelOption[]): string {
  if (models.some((model) => model.id === CHATGPT_DEFAULT_MODEL_ID)) return CHATGPT_DEFAULT_MODEL_ID;
  return models[0]?.id ?? CHATGPT_DEFAULT_MODEL_ID;
}

/**
 * The models the sign-in probe should try, newest first, before settling for
 * {@link chatgptDefaultModelId}: everything the surface lists AHEAD of it.
 *
 * Derived for the same reason the default is, and it fixes the other half of
 * the same defect: the probe's hand-kept preference list can never name a model
 * a core upgrade adds, so on 2026.9.3 the picker would offer `gpt-6-astra`
 * first while every fresh sign-in still landed on `gpt-5.5` — this PR's own
 * complaint surviving in the one place that writes config.
 *
 * On the core the boxes run today this is exactly the list it replaces
 * (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`), which is what makes it a
 * safe swap: the probe still only upgrades on a POSITIVE answer, and anything
 * ambiguous still leaves the box on the floor every tier can run.
 */
export function chatgptUpgradeCandidates(): string[] {
  const models = chatgptSurface().models;
  const floor = models.findIndex((model) => model.id === defaultIdFrom(models));
  return (floor < 0 ? models : models.slice(0, floor)).map((model) => model.id);
}
