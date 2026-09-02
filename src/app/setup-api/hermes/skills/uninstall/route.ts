export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { isValidSkillName, CLI_FAILURE_SENTENCES, cliFailureCode } from "@/lib/hermes-skills";
import { parseUninstallOutcome } from "@/lib/hermes-skill-cli-outcome";
import {
  hermesSkillsGuard,
  hubLockEntry,
  invalidateInstalledCache,
  isInHubLock,
  readBundledManifestNames,
  readHubLock,
  resolveUninstallKey,
  verifySkillRemoval,
} from "@/lib/hermes-skills-server";

// Uninstall a Hermes skill. The positional argument is the skill NAME (the
// lock.json key, e.g. "1password"), NOT the full registry identifier. There is
// no `--yes` flag — the CLI prompts `Confirm [y/N]:`, so we pipe "y\n" on stdin.
//
// ── F-09: the argument is not always the lock key ───────────────────────────
//
// This route used to look up `id` as a lock key and nothing else, which is only
// the same question the caller asked when the skill's SKILL.md name happens to
// equal its key. For a ClawHub skill it does not: `martin-weather` installs
// under that key and shows as `weather` everywhere a person or an agent reads
// it, so `{"id":"weather"}` reached the CLI unchanged, was refused as "not a
// hub-installed skill", and came back a 404 about a skill the device has and
// the Skills page lists. Resolution now happens ONCE, here, in
// resolveUninstallKey() — the store, the MCP tools and any later client get the
// same answer instead of three hand-rolled rules that agree only by accident.
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
//
// ── …and the hub lock is only half of it ────────────────────────────────────
//
// Removing a skill has TWO halves: the lock entry, which is what the store
// lists, and the DIRECTORY, which is what the agent loads. PR #517 rewrote the
// install route's rollback around that — "a skill directory left behind would be
// loaded by the agent even with no lock entry" — and this route, driving the
// same command, still stopped at the lock. On the device state #517's own test
// names (a lock entry whose install_path the validator refuses, an `fs.rm` that
// cannot traverse a root-owned subtree) the CLI drops the entry and leaves the
// files, and `{"ok":true}` here left the customer with a skill the agent still
// loads, re-listed by `enumerateInstalledSkills` as origin `local` — which the
// store will not offer to remove and MCP's post-condition reads as a CONFLICT.
// Both routes now take the same second swing and read the same verdict
// (verifySkillRemoval).

export async function POST(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  let body: { id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const requested = typeof body.id === "string" ? body.id.trim() : "";
  if (!isValidSkillName(requested)) {
    return NextResponse.json({ error: "Invalid skill name" }, { status: 400 });
  }

  try {
    // Key, store identifier or display name — one lock key, before anything
    // else looks at it, on the rule the agent's skill_uninstall applies to the
    // same device state (matchRemovableSkill). A tie is answered, never broken,
    // on both of the non-unique keys — two entries sharing an identifier, two
    // cards showing one name — because this ends in a delete. An exact lock key
    // is not a tie: it is a JSON object key and it settles the question.
    const resolved = await resolveUninstallKey(requested);
    if ("ambiguous" in resolved) {
      return NextResponse.json(
        {
          error: `More than one installed skill on this device answers to "${requested}". `
            + `Remove it by its own name: ${resolved.ambiguous.join(", ")}.`,
          code: "ambiguous_name",
          candidates: resolved.ambiguous,
        },
        { status: 409 },
      );
    }
    const id = resolved.key;
    // Read the lock BEFORE the CLI runs: for a wording this parser has never
    // seen, an entry that was there and is gone afterwards is still a removal.
    // The ENTRY, not just the boolean — `install_path` is the only thing that
    // says where the files the CLI is supposed to delete actually live, and
    // after the CLI has run there is no entry left to ask.
    const entry = hubLockEntry(await readHubLock(), id);
    const hadEntry = entry !== undefined;
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
    // The lock half is done. Take the same second swing at the directory the
    // install route's rollback takes — the CLI's own `fs.rm` is the half that
    // fails silently on this device family — and answer on the whole verdict.
    // Only now: deleting the files under a lock entry that survived would
    // manufacture the half-removed state this is here to detect.
    const left = await verifySkillRemoval(id, entry);
    // The whole verdict, not one field of it. `stillLocked` above was read
    // before the directory removal, and nothing serialises this route against a
    // concurrent install of the same name — so an entry that reappeared in the
    // meantime has to be answered too, and `clean` is the answer that carries
    // both halves.
    if (!left.clean) {
      console.error(
        "[hermes skills uninstall] removal incomplete",
        JSON.stringify(id),
        "lockEntry:",
        left.lockEntry,
        "dir:",
        left.dir,
      );
      // Say only what was established, and give the next step that state
      // actually has: a leftover the store cannot see is a leftover the store
      // cannot remove.
      const leftover = left.lockEntry
        ? left.dir === "present"
          ? `it is listed in the Skills store again and its files are on the device`
          : `it is listed in the Skills store again`
        : `it is no longer listed in the Skills store, but its files are still on the device, `
          + `so the agent would still load it`;
      const nextStep = left.lockEntry
        ? `Check Settings -> Skills, and remove it again if it is still there.`
        : `The leftover folder has to be deleted on the device.`;
      return NextResponse.json(
        {
          error: `"${id}" was not fully removed: ${leftover}. ${nextStep}`,
          code: "removal_incomplete",
          name: id,
          leftover: { lockEntry: left.lockEntry, directory: left.dir },
        },
        { status: 409 },
      );
    }
    // `requested` so a caller that passed a display name or an identifier can
    // see WHICH skill went. The MCP tool says so in its own words; the store and
    // any later client only have the body.
    return NextResponse.json({ ok: true, id, name: id, requested });
  } catch (err) {
    // This try covers the lock read, the spawn and the removal check, so an
    // I/O failure here names absolute device paths — the exception's message
    // goes to the log, the caller gets a fixed sentence and the code.
    const code = cliFailureCode(err);
    console.error("[hermes skills uninstall] failed", code, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: CLI_FAILURE_SENTENCES[code], code }, { status: 502 });
  }
}
