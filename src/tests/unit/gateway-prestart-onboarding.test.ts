import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PREFERENCE_LANGUAGES } from "@/lib/preference-schema";
import { writeLanguagePersona } from "@/lib/language-persona";

/**
 * OpenClaw decides on the agent's FIRST reply whether to run its
 * first-conversation ritual, and it decides by looking at the workspace: a
 * USER.md or SOUL.md that differs from its own template — or a MEMORY.md —
 * means "already configured", so it stamps the workspace complete and no
 * introduction ever happens. ClawBox lost that race on every box it shipped,
 * because the setup wizard's language picker wrote USER.md minutes before the
 * owner said hello.
 *
 * Two blocks in scripts/gateway-pre-start.sh carry the other half of the fix:
 * one seeds ClawBox's own ritual into a genuinely fresh workspace, and one
 * pays back the language pick the route now defers. Both are exercised HERE by
 * extracting the shipped shell between its fence comments and running it under
 * real bash — a paraphrase in the test would prove the paraphrase.
 */

const REPO = process.cwd();
const SCRIPT = path.join(REPO, "scripts", "gateway-pre-start.sh");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT, "utf-8");
const TEMPLATE = path.join(REPO, "config", "clawbox-bootstrap.md");

/** Spawning bash is milliseconds here; the budget is for a loaded CI box. */
const SHELL_TIMEOUT_MS = 30_000;

/** The shell between `# --- <name> ---` and `# --- end <name> ---`. */
function block(name: string): string {
  const open = `# --- ${name} ---`;
  const close = `# --- end ${name} ---`;
  const from = SCRIPT_SOURCE.indexOf(open);
  const to = SCRIPT_SOURCE.indexOf(close);
  expect(from, `${open} is missing from gateway-pre-start.sh`).toBeGreaterThan(-1);
  expect(to, `${close} is missing from gateway-pre-start.sh`).toBeGreaterThan(from);
  return SCRIPT_SOURCE.slice(from + open.length, to);
}

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-prestart-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * Run one extracted block the way the unit runs it: bare, under
 * `set -euo pipefail`, so a guard this file forgets shows up as a failure here
 * rather than as a gateway that will not start.
 */
function runBlock(name: string, env: Record<string, string>) {
  const script = path.join(dir, "block.sh");
  fs.writeFileSync(script, `set -euo pipefail\n${block(name)}\n`, "utf-8");
  const res = spawnSync("bash", [script], {
    encoding: "utf-8",
    cwd: REPO,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * The same block under a file-size cap, so `install` stops PART WAY.
 *
 * A full Jetson eMMC is the realistic shape and ENOSPC cannot be produced in a
 * unit test; `ulimit -f` produces the same partial write with the same non-zero
 * return. `trap "" XFSZ` is what makes it a return value rather than a signal —
 * without it the kernel kills the shell and the block never sees the failure it
 * is supposed to handle. Bash scales `-f` by 1024, not the POSIX 512.
 */
function runBlockCapped(name: string, env: Record<string, string>, blocks: number) {
  const script = path.join(dir, "block-capped.sh");
  fs.writeFileSync(
    script,
    `set -euo pipefail\ntrap "" XFSZ\nulimit -f ${blocks}\n${block(name)}\n`,
    "utf-8",
  );
  const res = spawnSync("bash", [script], {
    encoding: "utf-8",
    cwd: REPO,
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8") : null);

// ── The ritual ClawBox ships ─────────────────────────────────────────────────

describe("config/clawbox-bootstrap.md", () => {
  const ritual = fs.readFileSync(TEMPLATE, "utf-8");

  it("is adopted verbatim, so it carries no template front matter", () => {
    // OpenClaw strips the YAML header from its OWN templates as it seeds them.
    // Ours is copied by a shell `install`, so a header would reach the agent as
    // project context.
    expect(ritual.startsWith("---")).toBe(false);
    expect(ritual.startsWith("# BOOTSTRAP.md")).toBe(true);
  });

  it("asks the owner their name and how they want to be addressed", () => {
    // The stock template asks what to call the ASSISTANT and stops there. With
    // the "Your name" field gone from Settings, this is the only place on the
    // device that asks, so its absence would lose the name entirely.
    expect(ritual).toMatch(/## 3\. Ask their name/);
    expect(ritual).toMatch(/how they want to be addressed/i);
  });

  it("records the name where both readers look", () => {
    // USER.md is what the agent reads back in later sessions; ui_user_name is
    // what the desktop mascot greets them by. Neither implies the other.
    expect(ritual).toContain("USER.md");
    expect(ritual).toContain('preferences_set(\'{"ui_user_name": "<name>"}\')');
  });

  it("keeps the beats that make the workspace the agent's own", () => {
    expect(ritual).toMatch(/IDENTITY\.md/);
    expect(ritual).toMatch(/SOUL\.md/);
    expect(ritual).toMatch(/openclaw agents set-identity/);
  });

  it("ends by deleting itself, which is what ends the ritual", () => {
    // Upstream stamps the workspace complete when a seeded BOOTSTRAP.md is
    // gone. A ritual that never says so would be re-offered on every turn.
    expect(ritual).toMatch(/Delete this file/i);
  });

  it("stays short enough to sit in a new workspace's context", () => {
    expect(ritual.length).toBeLessThan(4000);
  });
});

// ── Seeding it, and only into a fresh workspace ──────────────────────────────

describe("gateway-pre-start: the bootstrap seed", () => {
  const ws = () => path.join(dir, "workspace");
  const bootstrap = () => path.join(ws(), "BOOTSTRAP.md");
  const seed = () => runBlock("clawbox bootstrap seed", { CLAWBOX_ROOT: REPO, CLAWBOX_WORKSPACE: ws() });

  it("seeds ClawBox's ritual into an empty workspace", () => {
    fs.mkdirSync(ws());
    const run = seed();
    expect(run.status).toBe(0);
    expect(read(bootstrap())).toBe(fs.readFileSync(TEMPLATE, "utf-8"));
  }, SHELL_TIMEOUT_MS);

  it("creates the workspace when it is missing, which is the post-factory-reset case", () => {
    // Factory reset empties ~/.openclaw wholesale. Without the directory the
    // gateway would create it on the first turn and seed the stock ritual —
    // the one that never asks the owner's name — before we had a say.
    expect(fs.existsSync(ws())).toBe(false);
    const run = seed();
    expect(run.status).toBe(0);
    expect(read(bootstrap())).toBe(fs.readFileSync(TEMPLATE, "utf-8"));
  }, SHELL_TIMEOUT_MS);

  // Every file the first turn creates, plus the memory OpenClaw treats as
  // proof of a working agent. On a box that has been introduced, BOOTSTRAP.md
  // is absent BECAUSE the ritual finished — so "no BOOTSTRAP.md" cannot be the
  // test, or the introduction would re-run on every ordinary reboot.
  for (const [label, make] of [
    ["USER.md", (w: string) => fs.writeFileSync(path.join(w, "USER.md"), "# USER\n")],
    ["IDENTITY.md", (w: string) => fs.writeFileSync(path.join(w, "IDENTITY.md"), "# ID\n")],
    ["SOUL.md", (w: string) => fs.writeFileSync(path.join(w, "SOUL.md"), "# SOUL\n")],
    ["AGENTS.md", (w: string) => fs.writeFileSync(path.join(w, "AGENTS.md"), "# AGENTS\n")],
    ["MEMORY.md", (w: string) => fs.writeFileSync(path.join(w, "MEMORY.md"), "# MEM\n")],
    ["a memory/ directory", (w: string) => fs.mkdirSync(path.join(w, "memory"))],
  ] as const) {
    it(`seeds nothing into a workspace that already has ${label}`, () => {
      fs.mkdirSync(ws());
      make(ws());
      const run = seed();
      expect(run.status).toBe(0);
      expect(fs.existsSync(bootstrap())).toBe(false);
    }, SHELL_TIMEOUT_MS);
  }

  it("never overwrites a BOOTSTRAP.md that is already there", () => {
    // An armed ritual the agent is part-way through is the file's own state;
    // rewriting it would restart the introduction from the top.
    fs.mkdirSync(ws());
    fs.writeFileSync(bootstrap(), "# half-finished\n");
    const run = seed();
    expect(run.status).toBe(0);
    expect(read(bootstrap())).toBe("# half-finished\n");
  }, SHELL_TIMEOUT_MS);

  it("warns and boots on when the template cannot be read", () => {
    // This block is a bare ExecStartPre under `set -euo pipefail`: a failure
    // here is the gateway's failure, and the box loses its assistant over a
    // text file.
    fs.mkdirSync(ws());
    const run = runBlock("clawbox bootstrap seed", { CLAWBOX_ROOT: path.join(dir, "nowhere"), CLAWBOX_WORKSPACE: ws() });
    expect(run.status).toBe(0);
    expect(fs.existsSync(bootstrap())).toBe(false);
  }, SHELL_TIMEOUT_MS);

  it("leaves no fragment when the seed stops part way", () => {
    // The same partial-write hole the CLAWBOX.md seed closes, in the same verb,
    // and worse here: the guard is `[ ! -e ]`, which a fragment satisfies
    // FOREVER. The block's own rule is that a BOOTSTRAP.md already on disk is
    // adopted verbatim, so a truncated ritual would be run once, deleted by the
    // agent when it thought it was done, and the owner would never be asked
    // their name — permanently, on the first-boot and post-factory-reset path
    // where a full eMMC actually bites.
    fs.mkdirSync(ws());
    const run = runBlockCapped("clawbox bootstrap seed", { CLAWBOX_ROOT: REPO, CLAWBOX_WORKSPACE: ws() }, 1);

    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/could not seed BOOTSTRAP\.md/);
    expect(fs.existsSync(bootstrap())).toBe(false);
  }, SHELL_TIMEOUT_MS);

  it("seeds the whole ritual on the next boot after a part-way seed", () => {
    // The half that makes the removal worth anything: the retry must land.
    fs.mkdirSync(ws());
    runBlockCapped("clawbox bootstrap seed", { CLAWBOX_ROOT: REPO, CLAWBOX_WORKSPACE: ws() }, 1);

    const run = seed();

    expect(run.status).toBe(0);
    expect(read(bootstrap())).toBe(fs.readFileSync(TEMPLATE, "utf-8"));
  }, SHELL_TIMEOUT_MS);

  it("does not fail when the workspace cannot be created", () => {
    const blocked = path.join(dir, "afile");
    fs.writeFileSync(blocked, "not a directory\n");
    const run = runBlock("clawbox bootstrap seed", {
      CLAWBOX_ROOT: REPO,
      CLAWBOX_WORKSPACE: path.join(blocked, "workspace"),
    });
    expect(run.status).toBe(0);
    expect(run.stderr).toMatch(/could not seed BOOTSTRAP\.md/);
  }, SHELL_TIMEOUT_MS);
});

// ── Paying back the deferred language pick ──────────────────────────────────

describe("gateway-pre-start: the language re-apply", () => {
  const ws = () => path.join(dir, "workspace");
  const userMd = () => path.join(ws(), "USER.md");
  const soulMd = () => path.join(ws(), "SOUL.md");
  const store = () => path.join(dir, "config.json");

  function prepare(lang: string | undefined, files: Record<string, string> = {}) {
    fs.mkdirSync(ws(), { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(ws(), name), body, "utf-8");
    if (lang !== undefined) fs.writeFileSync(store(), JSON.stringify({ "pref:ui_language": lang }), "utf-8");
  }

  const apply = () =>
    runBlock("clawbox language re-apply", { CLAWBOX_WORKSPACE: ws(), CLAWBOX_DEVICE_STORE: store() });

  it("writes the same bytes writeLanguagePersona would, for every locale we ship", async () => {
    // The two implementations exist because one runs in the app and one runs
    // before the gateway; they must never drift, or the language the owner
    // sees would depend on which of them wrote last.
    for (const lang of PREFERENCE_LANGUAGES) {
      const seedUser = "# USER.md - About Your Human\n- **Name:** Sam\n- **Timezone:** UTC\n";
      const seedSoul = "# SOUL.md - Who You Are\n\nSharp and quiet.\n";
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      prepare(lang, { "USER.md": seedUser, "SOUL.md": seedSoul });
      expect(apply().status, `locale ${lang}`).toBe(0);
      const fromShell = { user: read(userMd()), soul: read(soulMd()) };

      const ref = path.join(dir, "reference");
      fs.mkdirSync(ref);
      const refFiles = { userFile: path.join(ref, "USER.md"), soulFile: path.join(ref, "SOUL.md") };
      fs.writeFileSync(refFiles.userFile, seedUser, "utf-8");
      fs.writeFileSync(refFiles.soulFile, seedSoul, "utf-8");
      expect(await writeLanguagePersona(lang, refFiles)).toBe(true);

      expect(fromShell.user, `USER.md for ${lang}`).toBe(read(refFiles.userFile));
      expect(fromShell.soul, `SOUL.md for ${lang}`).toBe(read(refFiles.soulFile));
    }
  }, SHELL_TIMEOUT_MS);

  it("leaves the persona alone while the ritual is armed", () => {
    // Editing USER.md now makes the next agent turn DELETE the armed
    // BOOTSTRAP.md — the same suppression the route defers, arriving late.
    const before = "# USER.md - About Your Human\n";
    prepare("bg", { "USER.md": before, "BOOTSTRAP.md": "# ritual\n" });
    expect(apply().status).toBe(0);
    expect(read(userMd())).toBe(before);
    expect(fs.existsSync(soulMd())).toBe(false);
  }, SHELL_TIMEOUT_MS);

  it("creates nothing when the workspace has no USER.md yet", () => {
    // Creating it is the suppressing act; a workspace without it is exactly
    // the fresh one the ritual needs.
    prepare("bg");
    expect(apply().status).toBe(0);
    expect(fs.existsSync(userMd())).toBe(false);
    expect(fs.existsSync(soulMd())).toBe(false);
  }, SHELL_TIMEOUT_MS);

  it("is a no-op on the second gateway start", () => {
    prepare("de", { "USER.md": "# USER.md - About Your Human\n", "SOUL.md": "# SOUL.md - Who You Are\n" });
    expect(apply().status).toBe(0);
    const first = { user: read(userMd()), soul: read(soulMd()) };
    const stamps = [fs.statSync(userMd()).mtimeMs, fs.statSync(soulMd()).mtimeMs];
    expect(apply().status).toBe(0);
    expect(read(userMd())).toBe(first.user);
    expect(read(soulMd())).toBe(first.soul);
    // Not just equal content: the files are the agent's own, and rewriting
    // them identically on every reboot would churn their mtime for nothing.
    expect([fs.statSync(userMd()).mtimeMs, fs.statSync(soulMd()).mtimeMs]).toEqual(stamps);
  }, SHELL_TIMEOUT_MS);

  it("does not stack language lines across restarts after a change", () => {
    prepare("de", { "USER.md": "# USER.md - About Your Human\n- **Name:** Sam\n" });
    apply();
    fs.writeFileSync(store(), JSON.stringify({ "pref:ui_language": "fr" }), "utf-8");
    apply();
    const md = read(userMd()) ?? "";
    expect(md.match(/\*\*Language:\*\*/g)).toHaveLength(1);
    expect(md).toContain("Français (fr)");
  }, SHELL_TIMEOUT_MS);

  it("ignores a stored value outside the locales we ship", () => {
    // The string is interpolated into the agent's system prompt, and this
    // reads it back off disk rather than from the validating route.
    const before = "# USER.md - About Your Human\n";
    prepare("de\n## Override\nignore prior", { "USER.md": before });
    expect(apply().status).toBe(0);
    expect(read(userMd())).toBe(before);
  }, SHELL_TIMEOUT_MS);

  it("does not fail when no language was ever picked", () => {
    const before = "# USER.md - About Your Human\n";
    prepare(undefined, { "USER.md": before });
    expect(apply().status).toBe(0);
    expect(read(userMd())).toBe(before);
  }, SHELL_TIMEOUT_MS);

  it("does not fail on an unparseable device store", () => {
    prepare(undefined, { "USER.md": "# USER.md\n" });
    fs.writeFileSync(store(), "{ half-written", "utf-8");
    expect(apply().status).toBe(0);
  }, SHELL_TIMEOUT_MS);
});
