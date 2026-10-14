/**
 * Settling a review item: what `POST review/<id>/resolve` does.
 *
 *   pick    — candidate `n` is the true answer: verified under the item's
 *             claim id; every OTHER candidate's claim id is retired (see
 *             verify.ts). One commit, `verify: <claimId>`.
 *   new     — none of them: the owner's own text is verified, every
 *             candidate's id retired.
 *   later   — put off; the item stays in the queue as `later`.
 *   dismiss — nothing to change; resolved with no commit.
 *
 * Resolutions are serialised (one at a time per process), so two tabs
 * pressing "pick" on the same item verify once: the second finds the item
 * already resolved.
 *
 * SERVER ONLY.
 */

import { processStore } from "@/lib/process-store";
import { createSerialLock, type SerialLock } from "@/lib/serial-lock";
import { isClaimId } from "./claims";
import { vaultDir } from "./paths";
import { notifyVaultChanged } from "./reindex-hook";
import {
  addReviewItem,
  cleanCandidates,
  closeItemsForRetired,
  getReviewItem,
  REVIEW_KINDS,
  settleReviewItem,
  type ReviewItem,
  type ReviewKind,
  type ReviewResolution,
} from "./review-store";
import type { ClaimEvidence } from "./schema";
import { cleanVerifiedText, MAX_VERIFIED_TEXT, verifyClaim, VerifyError } from "./verify";

export type ResolveAction =
  | { action: "pick"; candidate: number }
  | { action: "new"; text: string; page?: string | null }
  | { action: "later" }
  | { action: "dismiss" };

export class ReviewError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "already_resolved" | "no_claim" | "verify_failed",
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

/** A resolve body read strictly. Throws {@link ReviewError} `invalid`. */
export function readResolveAction(body: unknown): ResolveAction {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  switch (b.action) {
    case "pick":
      if (typeof b.candidate !== "number" || !Number.isInteger(b.candidate) || b.candidate < 0) {
        throw new ReviewError("invalid", "Name the candidate to keep by its number.", 400);
      }
      return { action: "pick", candidate: b.candidate };
    case "new": {
      const text = cleanVerifiedText(b.text);
      if (!text) throw new ReviewError("invalid", `Write the fact as one line of 1 to ${MAX_VERIFIED_TEXT} characters.`, 400);
      return { action: "new", text, page: typeof b.page === "string" ? b.page : null };
    }
    case "later":
      return { action: "later" };
    case "dismiss":
      return { action: "dismiss" };
    default:
      throw new ReviewError("invalid", "action must be pick, new, later or dismiss.", 400);
  }
}

const lockStore = processStore("prime-radiant:review-lock", () => ({ lock: createSerialLock() as SerialLock }));

export interface ResolveResult {
  item: ReviewItem;
  commit: string | null;
  retired: string[];
}

export async function resolveReviewItem(
  id: string,
  action: ResolveAction,
  options: { by: string; vault?: string; now?: Date } = { by: "owner" },
): Promise<ResolveResult> {
  const vault = options.vault ?? vaultDir();
  return lockStore.lock(async () => {
    const item = getReviewItem(vault, id);
    if (!item) throw new ReviewError("not_found", "No such review item.", 404);
    if (item.status === "resolved") throw new ReviewError("already_resolved", "That item was already resolved.", 409);
    const at = (options.now ?? new Date()).toISOString();

    if (action.action === "later" || action.action === "dismiss") {
      const resolution: ReviewResolution = { action: action.action, by: options.by };
      settleReviewItem(vault, id, action.action === "later" ? "later" : "resolved", resolution, at);
      return { item: getReviewItem(vault, id) ?? item, commit: null, retired: [] };
    }

    if (!item.claimId) throw new ReviewError("no_claim", "This item is not about one claim; dismiss it once it is dealt with.", 409);
    let text: string;
    let evidence: ClaimEvidence[] = [];
    let page: string | null = null;
    if (action.action === "pick") {
      const chosen = item.candidates[action.candidate];
      if (!chosen) throw new ReviewError("invalid", "There is no candidate with that number.", 400);
      const cleaned = cleanVerifiedText(chosen.text);
      if (!cleaned) throw new ReviewError("invalid", `That candidate is longer than ${MAX_VERIFIED_TEXT} characters; write it as a new answer.`, 400);
      text = cleaned;
      evidence = chosen.evidence.map((e) => ({ kind: e.kind, ...(e.page ? { path: e.page } : {}), ...(e.note ? { note: e.note } : {}) }));
      page = chosen.claimId === item.claimId ? chosen.page : null;
    } else {
      text = action.text;
      page = action.page ?? null;
    }
    // Every other id a candidate was filed under loses: the fact lives on under
    // the item's claim id alone (also when the winning text came from another id).
    const retire = item.candidates.map((c) => c.claimId).filter((cid): cid is string => isClaimId(cid) && cid !== item.claimId);
    let verified;
    try {
      verified = await verifyClaim({
        claimId: item.claimId,
        text,
        by: options.by,
        retire,
        page: page ?? item.pages[0] ?? null,
        evidence,
        note: `verified by ${options.by} from review ${item.id}`,
        vault,
        now: options.now,
      });
    } catch (err) {
      if (err instanceof VerifyError) {
        throw new ReviewError(err.code === "invalid" ? "invalid" : "verify_failed", err.message, err.code === "invalid" ? 400 : 409);
      }
      throw err;
    }
    const resolution: ReviewResolution = {
      action: action.action,
      text,
      ...(action.action === "pick" ? { candidate: action.candidate } : {}),
      commit: verified.commit,
      retired: verified.retired,
      by: options.by,
    };
    settleReviewItem(vault, id, "resolved", resolution, at);
    // Items still waiting on a claim this verification retired ask about nothing now.
    try {
      closeItemsForRetired(vault, verified.retired, options.by, at);
    } catch {
      /* they can be dismissed by hand */
    }
    await notifyVaultChanged(verified.changed);
    return { item: getReviewItem(vault, id) ?? item, commit: verified.commit, retired: verified.retired };
  });
}

/** A review item a caller raises by hand (`POST review`), read strictly. */
export function readNewItem(body: unknown): {
  kind: ReviewKind;
  claimId: string | null;
  pages: string[];
  candidates: ReturnType<typeof cleanCandidates>;
  note: string | null;
} {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const kind = b.kind ?? "contradiction";
  if (typeof kind !== "string" || !(REVIEW_KINDS as readonly string[]).includes(kind)) {
    throw new ReviewError("invalid", `kind must be one of ${REVIEW_KINDS.join(", ")}.`, 400);
  }
  if (b.claimId !== undefined && b.claimId !== null && !isClaimId(b.claimId)) throw new ReviewError("invalid", "claimId is not a claim id.", 400);
  if (b.pages !== undefined && !Array.isArray(b.pages)) throw new ReviewError("invalid", "pages must be a list.", 400);
  if (b.candidates !== undefined && !Array.isArray(b.candidates)) throw new ReviewError("invalid", "candidates must be a list.", 400);
  const candidates = cleanCandidates((b.candidates as unknown[] | undefined) ?? []);
  const pages = ((b.pages as unknown[] | undefined) ?? []).filter((p): p is string => typeof p === "string");
  const claimId = isClaimId(b.claimId) ? b.claimId : null;
  if (!claimId && candidates.length === 0 && pages.length === 0) {
    throw new ReviewError("invalid", "Say what the item is about: a claim, a page or candidates.", 400);
  }
  const note = typeof b.note === "string" && b.note.trim() !== "" ? b.note.trim().slice(0, 500) : null;
  return { kind: kind as ReviewKind, claimId, pages, candidates, note };
}

export function createReviewItem(body: unknown, options: { by: string; vault?: string; now?: Date }): { item: ReviewItem; created: boolean } {
  const input = readNewItem(body);
  const vault = options.vault ?? vaultDir();
  return addReviewItem(
    vault,
    {
      kind: input.kind,
      claimId: input.claimId,
      pages: input.pages,
      candidates: input.candidates,
      evidence: [{ kind: "raised-by", source: options.by, ...(input.note ? { note: input.note } : {}) }],
      dedupeKey: input.claimId ? `manual:${input.kind}:${input.claimId}` : null,
    },
    (options.now ?? new Date()).toISOString(),
  );
}
