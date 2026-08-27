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
import { hasClawaiToken } from "@/lib/harness/credentials";
import { readConfig } from "@/lib/openclaw-config";
import { get as getConfigValue } from "@/lib/config-store";
import {
  CLAWAI_PROVIDER,
  HERMES_PANEL_PROVIDERS,
  hermesProviderLabel,
} from "@/lib/hermes-providers";
import { getModelOptions } from "@/lib/hermes-model-options";

/**
 * What the strip paints, and the only four things it may say.
 *
 * `needs-reauth` is NOT a guess. It is the one genuinely diagnosable failure:
 * the box is POINTED AT this provider as its default and cannot authenticate to
 * it. That state is invisible today and is exactly the one worth a distinct
 * colour, because chat is broken until it is fixed. Anything else we cannot
 * tell apart from "never set up" gets `disconnected`, and anything we could not
 * ask about at all gets `unknown` rather than a cheerful default.
 */
export type ProviderConnectionState =
  | "connected"
  | "disconnected"
  | "needs-reauth"
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
   * Which Settings section configures this row, so a click on the chip lands
   * where the fix is. Local engines are configured in their own section and
   * saying "AI Provider" for them would send the user to a panel that cannot
   * change them.
   */
  section: "ai" | "localAi";
}

export interface ProviderStatusSummary {
  harness: Harness;
  providers: ProviderStatusRow[];
  /** The default provider's id, or null when the box has none yet. */
  defaultProvider: string | null;
  /**
   * True when the answer came from a fallback rather than from the live box —
   * a Hermes dashboard that did not respond, or an unreadable config. The strip
   * says so rather than painting a stale answer as fact.
   */
  degraded: boolean;
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
 * Collapse the wire spellings of one vendor onto one id, so a provider cannot
 * appear twice in a strip whose whole job is to be scannable. Mirrors the
 * normaliser `/setup-api/ai-models/status` already uses; kept in step with it
 * deliberately, because a row the two disagreed about would show as connected
 * in one place and absent in the other.
 */
function normalizeOpenclawProvider(provider: string | null | undefined): string | null {
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

function sectionFor(id: string): "ai" | "localAi" {
  return LOCAL_PROVIDER_IDS.has(id) ? "localAi" : "ai";
}

/**
 * The one place the four states are decided, so the two harness paths cannot
 * drift into disagreeing about what "connected" means.
 *
 * `credentialed === null` means the source could not tell us (Hermes' on-disk
 * catalogue carries no auth state), which is `unknown` — never `disconnected`.
 * Painting "not connected" over a provider we simply failed to ask about is the
 * failure mode most likely to send someone to re-enter a key that was fine.
 */
function stateFor(credentialed: boolean | null, isDefault: boolean): ProviderConnectionState {
  if (credentialed === true) return "connected";
  if (credentialed === null) return "unknown";
  return isDefault ? "needs-reauth" : "disconnected";
}

/**
 * Hermes: the live dashboard already answers this for every provider at once
 * (`authenticated` per row) and `getModelOptions` is the memoised reader for
 * it, so the aggregate costs no more than the panel's own existing load.
 */
async function readHermesStatus(): Promise<ProviderStatusSummary> {
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

  // Did the live dashboard actually answer? `stale` is set on every fallback
  // path (dashboard down, disk-catalog cold start). It draws the line between
  // "we asked and ClawBox AI is simply not linked" (disconnected) and "we could
  // not ask at all" (unknown) — the ONLY case ClawBox AI is still allowed to be
  // unknown, because its link state is otherwise fully knowable from our own
  // stores.
  const probeAnswered = !payload.stale;

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
      state: stateFor(credentialed, isDefault),
      isDefault,
      section: sectionFor(id),
    };
  });

  return { harness: "hermes", providers, defaultProvider, degraded: payload.stale };
}

/**
 * OpenClaw: `openclaw.json` is the whole answer. A provider is connected when
 * the gateway holds an auth profile for it or a key under its provider
 * definition — the same two places `/setup-api/chat/model` builds its dropdown
 * from, so the strip and the chat can never disagree about who is available.
 */
async function readOpenclawStatus(): Promise<ProviderStatusSummary> {
  const config = await readConfig();
  const profiles = config.auth?.profiles ?? {};
  const definitions = config.models?.providers ?? {};

  const credentialed = new Set<string>();
  for (const [profileKey, entry] of Object.entries(profiles)) {
    const id = normalizeOpenclawProvider(entry?.provider ?? profileKey.split(":")[0]);
    if (id) credentialed.add(id);
  }
  for (const [wireId, definition] of Object.entries(definitions)) {
    const key = (definition as { apiKey?: unknown })?.apiKey;
    if (typeof key !== "string" || !key.trim()) continue;
    const id = normalizeOpenclawProvider(wireId);
    if (id) credentialed.add(id);
  }
  // The ClawBox AI credential can live in the config store instead of the
  // config file (a box migrated from a Hermes install), and `hasClawaiToken`
  // is the helper that knows both homes.
  if (await hasClawaiToken()) credentialed.add("clawai");

  const primary = config.agents?.defaults?.model?.primary ?? null;
  const defaultProvider = normalizeOpenclawProvider(primary ? primary.split("/")[0] : null);

  const rows: { id: string; label: string }[] = [...OPENCLAW_PANEL_PROVIDERS];

  // The configured local engine, when there is one. It belongs in a strip
  // titled "what is connected" even though it is configured elsewhere — the
  // `section` field is what keeps a click on it honest.
  const storedLocal = await getConfigValue("local_ai_provider").catch(() => null);
  const localProvider = normalizeOpenclawProvider(
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
      state: stateFor(credentialed.has(id), isDefault),
      isDefault,
      section: sectionFor(id),
    };
  });

  return { harness: "openclaw", providers, defaultProvider, degraded: false };
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
    return harness === "hermes" ? await readHermesStatus() : await readOpenclawStatus();
  } catch {
    return { harness, providers: [], defaultProvider: null, degraded: true };
  }
}
