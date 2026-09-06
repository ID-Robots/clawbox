// One answer to "which AI providers is this box connected to, and which one is
// the default" — for EVERY provider, in a single call, on either harness.
//
// WHY THIS EXISTS. Before it, the connected/not state was discoverable only by
// selecting a provider in Settings and reading the panel that appeared for it:
// eight providers meant eight clicks to learn what the box was actually set up
// with, and four of them (the key-only ones) had no connected indicator at all.
// The strip that reads this is the fix, and the endpoint is what makes reading
// it one round-trip instead of one per provider.
//
// WHAT IT MAY NOT DO. Every field here is a status, never a credential: a
// state string, a label, an id. The rule is the one
// `/setup-api/chat/capabilities` already states — a page needs to know whether
// a provider WORKS, not what the key is — and it is enforced by a test that
// scans the response for token-shaped values.

import { getActiveHarness, type Harness } from "@/lib/harness";
import { isClawboxAiToken } from "@/lib/clawai-token";
import { hasClawaiToken } from "@/lib/harness/credentials";
import { clawaiTokenRejectedByPortal } from "@/lib/clawbox-ai-portal-tier";
import { readConfig } from "@/lib/openclaw-config";
import { get as getConfigValue } from "@/lib/config-store";
import {
  CLAWAI_PROVIDER,
  HERMES_PANEL_PROVIDERS,
  hermesProviderLabel,
} from "@/lib/hermes-providers";
import { getModelOptions, probeStillOwed } from "@/lib/hermes-model-options";
import {
  pluginHasSettingsRow,
  readPluginRepairs,
  repairFor,
  type PluginRepairStage,
} from "@/lib/plugin-repair";
import { readProviderRunnable, type ProviderRunnable } from "@/lib/provider-runnable";

/**
 * What the strip paints, and the only five things it may say.
 *
 * `needs-reauth` is NOT a guess. It is the one genuinely diagnosable failure:
 * the box is POINTED AT this provider as its default and cannot authenticate to
 * it. That state is invisible today and is exactly the one worth a distinct
 * colour, because chat is broken until it is fixed. Anything else we cannot
 * tell apart from "never set up" gets `disconnected`, and anything we could not
 * ask about at all gets `unknown` rather than a cheerful default.
 *
 * `checking` and `unknown` are the two halves of what used to be one word, and
 * the split is the whole of TASK-663. `unknown` is a RESULT — we asked and the
 * source could not tell us. `checking` is the absence of a result: the harness
 * has not been reachable yet and no probe has happened at all. They looked the
 * same on the wire, so a box in its first seconds after a reboot painted every
 * provider "Unknown" under a "couldn't reach the agent" banner — a healthy box
 * reported as broken. A `checking` row therefore also counts for NOTHING
 * toward {@link ProviderStatusSummary.degraded}: there is no bad answer yet,
 * only no answer. It is time-bounded at the source, in EVERY branch, so a
 * harness that never comes back falls back to `unknown` and a degraded summary
 * rather than spinning for ever — see `probeStillOwed` in
 * `hermes-model-options.ts`, which asks systemd whether the dashboard's unit is
 * actually still starting and then bounds even that answer by the unit's own
 * `TimeoutStartSec` (`MAX_CHECKING_WINDOW_MS`).
 */
export type ProviderConnectionState =
  | "connected"
  | "disconnected"
  | "needs-reauth"
  | "checking"
  | "unknown";

export interface ProviderStatusRow {
  /** The harness-native provider id. This is what `/providers/default` takes. */
  id: string;
  /** Vendor name for display. Brand names are not translated. */
  label: string;
  state: ProviderConnectionState;
  /** True for the provider the harness config actually names as its default. */
  isDefault: boolean;
  /**
   * The owner's switch, orthogonal to `state`: a provider can be connected and
   * switched off at the same time, and the strip shows both facts. False only
   * for an id in `ai_disabled_providers`; see `provider-enablement.ts` for the
   * rule that keeps the default out of that list.
   */
  enabled: boolean;
  /**
   * Which Settings section configures this row, so a click on the chip lands
   * where the fix is. Local engines are configured in their own section and
   * saying "AI Provider" for them would send the user to a panel that cannot
   * change them.
   */
  section: "ai" | "localAi";
  /**
   * Present only when the boot script could not install or consent the plugin
   * this row runs on and switched it off so the gateway could start (TASK-606).
   * A row in this state is `disconnected` because it genuinely is — what this
   * adds is WHY, and something the owner can press.
   */
  needsRepair?: {
    /** What `openclaw plugins install` / `enable` takes, for the Retry. */
    pluginId: string;
    stage: PluginRepairStage;
    reason: string;
    atMs: number;
  };
}

export interface ProviderStatusSummary {
  harness: Harness;
  providers: ProviderStatusRow[];
  /** The default provider's id, or null when the box has none yet. */
  defaultProvider: string | null;
  /**
   * Provider ids dropped from `providers` because this box can run NO model
   * from them — the owner's ruling on TASK-668, and the only reason a curated
   * row ever goes missing.
   *
   * Carried rather than left implicit because "absent" and "the summary could
   * not be built" look the same to a client, and a second surface that renders
   * its own hard-coded provider list (the Connect panel) has to be able to tell
   * them apart: an empty array means every row it knows about may be shown.
   */
  unrunnable: string[];
  /**
   * True when the answer came from a fallback rather than from the live box —
   * a Hermes dashboard that did not respond, or an unreadable config. The strip
   * says so rather than painting a stale answer as fact.
   *
   * A harness that is merely still STARTING is not degraded: those rows say
   * `checking` and this stays false until the wait outlives the boot window.
   * See {@link ProviderConnectionState}.
   */
  degraded: boolean;
  /**
   * Plugins that need repair and have no Settings row of their own (TASK-738).
   *
   * A core bump can strand an entry for a plugin an older core bundled —
   * `byteplus`, `vydra`, `xiaomi` on the incident box — which refuses gateway
   * readiness until something switches it off. ClawBox does switch it off, and
   * the owner then has a provider that silently stopped existing unless he is
   * told: there is no Providers row and no Channels row for `vydra` to badge.
   * These are those rows, listed under the provider list with the same notice
   * and the same Retry every other repair uses.
   *
   * NOT filtered to the `not-installed` stage, on purpose: the rule is "no
   * other surface will draw this row", not "the updater wrote it". If the boot
   * script ever marks a plugin outside `ROW_PLUGIN_IDS`, that row belongs here
   * too rather than nowhere.
   *
   * Absent rather than empty on a box that could not be asked, and absent on
   * Hermes, where nothing writes the record at all.
   */
  unattachedRepairs?: {
    pluginId: string;
    stage: PluginRepairStage;
    reason: string;
    atMs: number;
  }[];
}

/** OpenClaw's AI-provider section offers exactly these, in this order. */
const OPENCLAW_PANEL_PROVIDERS: readonly { id: string; label: string }[] = [
  { id: "clawai", label: "ClawBox AI" },
  { id: "openai", label: "OpenAI GPT" },
  { id: "anthropic", label: "Anthropic Claude" },
  { id: "google", label: "Google Gemini" },
  { id: "openrouter", label: "OpenRouter" },
];

const LOCAL_PROVIDER_LABELS: Record<string, string> = {
  llamacpp: "Gemma 4 (on-device)",
  ollama: "Ollama Local",
  // Hermes registers the on-device model under its own slug.
  clawlocal: "Gemma 4 (on-device)",
};

const LOCAL_PROVIDER_IDS = new Set(Object.keys(LOCAL_PROVIDER_LABELS));

/**
 * Collapse OpenClaw's wire spellings of one vendor onto one id, so a provider
 * cannot appear twice in a strip whose whole job is to be scannable. Mirrors
 * the normaliser `/setup-api/ai-models/status` already uses; kept in step with
 * it deliberately, because a row the two disagreed about would show as
 * connected in one place and absent in the other.
 *
 * OpenClaw only. Hermes' ids are already canonical (`gemini`, `openai-codex`,
 * `clawlocal`) and are used verbatim — this would fold `openai-codex` onto
 * `openai`, an id no Hermes row carries. `canonicalProviderId` is the
 * harness-aware entry point.
 */
export function normalizeProviderId(provider: string | null | undefined): string | null {
  if (!provider) return null;
  const normalized = provider.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "deepseek" || normalized === "clawai") return "clawai";
  if (normalized.startsWith("openai") || normalized === "codex") return "openai";
  if (normalized.startsWith("google")) return "google";
  if (normalized.startsWith("anthropic")) return "anthropic";
  if (normalized.startsWith("openrouter")) return "openrouter";
  if (normalized.startsWith("ollama")) return "ollama";
  if (normalized.startsWith("llamacpp")) return "llamacpp";
  return normalized;
}

/**
 * The id a provider is keyed by in the status rows — and therefore in the
 * owner's disabled list, which must match those rows exactly or a switch
 * flipped on one id would never be seen on the other.
 */
export function canonicalProviderId(harness: Harness, provider: string | null | undefined): string | null {
  if (harness === "openclaw") return normalizeProviderId(provider);
  const trimmed = provider?.trim().toLowerCase();
  return trimmed || null;
}

/**
 * Config-store key for the providers the owner has switched off: an array of
 * canonical ids. Read here, because the status is what stamps `enabled` on
 * every row; written only by `provider-enablement.ts`, which owns the rule.
 */
export const DISABLED_PROVIDERS_KEY = "ai_disabled_providers";

/**
 * The stored list as a set, tolerant of anything that is not one: the store
 * is hand-editable JSON, and a malformed value must read as "nothing disabled"
 * rather than take the status endpoint down.
 */
export function parseDisabledProviders(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((id): id is string => typeof id === "string" && id.length > 0));
}

function sectionFor(id: string): "ai" | "localAi" {
  return LOCAL_PROVIDER_IDS.has(id) ? "localAi" : "ai";
}

/** A row before the owner's switch is stamped on it; see `readProviderStatus`. */
type UnstampedRow = Omit<ProviderStatusRow, "enabled">;
interface UnstampedSummary extends Omit<ProviderStatusSummary, "providers" | "unrunnable"> {
  providers: UnstampedRow[];
}

/**
 * The one place the five states are decided, so the two harness paths cannot
 * drift into disagreeing about what "connected" means.
 *
 * `credentialed === null` means the source could not tell us (Hermes' on-disk
 * catalogue carries no auth state), which is `unknown` — never `disconnected`.
 * Painting "not connected" over a provider we simply failed to ask about is the
 * failure mode most likely to send someone to re-enter a key that was fine.
 */
/**
 * Has the portal already refused THIS box's ClawBox AI token?
 *
 * CACHE-ONLY, which is the whole point: this reader probes nothing and is
 * polled, so it answers from what `/setup-api/ai-models/status` has already
 * asked (every 30 s, while any client is open) and says "nobody has asked" on a
 * cold process — no request, and not even a credential read. A cold answer
 * keeps beta's row exactly as it was.
 *
 * Why it belongs here at all: `credentialed` is credential PRESENCE, so a
 * revoked token painted the cyan dot and the word "Connected" on the one screen
 * the chat's own "reconnect it in Settings" sends the customer to (TASK-419).
 * `needs-reauth` is the state that was written for exactly this — "the box is
 * pointed at this provider and cannot authenticate to it".
 */
function clawaiTokenRefused(): boolean {
  return clawaiTokenRejectedByPortal();
}

function stateFor(
  credentialed: boolean | null,
  isDefault: boolean,
  /** True while the harness has not been reachable YET — see
   *  {@link ProviderConnectionState}. Only ever splits the `null` case. */
  awaitingProbe = false,
): ProviderConnectionState {
  if (credentialed === true) return "connected";
  if (credentialed === null) return awaitingProbe ? "checking" : "unknown";
  return isDefault ? "needs-reauth" : "disconnected";
}

/**
 * Hermes: the live dashboard already answers this for every provider at once
 * (`authenticated` per row) and `getModelOptions` is the memoised reader for
 * it, so the aggregate costs no more than the panel's own existing load.
 */
async function readHermesStatus(): Promise<UnstampedSummary> {
  const payload = await getModelOptions();
  const byId = new Map(payload.providers.map((row) => [row.id, row]));
  const defaultProvider = payload.current.provider || null;

  // The panel's providers, plus ClawBox AI, plus whatever the box is actually
  // set to. That last term matters: a provider configured through Hermes' own
  // dashboard is not in our curated list, and leaving it out would show a box
  // with a working default as having no default at all.
  const ids: string[] = [CLAWAI_PROVIDER, ...HERMES_PANEL_PROVIDERS.map((p) => p.id)];
  if (defaultProvider && !ids.includes(defaultProvider)) ids.push(defaultProvider);

  // Asked once, outside the loop: it reads config and the config store, and the
  // answer is the same for every row that consults it.
  const clawaiLinked = await hasClawaiToken();
  const clawaiRefused = clawaiTokenRefused();

  // Did the live dashboard actually answer? `stale` is set on every fallback
  // path (dashboard down, disk-catalog cold start). It draws the line between
  // "we asked and ClawBox AI is simply not linked" (disconnected) and "we could
  // not ask at all" (unknown) — the ONLY case ClawBox AI is still allowed to be
  // unknown, because its link state is otherwise fully knowable from our own
  // stores.
  const probeAnswered = !payload.stale;

  // ...and if it did not, has it simply not had a chance yet? The dashboard is
  // not up when this server is (~11-12 s after every boot and after every
  // restart we ourselves trigger). `probeStillOwed` is the one place that
  // knows: it asks systemd whether the unit is still starting, and bounds that
  // answer as well as its own clock. Within the window a row with no auth state
  // is `checking`, not `unknown`, and the summary is not degraded — there is no
  // bad answer yet, only no answer. Once the unit has died, or either bound is
  // spent, every row goes back to today's behaviour.
  //
  // Guarded on `stale` as well: `probeStillOwed` describes the DASHBOARD, and
  // on a payload that did come from the live dashboard a row it declined to
  // judge is a real result that keeps its own word.
  const awaitingProbe = payload.stale === true && await probeStillOwed();

  const providers = ids.map((id) => {
    const isDefault = id === defaultProvider;
    const reported = byId.get(id)?.authenticated ?? null;
    // ClawBox AI is judged like every other provider — by what the dashboard
    // reports — and falls back to OUR credential only when the dashboard has no
    // opinion (no clawai row yet, or a catalogue read that could not say).
    //
    // It used to read the credential FIRST, and that was wrong in the one
    // direction that matters: `resolveClawaiToken` looks in ClawBox's own
    // stores, so on a Hermes box whose token Hermes holds — the dashboard
    // reporting `authenticated: true`, `providers.clawai.base_url` set, chat
    // working — the strip called the box's ACTIVE provider "Needs sign-in".
    // Caught on a live linked device. The fallback is kept because it is the
    // honest direction: a held credential is evidence of a link, while the
    // absence of one is not evidence of its absence.
    //
    // BUT a linked-token-absent-AND-dashboard-silent ClawBox AI is not
    // "unknown", it is simply NOT CONNECTED — provided the dashboard actually
    // answered. Reporting "Unknown" over a box that has plainly never linked
    // ClawBox AI (its own state a mid-setup owner is looking straight at) is
    // the confusing lie this reserves for a genuine probe failure.
    const credentialed = id === CLAWAI_PROVIDER
      ? (reported ?? (clawaiLinked ? true : (probeAnswered ? false : null)))
      : reported;
    return {
      id,
      label: hermesProviderLabel(id, byId.get(id)?.name),
      state: id === CLAWAI_PROVIDER && clawaiRefused && credentialed === true
        ? "needs-reauth"
        : stateFor(credentialed, isDefault, awaitingProbe),
      isDefault,
      section: sectionFor(id),
    };
  });

  return { harness: "hermes", providers, defaultProvider, degraded: payload.stale && !awaitingProbe };
}

export { isClawboxAiToken } from "@/lib/clawai-token";

/**
 * OpenClaw: `openclaw.json` is the whole answer. A provider is connected when
 * the gateway holds an auth profile for it or a key under its provider
 * definition — the same two places `/setup-api/chat/model` builds its dropdown
 * from, so the strip and the chat can never disagree about who is available.
 */
async function readOpenclawStatus(): Promise<UnstampedSummary> {
  const config = await readConfig();
  const profiles = config.auth?.profiles ?? {};
  const definitions = config.models?.providers ?? {};

  const credentialed = new Set<string>();
  for (const [profileKey, entry] of Object.entries(profiles)) {
    const id = normalizeProviderId(entry?.provider ?? profileKey.split(":")[0]);
    if (id) credentialed.add(id);
  }
  for (const [wireId, definition] of Object.entries(definitions)) {
    const key = (definition as { apiKey?: unknown })?.apiKey;
    if (typeof key !== "string" || !key.trim()) continue;
    const id = normalizeProviderId(wireId);
    if (!id) continue;
    // ClawBox AI's images and cloud voice ride in the `openai` slot — its
    // OpenAI-compatible routes on our proxy, keyed with the claw_ token. That
    // is a ClawBox AI credential wherever it sits, not an OpenAI account, and
    // a box with only ClawBox AI linked was reading "OpenAI: Connected".
    if (isClawboxAiToken(key)) {
      credentialed.add(CLAWAI_PROVIDER);
      continue;
    }
    credentialed.add(id);
  }
  // The ClawBox AI credential can live in the config store instead of the
  // config file (a box migrated from a Hermes install), and `hasClawaiToken`
  // is the helper that knows both homes.
  const clawaiRefused = clawaiTokenRefused();
  if (await hasClawaiToken()) credentialed.add(CLAWAI_PROVIDER);

  const primary = config.agents?.defaults?.model?.primary ?? null;
  const defaultProvider = normalizeProviderId(primary ? primary.split("/")[0] : null);

  const rows: { id: string; label: string }[] = [...OPENCLAW_PANEL_PROVIDERS];

  // The configured local engine, when there is one. It belongs in a strip
  // titled "what is connected" even though it is configured elsewhere — the
  // `section` field is what keeps a click on it honest.
  const storedLocal = await getConfigValue("local_ai_provider").catch(() => null);
  const localProvider = normalizeProviderId(
    typeof storedLocal === "string" ? storedLocal : null,
  );
  if (localProvider && LOCAL_PROVIDER_IDS.has(localProvider)) {
    rows.push({ id: localProvider, label: LOCAL_PROVIDER_LABELS[localProvider] });
    credentialed.add(localProvider);
  }
  if (defaultProvider && !rows.some((r) => r.id === defaultProvider)) {
    rows.push({
      id: defaultProvider,
      label: LOCAL_PROVIDER_LABELS[defaultProvider] ?? defaultProvider,
    });
  }

  const providers = rows.map(({ id, label }) => {
    const isDefault = id === defaultProvider;
    return {
      id,
      label,
      // No `awaitingProbe` here, deliberately: this reader PROBES NOTHING. It
      // answers from whatever `openclaw.json` it just read, so `credentialed`
      // is a definite yes or no for every row and there is no window in which
      // a probe answer is owed. OpenClaw's gateway has no equivalent to ask
      // either — its only non-WebSocket endpoints are the `/healthz`,
      // `/readyz` and `/startupz` liveness probes, none of which carries
      // provider auth.
      //
      // A separate question, deliberately NOT answered here: `readConfig`
      // collapses every read failure (EACCES, a file caught half-written by a
      // concurrent `config set`) into `{}`, so an unreadable config reads as
      // "nothing configured" rather than as `degraded` — which is what the
      // summary's own doc promises. Same shape of false failure as the one
      // this fix addresses, different reader, and it needs `readConfigStrict`
      // rather than a probe state.
      state: id === CLAWAI_PROVIDER && clawaiRefused && credentialed.has(id)
        ? "needs-reauth"
        : stateFor(credentialed.has(id), isDefault),
      isDefault,
      section: sectionFor(id),
    };
  });

  return { harness: "openclaw", providers, defaultProvider, degraded: false };
}

/**
 * The catalogues that answer for one ROW.
 *
 * A row can stand for more than one: `codex` — the ChatGPT-subscription
 * catalogue — normalises onto the `openai` row, and a box signed in to ChatGPT
 * with no API key runs on the one while the other has nothing.
 */
const CATALOGUES_BY_ROW: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    clawai: ["clawai"],
    openai: ["openai", "codex"],
    anthropic: ["anthropic"],
    google: ["google"],
    openrouter: ["openrouter"],
  }),
);

/**
 * "Can this box run any model from the provider this ROW stands for?"
 *
 * `none` demands UNANIMITY, and every catalogue behind the row must actually
 * have answered: one `some` keeps the row, and so does one that nobody has
 * asked about. That is what stops a ChatGPT-subscription box losing its OpenAI
 * row because the API-key catalogue is empty — and, since `codex` has no
 * enumeration on this core at all (`hasNoEnumerationOnThisCore` in the catalog
 * route), it means the OpenAI row is never hidden today. Deliberate: the
 * alternative is hiding the row a subscription box actually runs on.
 */
export function providerRowRunnable(
  rowId: string,
  verdicts: Map<string, ProviderRunnable>,
): ProviderRunnable {
  const catalogues = CATALOGUES_BY_ROW.get(rowId) ?? [rowId];
  let sawNone = false;
  for (const catalogue of catalogues) {
    const verdict = verdicts.get(catalogue);
    if (verdict === "some") return "some";
    if (verdict === "none") sawNone = true;
    else return "unknown";
  }
  return sawNone ? "none" : "unknown";
}

/**
 * The aggregate, for whichever harness this box runs.
 *
 * Never throws: a box that cannot answer reports `degraded` with no rows,
 * because the strip's job is to be readable at a glance and a confidently wrong
 * "not connected" is worse than an honest "could not ask".
 */
export async function readProviderStatus(): Promise<ProviderStatusSummary> {
  const harness = await getActiveHarness().catch(() => "openclaw" as Harness);
  try {
    const summary = harness === "hermes" ? await readHermesStatus() : await readOpenclawStatus();
    // Stamped once, here, rather than inside each reader: the switch is the
    // same fact on both harnesses, and one site cannot disagree with itself
    // about what "enabled" means.
    const disabled = parseDisabledProviders(
      await getConfigValue(DISABLED_PROVIDERS_KEY).catch(() => null),
    );
    // Same reason, same place: what the boot script could not make loadable is
    // one fact about the box, and stamping it here keeps the two harness
    // readers from having to know about it at all. On Hermes the file never
    // exists and this is an empty map, so the badge is absent by construction.
    const repairs = await readPluginRepairs();
    // TASK-668, the owner's ruling: a provider this box can run NO model from
    // is not offered at all. The verdict is read from what the enumeration the
    // catalog route already performs recorded — no probe, no fork — and a
    // provider with no recorded answer keeps its row exactly as on beta.
    //
    // OpenClaw only. Hermes' rows carry a `total` from the dashboard, but a
    // zero there is documented (see `providerHasModels` in
    // hermes-model-options.ts) as "credentialed and its /v1/models could not be
    // enumerated" as often as "serves nothing" — the two are indistinguishable
    // under `include_unconfigured=true`, so hiding on it would delete a working
    // provider. Hermes keeps every panel row until that answer exists.
    const verdicts = summary.harness === "openclaw"
      ? await readProviderRunnable().catch(() => new Map<string, ProviderRunnable>())
      : new Map<string, ProviderRunnable>();
    const candidates = summary.providers
      .filter((row) => {
        // The connection state is NOT consulted, and that is a change of mind
        // with a reason. It was, so that hiding a row could never take away the
        // way out of the state that hid it — but the way out is the "Connect AI
        // Provider" list, and that list no longer hides anything (see
        // `AIModelsStep`). The strip answers "what is this box set up with and
        // can it run"; a provider it can run nothing from does not belong in
        // that answer whether or not a credential is sitting there.
        //
        // The provider the box is POINTED AT is never named. It is the reason
        // chat is broken, and a row nobody can see is a row nobody can change.
        if (row.isDefault) return false;
        // Nor is one whose plugin the boot script had to switch off: that row
        // carries the Retry, the single affordance that repairs it (TASK-606).
        if (repairFor(repairs, row.id)) return false;
        return providerRowRunnable(row.id, verdicts) === "none";
      })
      .map((row) => row.id);
    // ...and if that would leave the strip showing the default row alone, it is
    // none of them.
    //
    // The counts come from `openclaw models list`, and one failure can answer
    // `count: 0` for several providers at once — a models.json the core cannot
    // load, a config caught half-written, a gateway restart mid-refresh. Each of
    // those is a clean zero per provider and none of them is a fact about what
    // the box can run. Rather than guess which, the strip declines to act when
    // the answer is "everything": a whole panel reduced to the default row is
    // never the honest reading, and the owner's connected key would be nowhere
    // on the screen for the six hours a record lives.
    //
    // MEASURED AGAINST THE ROWS THE STRIP RENDERS, not against every row in this
    // summary, and that is the whole of whether the rule works. Counting all of
    // them made it unsatisfiable on every box: three of the five panel rows can
    // never be candidates — `openai` stands for the `codex` catalogue too and
    // that one is never enumerated, `clawai` is served from a two-row literal,
    // and `openrouter`'s REST fetcher never records an authoritative empty — so
    // "every non-default row is a candidate" could not happen while the harm it
    // guards against (default + one connected provider, that one hidden) could.
    //
    // The filter mirrors `AiProviderList`'s, deliberately and with the coupling
    // named: that component decides what the strip shows, and this decides what
    // may be taken away from it. A change to one is a change to both. It cannot
    // be shared as code — this module reads the config off disk and the
    // component is a client one.
    //
    // The chat picker carries the same refusal in its own words
    // (`chat/model/route.ts`, "if every cloud option would go, none does"). This
    // is that rule on the surface that had none.
    const stripHideable = summary.providers
      .filter((row) => (row.state === "connected" || row.state === "needs-reauth")
        && row.section !== "localAi"
        && !row.isDefault)
      .map((row) => row.id);
    const wouldEmptyTheStrip = stripHideable.length > 0
      && stripHideable.every((id) => candidates.includes(id));
    const unrunnable = wouldEmptyTheStrip ? [] : candidates;
    // The rows no provider or channel row will draw. Split here rather than in
    // the panel so the two surfaces cannot disagree about which is which: the
    // badge below and this list are fed from one read and one rule.
    const unattachedRepairs = Object.values(repairs)
      .filter((row) => !pluginHasSettingsRow(row.id))
      .map((row) => ({
        pluginId: row.id,
        stage: row.stage,
        reason: row.reason,
        atMs: row.atMs,
      }));
    return {
      ...summary,
      // ADVISORY, and the rows stay. Dropping them server-side made a hidden
      // provider render in the Connect list with no connection label at all —
      // `statusById` had nothing for it — and took its enable/disable switch
      // with it. The strip does its own hiding (`AiProviderList`), which is
      // where it already filters by state, and every other consumer keeps a
      // complete answer.
      unrunnable,
      ...(unattachedRepairs.length > 0 ? { unattachedRepairs } : {}),
      providers: summary.providers.map((row) => {
        const repair = repairFor(repairs, row.id);
        return {
          ...row,
          enabled: !disabled.has(row.id),
          ...(repair
            ? {
              needsRepair: {
                pluginId: repair.id,
                stage: repair.stage,
                reason: repair.reason,
                atMs: repair.atMs,
              },
            }
            : {}),
        };
      }),
    };
  } catch {
    return { harness, providers: [], defaultProvider: null, unrunnable: [], degraded: true };
  }
}
