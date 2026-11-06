// ── Which model is a provider's newest, from the provider's own answer ──────
//
// WHY IT EXISTS. The xAI picker shipped `grok-4.6` as its default, by hand, and
// a box kept landing on it after xAI published Grok 4.7 — on one account the
// older model even had no quota at all (a 429 stating a limit of 0/0) while the
// newer one answered in a second. A hand-written default is the same defect as
// a hand-written list, one model later every time the provider ships.
//
// So for a provider that opts in here, the default is not a constant: it is
// the newest FLAGSHIP chat model in the list the box enumerated, ranked by the
// provider's own metadata — a creation date when the row carries one, and
// otherwise the version the provider wrote into the id. The enumeration is the
// harness's own (`openclaw models list --provider <p> --all --json --refresh`,
// which on the pinned core asks the provider's /v1/models with the box's
// credential, API key or sign-in alike), so a model the provider publishes
// tomorrow is the default tomorrow, with no ClawBox release in between.
//
// WHY "FLAGSHIP" AND NOT "NEWEST ROW". A provider's list carries variants next
// to the model they vary — `-fast`, `-mini`, `-latest` aliases, dated
// snapshots, multi-agent and coding builds — and the newest of those is not
// what a chat should land on. Each policy says which ids are the plain
// generational model and what version they carry; everything else stays in the
// list, below the flagships, and is never picked as a default.
//
// Pure and client-safe: the catalog route, the configure and chat-model routes,
// the follow-newest pass and the chat's fallback all rank through this one
// file, so they cannot disagree about which model is newest.

/** The fields a ranking reads. Every catalogue row this box serves has them. */
export interface NewestModelCandidate {
  id: string;
  /** Epoch ms the provider says the model was created, when the row carries it. */
  createdAt?: number;
  /** The harness tagged this row `default` for its provider. */
  isDefault?: boolean;
}

interface NewestModelPolicy {
  /**
   * The version a FLAGSHIP chat id carries, newest = largest, or null for any
   * other row: a variant, an alias, a dated snapshot, a non-chat model.
   */
  flagshipVersion(id: string): number[] | null;
}

/**
 * xAI: the generational Grok ids are `grok-<major>[.<minor>]` and nothing more
 * — `grok-4.7`, `grok-4.6`, `grok-4.5`, `grok-4.3` on the pinned core's
 * manifest, `grok-5` the day it ships. The suffixed rows of the same list
 * (`grok-4.20-0309-reasoning`, `grok-4-fast`, `grok-4.7-latest`,
 * `grok-build-0.1`, `grok-4.20-multi-agent-0309`) are not flagships, and the
 * one that matters most is the first: read as a bare version, "4.20" would
 * outrank 4.7, while xAI ships it as an older dated release.
 */
const XAI_FLAGSHIP_RE = /^grok-(\d{1,3}(?:\.\d{1,3}){0,2})$/;

const POLICIES: Readonly<Record<string, NewestModelPolicy>> = {
  xai: {
    flagshipVersion(id) {
      const match = XAI_FLAGSHIP_RE.exec(id.trim().toLowerCase());
      return match ? match[1].split(".").map(Number) : null;
    },
  },
};

/**
 * The providers whose default follows the newest model. Wired: xAI. The others
 * the catalog layer serves (DeepSeek through ClawBox AI, OpenAI, Anthropic,
 * Google) need only a policy here — see the PR report for what each is missing.
 */
export const NEWEST_MODEL_PROVIDERS: readonly string[] = Object.freeze(Object.keys(POLICIES));

export function followsNewestModel(provider: string | null | undefined): boolean {
  const id = provider?.trim().toLowerCase();
  return !!id && Object.hasOwn(POLICIES, id);
}

function policyFor(provider: string | null | undefined): NewestModelPolicy | null {
  const id = provider?.trim().toLowerCase();
  return id && Object.hasOwn(POLICIES, id) ? POLICIES[id] : null;
}

/** The version a flagship id carries for this provider, or null. */
export function flagshipVersion(provider: string | null | undefined, id: string): number[] | null {
  return policyFor(provider)?.flagshipVersion(id) ?? null;
}

function compareVersionsDescending(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const created = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/**
 * Newest first: by creation date when BOTH rows carry one, else by version.
 * A tie keeps the harness's own `default` first, then the id, so the order is
 * stable from one enumeration to the next.
 */
function compareFlagships(
  a: { row: NewestModelCandidate; version: number[] },
  b: { row: NewestModelCandidate; version: number[] },
): number {
  const aCreated = created(a.row.createdAt);
  const bCreated = created(b.row.createdAt);
  if (aCreated !== null && bCreated !== null && aCreated !== bCreated) return bCreated - aCreated;
  const byVersion = compareVersionsDescending(a.version, b.version);
  if (byVersion !== 0) return byVersion;
  if (!!a.row.isDefault !== !!b.row.isDefault) return a.row.isDefault ? -1 : 1;
  return a.row.id.localeCompare(b.row.id);
}

/**
 * The list as a picker should read it: the provider's flagships newest first,
 * then every other row in the order it came. A provider without a policy gets
 * its list back unchanged.
 */
export function rankNewestFirst<T extends NewestModelCandidate>(provider: string | null | undefined, models: readonly T[]): T[] {
  const policy = policyFor(provider);
  if (!policy) return [...models];
  const flagships: { row: T; version: number[] }[] = [];
  const rest: T[] = [];
  for (const row of models) {
    const version = policy.flagshipVersion(row.id);
    if (version) flagships.push({ row, version });
    else rest.push(row);
  }
  flagships.sort(compareFlagships);
  return [...flagships.map((f) => f.row), ...rest];
}

/**
 * The provider's newest flagship among `models`, skipping any id in
 * `unavailable` (a model this account was refused on). Null when the provider
 * has no policy or the list holds no usable flagship — the caller then keeps
 * its own default rule, which is the point of null.
 */
export function newestModelId(
  provider: string | null | undefined,
  models: readonly NewestModelCandidate[],
  unavailable: ReadonlySet<string> = new Set(),
): string | null {
  const policy = policyFor(provider);
  if (!policy) return null;
  const usable = models.filter((m) => !unavailable.has(m.id));
  const [first] = rankNewestFirst(provider, usable);
  return first && policy.flagshipVersion(first.id) ? first.id : null;
}

/**
 * Where a turn goes when `failedId` cannot run on this account: the newest
 * flagship that is neither it nor already known to be unavailable. Null when
 * there is none, which the caller says rather than guesses.
 */
export function fallbackModelId(
  provider: string | null | undefined,
  models: readonly NewestModelCandidate[],
  failedId: string,
  unavailable: ReadonlySet<string> = new Set(),
): string | null {
  return newestModelId(provider, models, new Set([...unavailable, failedId]));
}
