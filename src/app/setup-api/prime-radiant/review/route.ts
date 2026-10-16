/**
 * /setup-api/prime-radiant/review — the review queue.
 *
 * GET `?status=open|later|resolved|all&kind=&claimId=&offset&limit` →
 * `{ total, counts: { open, later, resolved }, items }`, newest first
 * (default `open`). Never creates the state database.
 *
 * POST `{ kind?, claimId?, pages?, candidates?: [{ text, page?, claimId?,
 * evidence? }], note? }` — raise an item by hand (a fact someone disputes):
 * 201 `{ item }`, or 200 `{ item, created: false }` when the same question is
 * already waiting. The owner's session OR the MCP bearer (the assistant may
 * flag a fact; only the owner settles one), from our own page; 412
 * `not_initialised` before the vault exists.
 */
import { requireSession } from "@/lib/route-auth";
import { vaultDir } from "@/lib/prime-radiant/paths";
import { createReviewItem, ReviewError } from "@/lib/prime-radiant/review";
import { listReviewItems, REVIEW_KINDS, REVIEW_STATUSES, type ReviewKind, type ReviewStatus } from "@/lib/prime-radiant/review-store";
import { isClaimId } from "@/lib/prime-radiant/claims";
import { hasPersonSession } from "@/lib/owner-session";
import { crossOriginRefusal, fail, json, readJsonBody, vaultFailure } from "@/lib/prime-radiant/route-helpers";
import { vaultInitialised } from "@/lib/prime-radiant/vault";

export const dynamic = "force-dynamic";

function int(v: string | null): number | undefined {
  if (v === null || !/^\d{1,6}$/.test(v)) return undefined;
  return Number(v);
}

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const q = new URL(req.url).searchParams;
  const status = q.get("status") ?? "open";
  if (status !== "all" && !(REVIEW_STATUSES as readonly string[]).includes(status)) return fail("invalid", "Unknown status.", 400);
  const kind = q.get("kind");
  if (kind !== null && !(REVIEW_KINDS as readonly string[]).includes(kind)) return fail("invalid", "Unknown kind.", 400);
  const claimId = q.get("claimId");
  if (claimId !== null && !isClaimId(claimId)) return fail("invalid", "That is not a claim id.", 400);
  try {
    return json(
      listReviewItems(vaultDir(), {
        status: status as ReviewStatus | "all",
        kind: (kind as ReviewKind | null) ?? undefined,
        claimId: claimId ?? undefined,
        offset: int(q.get("offset")),
        limit: int(q.get("limit")),
      }),
    );
  } catch (err) {
    return vaultFailure("review list", err);
  }
}

export async function POST(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const crossed = crossOriginRefusal(req);
  if (crossed) return crossed;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  if (!(await vaultInitialised())) return fail("not_initialised", "Open Prime Radiant once to create its vault first.", 412);
  try {
    const by = (await hasPersonSession(req)) ? "owner" : "assistant";
    const { item, created } = createReviewItem(read.body, { by });
    return json(created ? { item } : { item, created: false }, created ? 201 : 200);
  } catch (err) {
    if (err instanceof ReviewError) return fail(err.code, err.message, err.status);
    return vaultFailure("review create", err);
  }
}
