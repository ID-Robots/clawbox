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
 * stale_after?, sources? }` — edit it (its claims are the `claims` routes'):
 * `{ path, commit, changed, findings }`, one commit `edit: <path>` (none when
 * nothing differed). DELETE — remove it and its index.md line: `{ path,
 * commit, claims, verified }`, one commit `delete: <path>`. Both: the owner,
 * or the assistant through the MCP bearer (its commit names it), from our own
 * page; 404 `not_found`, 400 `invalid`, 409 `invalid_page` / `verified` /
 * `lint_blocked`, 412 `not_initialised`.
 */
import { requireSession } from "@/lib/route-auth";
import { deletePage, editPage, readPagePatch } from "@/lib/prime-radiant/edit";
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
