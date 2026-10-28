// ── Follow the provider's newest model, unless the owner chose one ──────────
//
// The owner's ruling (TASK-713) is that a default fills a gap and never
// overwrites a choice. For a provider whose default is "the newest model"
// (src/lib/provider-newest-model.ts) that default MOVES — xAI publishes Grok
// 4.8 and the newest is no longer 4.7 — and a box that took the default should
// move with it, while a box whose owner picked a model stays where it was put.
//
// So after every live enumeration of such a provider (the catalog route's
// publish: at sign-in, after any provider change, and on the periodic refresh),
// this pass asks three things and moves the chat only when all say yes:
//
//   * is the chat ON this provider? A box chatting with Claude is not moved to
//     Grok because xAI shipped something;
//   * did the owner never pick a model of it? The explicit-pick record
//     (src/lib/explicit-model-pick.ts) is the only thing that can say so — the
//     header picker records every manual pick, and the configure route records
//     a named model unless it is the default the picker preselected;
//   * is there a newer flagship than the one it is on, which this account has
//     not been refused on (src/lib/provider-model-availability.ts)?
//
// The move itself is the header picker's own switch, flagged automatic, so no
// pick is recorded and the next release moves the box again.

import { readExplicitModelPicks, type ExplicitModelPicks } from "@/lib/explicit-model-pick";
import { readUnavailableModelIds } from "@/lib/provider-model-availability";
import { flagshipVersion, followsNewestModel, newestModelId, type NewestModelCandidate } from "@/lib/provider-newest-model";
import { readPrimaryModelRef, switchChatModelAutomatically } from "@/lib/automatic-model-switch";

export interface FollowNewestDeps {
  readPrimary(): Promise<string | null>;
  readPicks(): Promise<ExplicitModelPicks>;
  readUnavailable(provider: string): Promise<Set<string>>;
  switchModel(ref: string): Promise<boolean>;
}

export type FollowNewestResult =
  | { moved: true; from: string; to: string }
  | { moved: false; why: "not-following" | "not-on-provider" | "owner-picked" | "already-newest" | "not-a-flagship" | "switch-failed" | "no-newest" };

/**
 * Move the chat to `provider`'s newest model when it took the default and a
 * newer one has appeared. `models` is the enumeration just published.
 */
export async function followNewestModel(
  provider: string,
  models: readonly NewestModelCandidate[],
  deps: FollowNewestDeps,
): Promise<FollowNewestResult> {
  if (!followsNewestModel(provider)) return { moved: false, why: "not-following" };
  const primary = (await deps.readPrimary())?.trim() ?? "";
  const prefix = `${provider}/`;
  if (!primary.toLowerCase().startsWith(prefix)) return { moved: false, why: "not-on-provider" };
  const current = primary.slice(prefix.length);
  const picks = await deps.readPicks();
  if (Object.hasOwn(picks, provider)) return { moved: false, why: "owner-picked" };
  const unavailable = await deps.readUnavailable(provider);
  const newest = newestModelId(provider, models, unavailable);
  if (!newest) return { moved: false, why: "no-newest" };
  if (newest === current) return { moved: false, why: "already-newest" };
  // A row that is not a plain generational model (a `-fast` variant, a dated
  // snapshot) got there some other way than the default, even without a
  // recorded pick — an older build, the core's own picker. Left alone, unless
  // the account cannot run it, which no choice survives.
  if (!flagshipVersion(provider, current) && !unavailable.has(current)) return { moved: false, why: "not-a-flagship" };
  const to = `${prefix}${newest}`;
  if (!(await deps.switchModel(to))) return { moved: false, why: "switch-failed" };
  console.log(`[follow-newest] ${provider}: the chat followed the newest model, ${primary} -> ${to}`);
  return { moved: true, from: primary, to };
}

/** The pass with the box's own readers and the header picker's switch. Never throws. */
export async function followNewestModelOnBox(provider: string, models: readonly NewestModelCandidate[]): Promise<FollowNewestResult | null> {
  try {
    return await followNewestModel(provider, models, {
      readPrimary: readPrimaryModelRef,
      readPicks: readExplicitModelPicks,
      readUnavailable: (p) => readUnavailableModelIds(p),
      switchModel: switchChatModelAutomatically,
    });
  } catch (err) {
    console.warn(`[follow-newest] ${provider}: could not follow the newest model:`, err instanceof Error ? err.message : err);
    return null;
  }
}
