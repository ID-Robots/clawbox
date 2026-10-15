/**
 * GET /setup-api/prime-radiant/pages/<vault path> — one page: frontmatter (or
 * why it does not parse), body, summary, backlinks, outbound links and its
 * scoped lint. With `?view=summary`, only `{ path, summary }`: the page in a
 * few sentences for the Map's card, read from that page alone. Owner-only. A
 * path that is not a knowledge page answers 404 exactly like a missing one.
 */
import { requireSession } from "@/lib/route-auth";
import { getPage, getPageBlurb } from "@/lib/prime-radiant/service";
import { fail, json, vaultFailure } from "@/lib/prime-radiant/route-helpers";

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
