import { getModelOptions } from "@/lib/hermes-model-options";
import { reloadMcpServers, reportMcpReloadRefused } from "@/lib/hermes-mcp-reload";
import { logSafe } from "@/lib/log-safe";

/**
 * Ask the agent to re-advertise WHICH PROVIDERS it may switch this device to,
 * when a write changed the answer.
 *
 * WHY THIS EXISTS — the fourth of four. `mcp/lib/context.ts` probes this device
 * ONCE while the ClawBox MCP server boots and builds four snapshots off it. Three
 * have already been given a write path that refreshes them: the mailbox read
 * tools (#486), the image tools (#503), the coding-agent family (#514). The
 * fourth is `ctx.providers` (context.ts, from `/setup-api/hermes/models`), and it
 * had none — the only `reloadMcpServers()` callers in the tree were the other
 * three.
 *
 * IT IS NOT ADVISORY. `mcp/tools/ai.ts` makes that snapshot the `provider`
 * parameter's `z.enum` and re-checks it in the handler, and the schema is the
 * validation ("Closed sets are z.enum, never free text: the schema IS the
 * validation, so a wrong value never reaches the device" — mcp/lib/schema.ts).
 * So the owner pastes an Anthropic key, `/setup-api/hermes/provider-key` stores
 * it and drops the catalogue cache because "the panel's very next request must
 * see the provider as usable" — and the long-lived stdio MCP child keeps the enum
 * it was born with. `ai_list_models` reads live and lists the new provider;
 * `ai_set_provider` cannot be handed it and answers "That provider is not set up
 * on this device", advising the agent to call `ai_list_models` — the step that
 * just succeeded. It is #514's shape (the panel updated, the running agent
 * stale) wearing #513's (advice that loops).
 *
 * The mechanism is the agent's own `reload.mcp`, shared with all three siblings —
 * see `hermes-mcp-reload.ts`. What belongs HERE is the rule for when it is worth
 * paying for.
 */

/** @see refreshProviderToolsIfSetChanged */
export interface ProviderRefreshOptions {
  /**
   * True when something else in THIS request already respawned the box's MCP
   * children. The reload is global — it rebuilds every family's tool list — so a
   * second one would buy nothing and cost a second prompt-cache invalidation.
   */
  alreadyReloaded?: boolean;
}

/**
 * How long a snapshot may take before it answers "I could not tell".
 *
 * `getModelOptions()` answers from an in-process SWR cache in the normal case
 * and, on a warm dashboard, in 0.35-0.6 s when it does go out. Its own ceiling is
 * `DASHBOARD_TIMEOUT_MS` (8 s), and this helper is taken TWICE inside a request
 * the owner is holding open — so on a box whose dashboard is down, an unbounded
 * pair could put sixteen seconds in front of a save that has already succeeded.
 * Every helper in this family promises not to make the owner's save worse; this
 * is what that promise costs here. A snapshot that misses the deadline is
 * `null`, the guard declines to act on it, and the tool list catches up at the
 * next restart — the behaviour of every box before this existed.
 */
const SNAPSHOT_TIMEOUT_MS = 3_000;

/** Resolve with `null` rather than wait past the deadline. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The provider ids the MCP server would register its enum from right now, or
 * null when the catalogue could not be read.
 *
 * COMPUTED THE SAME WAY `mcp/lib/context.ts` COMPUTES IT, deliberately: every
 * row Hermes does not explicitly report as credential-less, plus the provider
 * the device is actually on. The two must not drift — a set built to a different
 * rule would either ask for a reload when nothing the agent can see moved (a
 * prompt-cache invalidation the owner did not earn) or stay quiet when it did,
 * which is the bug.
 *
 * `authenticated === null` means the SOURCE could not tell (Hermes' on-disk
 * catalogue and the cold-start floor carry no auth state); those rows are kept,
 * because the MCP server keeps them.
 *
 * THE NULL IS LOAD-BEARING and must never be folded into `[]`: an empty array
 * reads as "this box offers nothing", and the next successful read would then
 * look like a set change on a box nothing had happened to.
 */
export async function readUsableProviderIds(): Promise<string[] | null> {
  try {
    // The promise is NOT abandoned by the deadline — it goes on to populate the
    // catalogue cache, so a box that was merely slow is fast for the read on the
    // other side of the write.
    const payload = await withDeadline(getModelOptions(), SNAPSHOT_TIMEOUT_MS);
    if (!payload) return null;
    const ids = payload.providers
      .filter((row) => typeof row.id === "string" && row.id && row.authenticated !== false)
      .map((row) => row.id);
    // The provider the device is ACTUALLY on is always a legal target, even when
    // it is absent from the credentialed catalogue — the Hermes CLI has
    // meta-providers ("auto") the catalogue never lists, and context.ts seeds
    // this for exactly that reason.
    const current = payload.current?.provider;
    if (typeof current === "string" && current && !ids.includes(current)) ids.push(current);
    return ids;
  } catch {
    // A catalogue read that failed is an ordinary event on a box whose dashboard
    // is down, and this runs on a path whose write has ALREADY happened. "I
    // could not tell" is the honest answer and the guard below refuses to act on
    // it.
    return null;
  }
}

/** Order-insensitive set equality — the enum is a set, not a list. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}

/**
 * What moved, in ids, for the log line.
 *
 * NAMES THEM rather than counting them, because the whole point of the line is
 * to be actionable: "the agent cannot switch to anthropic" is a thing an
 * operator can check, "2 providers rather than 1" is not. Provider ids are
 * Hermes' own public slugs (`anthropic`, `openrouter`, `clawlocal`) — never a
 * credential — and the list is bounded by the catalogue, so it cannot run away.
 */
function describeMove(before: readonly string[], after: readonly string[]): string {
  const had = new Set(before);
  const has = new Set(after);
  const gained = after.filter((id) => !had.has(id));
  const lost = before.filter((id) => !has.has(id));
  const parts: string[] = [];
  if (gained.length > 0) parts.push(`gained ${gained.join(", ")}`);
  if (lost.length > 0) parts.push(`lost ${lost.join(", ")}`);
  // Bounded HERE, not at one of the three lines that write it. The list's
  // length is the catalogue's, not this module's, and `reportMcpReloadRefused`
  // bounding its own arm left the two success lines — the ones a healthy box
  // actually writes — carrying the whole of it.
  return logSafe(`the providers this box can be switched to ${parts.join(" and ")}`);
}

/**
 * Reload the MCP servers, but ONLY if this request changed which providers the
 * agent may be handed.
 *
 * The guard is the important half, for the same reason it is in every sibling: a
 * reload kills and respawns every MCP child and invalidates the model's prompt
 * cache, so the next turn re-sends and re-pays for a system prompt that was
 * cached. Re-pasting a key the device already had, or saving a tier, changes
 * nothing the agent can see and must cost nothing.
 *
 * BOTH DIRECTIONS. A set that SHRANK is the same bug pointing the other way —
 * an enum still offering a provider the device no longer serves, which
 * `/setup-api/hermes/models` answers with "Unknown provider".
 *
 * Never throws and never reports to the caller. The credential IS stored by the
 * time this runs, an OpenClaw box has no dashboard to ask at all, and a box whose
 * dashboard is down must not have the owner's save turned into an error by a
 * best-effort refresh: the tool list catches up at the next restart, which is
 * exactly the behaviour of every box before this existed.
 *
 * @param before what `readUsableProviderIds()` said BEFORE the write, or null
 *               when it could not be read
 * @param after  what it says after — the same catalogue `/setup-api/hermes/models`
 *               serves the panel, so the agent's enum and the owner's picker
 *               cannot disagree about what this box can be switched to
 * @param options see `ProviderRefreshOptions`
 * @returns true when the box's MCP children were respawned for this change — by
 *          this call or by the one that already had. A caller that moves another
 *          family in the same request passes it on so the second family does not
 *          pay for a second global reload.
 */
export async function refreshProviderToolsIfSetChanged(
  before: readonly string[] | null,
  after: readonly string[] | null,
  options: ProviderRefreshOptions = {},
): Promise<boolean> {
  if (before === null || after === null) return options.alreadyReloaded === true;
  if (sameSet(before, after)) return options.alreadyReloaded === true;

  const moved = describeMove(before, after);
  if (options.alreadyReloaded) {
    // Nothing to ask for: the respawn that already happened in this request
    // rebuilt EVERY family's tool list, this one included.
    console.log(`[hermes/provider-refresh] ${moved}; the MCP servers were already reloaded for this change`);
    return true;
  }
  // `.catch` even though `reloadMcpServers` documents that it never throws: the
  // "never throws" above is a promise made to the OWNER'S SAVE, which has already
  // been written by the time this runs, and it must not depend on a neighbouring
  // module keeping its own promise.
  if (!(await reloadMcpServers().catch(() => false))) {
    // Logged, not surfaced, and in the words that are true for this edition — an
    // OpenClaw box has no dashboard to ask and needs no repair.
    await reportMcpReloadRefused("hermes/provider-refresh", moved);
    return false;
  }
  console.log(`[hermes/provider-refresh] ${moved}; asked the agent to reload its MCP servers`);
  return true;
}

/**
 * Snapshot → write → snapshot → reload iff the set moved, around any write that
 * can change which providers this device offers.
 *
 * The wrapper exists so the SIX write paths that move this set cannot each get
 * the ordering subtly different. The "after" read is deliberately taken AFTER
 * `run` has finished, because every one of those paths calls
 * `invalidateModelOptions()` BEFORE IT RETURNS — the local-AI removal does it in
 * a `finally` around its own write, so a proof that then refuses cannot leave
 * the memo standing — so the read that follows sees the new catalogue
 * rather than a memo of the old one, and the verdict is RE-READ rather than
 * assumed from the fact that the write returned. Assuming it is the exact shape
 * this round of fixes exists to remove.
 *
 * `run`'s own failure is re-thrown untouched, but the comparison still happens —
 * IN A `finally`, because "the write threw" is not the same as "nothing was
 * written". `applyCloudProviderKeyToHermes` stores the credential with
 * `hermes auth add` and only THEN tries to select a provider and a model, either
 * of which can throw; the provider is credentialed by that point and the agent's
 * enum is already stale. Reconciling only on success is exactly the
 * sibling-left-unguarded shape this PR exists to close, one level up. A write
 * that genuinely stored nothing costs nothing here: the sets match and the guard
 * returns without asking for anything.
 */
export async function withProviderMcpRefresh<T>(
  run: () => Promise<T>,
  options: ProviderRefreshOptions = {},
): Promise<T> {
  const before = await readUsableProviderIds();
  try {
    return await run();
  } finally {
    await refreshProviderToolsIfSetChanged(before, await readUsableProviderIds(), options);
  }
}
