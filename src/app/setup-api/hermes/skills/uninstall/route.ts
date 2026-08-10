export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { isValidSkillName } from "@/lib/hermes-skills";
import { hermesSkillsGuard } from "@/lib/hermes-skills-server";

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
    if (r.code !== 0) {
      return NextResponse.json({ error: r.stderr || "Uninstall failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes uninstall failed" },
      { status: 502 },
    );
  }
}
