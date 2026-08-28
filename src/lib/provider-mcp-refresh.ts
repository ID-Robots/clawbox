import { getModelOptions } from "@/lib/hermes-model-options";
import { reloadMcpServers, reportMcpReloadRefused } from "@/lib/hermes-mcp-reload";

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
    const payload = await getModelOptions();
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

  const moved = `this box can now be switched to ${after.length} provider(s) rather than ${before.length}`;
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
 * `run` has finished, because every one of those paths ends by calling
 * `invalidateModelOptions()` — so the read that follows sees the new catalogue
 * rather than a memo of the old one, and the verdict is RE-READ rather than
 * assumed from the fact that the write returned. Assuming it is the exact shape
 * this round of fixes exists to remove.
 *
 * `run`'s own failure is re-thrown untouched and asks for nothing: a write that
 * did not happen changed no set.
 */
export async function withProviderMcpRefresh<T>(
  run: () => Promise<T>,
  options: ProviderRefreshOptions = {},
): Promise<T> {
  const before = await readUsableProviderIds();
  const result = await run();
  await refreshProviderToolsIfSetChanged(before, await readUsableProviderIds(), options);
  return result;
}
