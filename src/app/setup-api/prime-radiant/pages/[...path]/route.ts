/**
 * /setup-api/prime-radiant/pages/<vault path>
 *
 * GET — one page: frontmatter (or why it does not parse), body, summary,
 * backlinks, outbound links and its scoped lint. With `?view=summary`, only
 * `{ path, summary }`: the page in a few sentences for the Map's card, read
 * from that page alone. Owner-only. A path that is not a knowledge page
 * answers 404 exactly like a missing one.
 *
 * PATCH `{ title?, summary?, body?, status?, domain?, owner?, privacy?,
 * stale_after?, as_of?, sources? }` — edit it (its claims are the `claims` routes'):
 * `{ path, commit, changed, findings }`, one commit `edit: <path>` (none when
 * nothing differed). DELETE — remove it and its index.md line: `{ path,
 * commit, claims, verified }`, one commit `delete: <path>`. Both: the owner,
 * or the assistant through the MCP bearer (its commit names it), from our own
 * page; 404 `not_found`, 400 `invalid`, 409 `invalid_page` / `verified` /
 * `lint_blocked`, 412 `not_initialised`.
 *
 * POST /setup-api/prime-radiant/pages/merge `{ into, from: [1..20], dry_run?,
 * keep_into_body? }` — fold duplicate pages into `into` (edit.ts
 * `mergePages`): one commit `merge: <from, …> -> <into>`, or with `dry_run:
 * true` the same answer and no commit. `into`'s body stays byte for byte
 * unless `keep_into_body: false`. `{ into, from, dryRun, commit, claims, verified, aliases, sources,
 * privacy, notes, relinked, links, indexLines, unparsed, reviewItems,
 * findings }`. The same writers as PATCH; 404 `not_found`, 400 `invalid`
 * (into itself), 409 `deprecated` / `verified` / `taken` / `retired` /
 * `too_many_claims` / `too_long` / `into_links` / `invalid_page` /
 * `lint_blocked`, 412
 * `not_initialised`.
 *
 * POST /setup-api/prime-radiant/pages/bulk `{ edits: [1..500 of { path,
 * domain?, owner?, privacy?, status? }], dry_run? }` — set metadata on many
 * pages at once (edit.ts `bulkEditPages`): ONE commit `bulk: N pages`, or
 * with `dry_run: true` the same answer and no commit. `{ changed, unchanged,
 * refused: [{ path, code, error }], commit, dryRun }`: a page its own PATCH
 * would refuse (`not_found`, `invalid`, `invalid_page`, `verified`,
 * `lint_blocked`) is listed in `refused` and the others still change. The
 * same writers as PATCH; 400 `invalid` for the request's own shape, 413 past
 * 512 KB, 412 `not_initialised`.
 *
 * Both are answered here rather than from a `merge/` or `bulk/` folder, which
 * would take GET, PATCH and DELETE of a page at `merge.md` or `bulk.md` from
 * this route; a POST to any other page path is 405.
 */
import { requireSession } from "@/lib/route-auth";
import { bulkEditPages, deletePage, editPage, mergePages, readPageBulk, readPageMerge, readPagePatch } from "@/lib/prime-radiant/edit";
import { getPage, getPageBlurb } from "@/lib/prime-radiant/service";
import { editFailure, fail, json, readJsonBody, vaultFailure, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Params) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const { path: segments } = await params;
  const rel = (segments ?? []).join("/");
  try {
    const page = new URL(req.url).searchParams.get("view") === "summary" ? await getPageBlurb(rel) : await getPage(rel);
    if (!page) return fail("not_found", "No such page.", 404);
    return json(page);
  } catch (err) {
    return vaultFailure("page", err);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  const gate = await writerGuard(req, "Editing a page");
  if (!gate.ok) return gate.response;
  const rel = ((await params).path ?? []).join("/");
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    return json(await editPage(rel, readPagePatch(read.body), gate.writer));
  } catch (err) {
    return editFailure("page edit", err);
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const gate = await writerGuard(req, "Deleting a page");
  if (!gate.ok) return gate.response;
  const rel = ((await params).path ?? []).join("/");
  try {
    return json(await deletePage(rel, gate.writer));
  } catch (err) {
    return editFailure("page delete", err);
  }
}

/** A bulk edit's body: 500 edits with long paths and owners still fit. */
const MAX_BULK_BODY_BYTES = 512 * 1024;

export async function POST(req: Request, { params }: Params) {
  const segments = (await params).path ?? [];
  if (segments.length === 1 && segments[0] === "bulk") return bulkPOST(req);
  if (segments.length !== 1 || segments[0] !== "merge") {
    return fail("method_not_allowed", "Pages are created with POST pages, merged with POST pages/merge and edited in bulk with POST pages/bulk.", 405);
  }
  const gate = await writerGuard(req, "Merging pages");
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    return json(await mergePages(readPageMerge(read.body), gate.writer));
  } catch (err) {
    return editFailure("page merge", err);
  }
}

async function bulkPOST(req: Request) {
  const gate = await writerGuard(req, "Editing pages in bulk");
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(req, MAX_BULK_BODY_BYTES);
  if (!read.ok) return read.response;
  try {
    return json(await bulkEditPages(readPageBulk(read.body), gate.writer));
  } catch (err) {
    return editFailure("page bulk edit", err);
  }
}
