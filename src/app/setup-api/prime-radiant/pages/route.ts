/**
 * /setup-api/prime-radiant/pages
 *
 * GET — the page list (no bodies), filtered by `type`, `domain`, `owner`,
 * `status`, `verified` (true|false) and `q`, paged with `offset` / `limit` (at
 * most 500). Owner-only.
 *
 * POST `{ type, title, domain, summary, body?, owner?, status?, privacy?,
 * sources?, facts?, confidence? }` — a new page (lib/prime-radiant/edit.ts):
 * 201 `{ path, commit, claims, findings }`, one commit `create: <path>`. The
 * owner, or the assistant through the MCP bearer (its commit names it), from
 * our own page. 400 `invalid`, 409 `exists` / `lint_blocked` (with
 * `findings`), 412 `not_initialised`.
 */
import { requireSession } from "@/lib/route-auth";
import { createPage, readNewPage } from "@/lib/prime-radiant/edit";
import { listPages, MAX_PAGE_LIST, type PageFilter } from "@/lib/prime-radiant/service";
import { PAGE_STATUSES, PAGE_TYPES } from "@/lib/prime-radiant/schema";
import { editFailure, fail, json, readJsonBody, vaultFailure, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

function intParam(value: string | null, max: number): number | undefined | null {
  if (value === null || value === "") return undefined;
  if (!/^\d{1,7}$/.test(value)) return null;
  return Math.min(Number(value), max);
}

export async function GET(req: Request) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const filter: PageFilter = {};

  const type = params.get("type");
  if (type) {
    if (!(PAGE_TYPES as readonly string[]).includes(type)) return fail("invalid_type", "Unknown page type.", 400);
    filter.type = type;
  }
  const status = params.get("status");
  if (status) {
    if (!(PAGE_STATUSES as readonly string[]).includes(status)) return fail("invalid_status", "Unknown page status.", 400);
    filter.status = status;
  }
  const domain = params.get("domain");
  if (domain) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(domain)) return fail("invalid_domain", "Not a domain name.", 400);
    filter.domain = domain;
  }
  const owner = params.get("owner");
  if (owner) {
    if (owner.length > 80) return fail("invalid_owner", "An owner is at most 80 characters.", 400);
    filter.owner = owner;
  }
  const verified = params.get("verified");
  if (verified !== null && verified !== "") {
    if (verified !== "true" && verified !== "false") return fail("invalid_verified", "verified must be true or false.", 400);
    filter.verified = verified === "true";
  }
  const q = params.get("q");
  if (q) filter.q = q.slice(0, 200);
  const offset = intParam(params.get("offset"), 10_000_000);
  const limit = intParam(params.get("limit"), MAX_PAGE_LIST);
  if (offset === null || limit === null) return fail("invalid_range", "offset and limit must be whole numbers.", 400);
  if (offset !== undefined) filter.offset = offset;
  if (limit !== undefined) filter.limit = limit;

  try {
    return json(await listPages(filter));
  } catch (err) {
    return vaultFailure("pages", err);
  }
}

export async function POST(req: Request) {
  const gate = await writerGuard(req, "Creating a page");
  if (!gate.ok) return gate.response;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  try {
    return json(await createPage(readNewPage(read.body), gate.writer), 201);
  } catch (err) {
    return editFailure("page create", err);
  }
}
