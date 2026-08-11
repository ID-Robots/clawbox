export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { isValidSkillName } from "@/lib/hermes-skills";
import { hermesSkillsGuard, invalidateInstalledCache } from "@/lib/hermes-skills-server";

// Uninstall a Hermes skill. The positional argument is the skill NAME (the
// lock.json key, e.g. "1password"), NOT the full registry identifier. There is
// no `--yes` flag — the CLI prompts `Confirm [y/N]:`, so we pipe "y\n" on stdin.
export async function POST(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!isValidSkillName(id)) {
    return NextResponse.json({ error: "Invalid skill name" }, { status: 400 });
  }

  try {
    const r = await runHermesCli(["skills", "uninstall", id], {
      timeoutMs: 30_000,
      input: "y\n",
    });
    // The skill directory is gone — drop the cached installed list before we
    // answer so the client's re-fetch can't be served the pre-removal walk.
    invalidateInstalledCache();
    if (r.code !== 0) {
      // Raw stderr can carry a Python traceback with the binary path and local
      // install dirs — log it, never send it to the browser.
      console.error("[hermes skills uninstall] exit", r.code, r.stderr);
      return NextResponse.json({ error: "Uninstall failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, id, name: id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes uninstall failed" },
      { status: 502 },
    );
  }
}
