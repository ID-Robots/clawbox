/**
 * POST /setup-api/prime-radiant/revert `{ commit, path? }` — undo one commit
 * (or only its change to one page) as one new commit: `{ reverted, commit,
 * changed }`. The OWNER's (cookie AND same origin) — with one exception: the
 * assistant, through the MCP bearer, may undo a commit it authored itself,
 * and its revert commit names it; any other commit answers it 403
 * `owner_only`. 409 `conflict` (a later change touched the same lines),
 * `lint_blocked` (with `findings` — e.g. undoing a verification would bring a
 * retired claim id back), `nothing_to_revert`, `dirty`; 400 `invalid`; 404
 * `not_found` / `not_initialised`.
 */
import { HistoryError, revertCommit } from "@/lib/prime-radiant/history";
import { fail, json, readJsonBody, vaultFailure, writerGuard } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gate = await writerGuard(req, "Reverting a change");
  if (!gate.ok) return gate.response;
  const { writer } = gate;
  const read = await readJsonBody(req);
  if (!read.ok) return read.response;
  const b = (read.body && typeof read.body === "object" ? read.body : {}) as { commit?: unknown; path?: unknown };
  if (typeof b.commit !== "string") return fail("invalid", "Name the commit to undo.", 400);
  if (b.path !== undefined && b.path !== null && typeof b.path !== "string") return fail("invalid", "path must be a page path.", 400);
  try {
    return json(
      await revertCommit({ sha: b.commit, path: (b.path as string | null | undefined) ?? null }, undefined, {
        author: writer.author,
        ...(writer.person ? {} : { onlyAuthoredBy: writer.author }),
      }),
    );
  } catch (err) {
    if (err instanceof HistoryError) {
      const body: Record<string, unknown> = { error: err.message, code: err.code };
      if (err.findings.length > 0) body.findings = err.findings.map((f) => ({ rule: f.rule, path: f.path, message: f.message }));
      return json(body, err.status);
    }
    return vaultFailure("revert", err);
  }
}
