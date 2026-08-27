export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { isValidSkillName } from "@/lib/hermes-skills";
import { parseUninstallOutcome } from "@/lib/hermes-skill-cli-outcome";
import {
  hermesSkillsGuard,
  invalidateInstalledCache,
  isInHubLock,
  readBundledManifestNames,
} from "@/lib/hermes-skills-server";

// Uninstall a Hermes skill. The positional argument is the skill NAME (the
// lock.json key, e.g. "1password"), NOT the full registry identifier. There is
// no `--yes` flag — the CLI prompts `Confirm [y/N]:`, so we pipe "y\n" on stdin.
//
// ── TASK-547: the exit code is not an answer ────────────────────────────────
//
// `hermes skills uninstall` exits 0 whether it removed the skill or refused to:
// `do_uninstall` prints `uninstall_skill`'s message and returns. That is the
// exact habit PR #504 handled for install, and the reason the install route's
// own rollback deliberately does not trust this command. Reading only the exit
// code, this route answered {"ok":true} for a builtin, for a name that does
// not exist, and for a lock entry the path validator refused — and the store
// told the customer a skill was gone while the device still had it. Now the
// CLI's own sentence is classified (parseUninstallOutcome), and a success has
// to be true in the hub lock before it is reported.

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
    // Read the lock BEFORE the CLI runs: for a wording this parser has never
    // seen, an entry that was there and is gone afterwards is still a removal.
    const hadEntry = await isInHubLock(id);
    const r = await runHermesCli(["skills", "uninstall", id], {
      timeoutMs: 30_000,
      input: "y\n",
    });
    // The skill directory may be gone — drop the cached installed list before
    // we answer so the client's re-fetch can't be served the pre-removal walk.
    invalidateInstalledCache();
    if (r.code !== 0) {
      // Raw stderr can carry a Python traceback with the binary path and local
      // install dirs — log it, never send it to the browser.
      console.error("[hermes skills uninstall] exit", r.code, r.stderr);
      return NextResponse.json(
        { error: "Uninstall failed", code: "uninstall_failed" },
        { status: 502 },
      );
    }

    const outcome = parseUninstallOutcome(r.stdout, r.stderr);
    if (outcome.kind === "not-installed") {
      // The CLI cannot tell a skill that shipped with the device from a name
      // it has never seen — the bundled manifest can, and the difference is
      // the difference between "you cannot" and "there is nothing to remove".
      if ((await readBundledManifestNames()).has(id)) {
        return NextResponse.json(
          {
            error: `"${id}" came with this device, so it cannot be removed.`,
            code: "builtin_skill",
          },
          { status: 409 },
        );
      }
      return NextResponse.json(
        {
          error: `No store skill called "${id}" is installed on this device.`,
          code: "not_installed",
        },
        { status: 404 },
      );
    }
    if (outcome.kind === "refused") {
      // The reason after the colon is a raw exception string that can name
      // on-device paths — log it, answer with fixed words. Same rule as the
      // non-zero-exit branch.
      console.error("[hermes skills uninstall] CLI refused", r.stdout);
      return NextResponse.json(
        { error: "The device refused to remove that skill.", code: "uninstall_refused" },
        { status: 502 },
      );
    }

    // 'uninstalled', 'cancelled' or 'unknown': the hub lock decides. The CLI
    // drops the lock entry before it prints its success sentence, so an entry
    // that survived contradicts anything the output said — and for output this
    // parser does not recognise, only the entry's disappearance proves a
    // removal.
    const stillLocked = await isInHubLock(id);
    const removed = !stillLocked && (outcome.kind === "uninstalled" || hadEntry);
    if (!removed) {
      console.error("[hermes skills uninstall] exit 0 without removing", outcome.kind, r.stdout);
      return NextResponse.json(
        {
          error: "The device's uninstaller stopped without removing the skill.",
          code: "uninstall_failed",
        },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true, id, name: id });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes uninstall failed" },
      { status: 502 },
    );
  }
}
