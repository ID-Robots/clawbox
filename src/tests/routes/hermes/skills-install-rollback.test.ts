import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The install route's ROLLBACK has to be as distrustful of the CLI as the
 * uninstall route is.
 *
 * PR #510 established the post-condition for `hermes skills uninstall`: the
 * command exits 0 whether it removed the skill or refused to, so a removal is
 * only real when the hub lock entry is gone afterwards. The install route drives
 * exactly the same command from `rollback()` and did not apply it — it ran the
 * uninstall, swallowed a thrown timeout with a console line, threw away
 * `removeSkillDir`'s boolean and never re-read the lock.
 *
 * The end state on a loaded Jetson: the scan gate refuses a skill, the rollback
 * cannot undo the install, and the route still answers "this skill did not pass
 * the device's security scan" — while the lock entry it failed to remove keeps
 * the refused skill in the installed list (enumerateInstalledSkills iterates
 * every lock entry unconditionally). The store says installed, the API says
 * refused, and the retry that follows can never succeed.
 *
 * The CLI is faked, but faked FAITHFULLY: the fake writes and deletes the same
 * lock entries and directories the real one does, and refuses in the two ways
 * the real one refuses — a timeout that throws, and an exit 0 that removes
 * nothing.
 */

vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-cli", () => ({ runHermesCli: vi.fn() }));
vi.mock("@/lib/hermes-config-cache", () => ({
  hermesConfigGet: vi.fn(async () => ""),
  hermesConfigGetMany: vi.fn(async () => ({})),
  invalidateHermesConfigCache: vi.fn(),
}));
vi.mock("@/lib/hermes-skill-index", () => ({ getCatalogRecord: vi.fn(async () => undefined) }));

import { runHermesCli } from "@/lib/hermes-cli";
import { getCatalogRecord } from "@/lib/hermes-skill-index";

const mockCli = vi.mocked(runHermesCli);
const mockRecord = vi.mocked(getCatalogRecord);

let hermesHome: string;
let clawboxRoot: string;

function skillsDir(): string {
  return path.join(hermesHome, "skills");
}

async function readLock(): Promise<Record<string, Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(skillsDir(), ".hub", "lock.json"), "utf8");
  return (JSON.parse(raw) as { installed: Record<string, Record<string, unknown>> }).installed;
}

async function writeLock(installed: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(skillsDir(), ".hub"), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir(), ".hub", "lock.json"),
    JSON.stringify({ version: 1, installed }),
  );
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

beforeEach(async () => {
  vi.resetModules();
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-"));
  clawboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-root-"));
  process.env.HERMES_HOME = hermesHome;
  process.env.CLAWBOX_ROOT = clawboxRoot;
  await fs.mkdir(skillsDir(), { recursive: true });
  await writeLock({});
  mockRecord.mockResolvedValue(undefined);
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(hermesHome, { recursive: true, force: true });
  await fs.rm(clawboxRoot, { recursive: true, force: true });
});

async function install(body: Record<string, unknown>) {
  const { POST } = await import("@/app/setup-api/hermes/skills/install/route");
  const res = await POST(
    new Request("http://localhost/setup-api/hermes/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

/** How the faked `hermes skills uninstall` behaves — all three are real. */
type UninstallBehaviour =
  /** Removes the lock entry and the directory. */
  | "works"
  /** The 30 s timeout on a loaded Jetson: runHermesCli throws. */
  | "throws"
  /** Its documented habit — prints a refusal, removes nothing, exits 0. */
  | "exit0-noop";

function fakeHermes(opts: {
  name: string;
  /** Where the fake writes the files. */
  installPath: string;
  /** What the lock records, when that differs from where the files went. */
  lockInstallPath?: string;
  files: Record<string, string>;
  lock: Record<string, unknown>;
  uninstall: UninstallBehaviour;
}) {
  mockCli.mockImplementation(async (args: string[]) => {
    if (args[1] === "install") {
      const lock = await readLock();
      // The installer will not write over its own lock entry: it says the skill
      // is already there and exits 0, whatever is or is not on disk.
      if (Object.prototype.hasOwnProperty.call(lock, opts.name)) {
        return { code: 0, stdout: `Skill '${opts.name}' is already installed\n`, stderr: "" };
      }
      const dir = path.join(skillsDir(), opts.installPath);
      for (const [rel, content] of Object.entries(opts.files)) {
        const abs = path.join(dir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
      lock[opts.name] = {
        install_path: opts.lockInstallPath ?? opts.installPath,
        files: Object.keys(opts.files),
        ...opts.lock,
      };
      await writeLock(lock);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "uninstall") {
      if (opts.uninstall === "throws") {
        throw new Error("hermes skills uninstall timed out after 30000ms");
      }
      if (opts.uninstall === "exit0-noop") {
        return {
          code: 0,
          stdout: `'${args[2]}' is not a hub-installed skill (may be a builtin)\n`,
          stderr: "",
        };
      }
      const lock = await readLock();
      delete lock[args[2]];
      await writeLock(lock);
      // The CLI removes the directory its OWN lock entry names, and, like the
      // route, will not delete a path that escapes the skills tree.
      const recorded = path.resolve(skillsDir(), opts.lockInstallPath ?? opts.installPath);
      if (recorded.startsWith(skillsDir() + path.sep)) {
        await fs.rm(recorded, { recursive: true, force: true });
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

const DANGEROUS_SCAN = {
  verdict: "dangerous",
  scanner_version: "1.4.0",
  findings: [
    {
      pattern_id: "agent-instruction-overwrite",
      severity: "critical",
      category: "persistence",
      file: "SKILL.md",
      line: 308,
      description: "- **Agent instructions (prompts, AGENTS.md)**",
    },
  ],
};

function fakeDangerousInstall(uninstall: UninstallBehaviour, over: Record<string, unknown> = {}) {
  fakeHermes({
    name: "simple-english",
    installPath: "creative/simple-english",
    files: { "SKILL.md": "---\nname: simple-english\n---\nplain english\n" },
    lock: {
      identifier: "official/creative/simple-english",
      source: "official",
      trust_level: "builtin",
      scan_verdict: "dangerous",
      scan_provenance: DANGEROUS_SCAN,
    },
    uninstall,
    ...over,
  });
}

// ── The scan gate cannot claim a clean refusal it did not make ──────────────

describe("a rollback the device could not complete is not a plain refusal", () => {
  it("says the entry survived instead of answering the ordinary security-scan 409", async () => {
    fakeDangerousInstall("throws");
    const { status, body } = await install({ id: "official/creative/simple-english" });

    // The lock entry is the whole problem: it is still there.
    expect(Object.keys(await readLock())).toEqual(["simple-english"]);

    expect(body.code).not.toBe("dangerous_skill");
    expect(body.code).toBe("rollback_incomplete");
    expect(status).toBe(409);
    // Nothing may invite a confirmation: confirming walks into the 502 below.
    expect(body.requiresConfirmation).not.toBe(true);
    expect(String(body.error)).toMatch(/listed/i);
    expect(String(body.error)).toMatch(/remove/i);
    // The warning is still carried, so the store can still say WHAT was refused.
    expect(body.warning).toBeTruthy();
  });

  it("the survivor is a real phantom — the installed list shows the refused skill", async () => {
    fakeDangerousInstall("throws");
    await install({ id: "official/creative/simple-english" });

    const { enumerateInstalledSkills } = await import("@/lib/hermes-skills-server");
    const listed = (await enumerateInstalledSkills()).find((s) => s.id === "simple-english");
    // This is what the customer sees while the API says the install was refused,
    // and it is why the answer above has to name it.
    expect(listed).toMatchObject({ origin: "hub" });
    // …and the skill is not actually on disk.
    expect(await exists(path.join(skillsDir(), "creative", "simple-english"))).toBe(false);
  });

  it("does not blame the download when the retry meets the leftover entry", async () => {
    fakeDangerousInstall("throws");
    const first = await install({ id: "official/creative/simple-english" });
    expect(first.status).toBe(409);

    // The trap: the installer sees its own lock entry, exits 0 without writing
    // anything, `landed` is true, the completeness check finds no SKILL.md — and
    // the route told the customer "The download was incomplete".
    const retry = await install({
      id: "official/creative/simple-english",
      confirmDangerous: true,
    });
    expect(retry.body.code).not.toBe("incomplete_install");
    expect(String(retry.body.error)).not.toMatch(/download was incomplete/i);
    expect(retry.body.code).toBe("rollback_incomplete");
  });

  it("reports the leftover when the CLI exits 0 having removed nothing", async () => {
    // No install_path in the lock entry, so the belt-and-braces directory
    // removal has nothing to aim at either: the exit code is the ONLY thing
    // that said this rollback worked, and it lied.
    fakeDangerousInstall("exit0-noop", { lockInstallPath: "" });
    const { status, body } = await install({ id: "official/creative/simple-english" });

    expect(status).toBe(409);
    expect(body.code).toBe("rollback_incomplete");
    expect(Object.keys(await readLock())).toEqual(["simple-english"]);
    // The directory the agent would load is still there — the exact thing the
    // rollback exists to prevent.
    expect(await exists(path.join(skillsDir(), "creative", "simple-english", "SKILL.md"))).toBe(
      true,
    );
    // …so nothing may say the files went. Nothing looked at them: the entry
    // named no location, and "not checked" is not "removed".
    expect(body.leftover).toMatchObject({ lockEntry: true, directory: "unknown" });
    expect(String(body.error)).not.toMatch(/files were removed/i);
    expect(String(body.error)).toMatch(/could not be checked/i);
  });

  it("sends a directory-only leftover somewhere it can actually be removed", async () => {
    // Lock entry gone, files still there: the Skills store no longer lists it,
    // so "remove it from the Skills store" is advice that cannot be followed.
    fakeDangerousInstall("works", {
      installPath: "creative/simple-english",
      lockInstallPath: "creative/../../escape",
    });
    const { body } = await install({ id: "official/creative/simple-english" });

    expect(body.leftover).toMatchObject({ lockEntry: false, directory: "present" });
    expect(String(body.error)).not.toMatch(/remove .* from the Skills store/i);
    expect(String(body.error)).toMatch(/not in the Skills store/i);
    expect(String(body.error)).toMatch(/deleted on the device/i);
  });

  it("reports a directory the rollback could not remove even when the lock is clean", async () => {
    // A lock entry whose install_path the path validator refuses (#510 names
    // this case for uninstall): the CLI drops the entry, `removeSkillDir`
    // resolves nothing and returns false, and the files stay where the agent
    // reads them.
    fakeDangerousInstall("works", {
      installPath: "creative/simple-english",
      lockInstallPath: "creative/../../escape",
    });
    const { status, body } = await install({ id: "official/creative/simple-english" });

    expect(await readLock()).toEqual({});
    expect(status).toBe(409);
    expect(body.code).toBe("rollback_incomplete");
    expect(await exists(path.join(skillsDir(), "creative", "simple-english", "SKILL.md"))).toBe(
      true,
    );
  });

  it("audit-logs the incomplete rollback rather than a clean refusal", async () => {
    fakeDangerousInstall("throws");
    await install({ id: "official/creative/simple-english" });

    const { readSkillAuditLog } = await import("@/lib/hermes-skill-audit");
    const log = await readSkillAuditLog();
    expect(log.map((r) => r.action)).toContain("install-rollback-incomplete");
    expect(log[0]).toMatchObject({
      id: "official/creative/simple-english",
      name: "simple-english",
      verdict: "dangerous",
    });
  });
});

// ── …and a rollback that DID work must not be reported as a failure ─────────

describe("a rollback that worked keeps the honest refusal it already had", () => {
  it("still answers the plain security-scan 409 when the undo is complete", async () => {
    fakeDangerousInstall("works");
    const { status, body } = await install({ id: "official/creative/simple-english" });

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "dangerous_skill", requiresConfirmation: true });
    expect(await readLock()).toEqual({});
    expect(await exists(path.join(skillsDir(), "creative", "simple-english"))).toBe(false);
  });

  it("does not turn an unverifiable directory into a failure when the lock is clean", async () => {
    // The lock entry names no install_path, so the directory could not be
    // checked either way — but the entry itself is gone, so the store lists
    // nothing and the customer has nothing to act on. Answering
    // `rollback_incomplete` here would be this bug's mirror image: reporting a
    // failure over a rollback that did the one thing that was visible.
    fakeDangerousInstall("works", { lockInstallPath: "" });
    const { status, body } = await install({ id: "official/creative/simple-english" });

    expect(await readLock()).toEqual({});
    expect(status).toBe(409);
    expect(body.code).toBe("dangerous_skill");
    expect(body.code).not.toBe("rollback_incomplete");
  });

  it("still installs on the confirmed retry after a clean rollback", async () => {
    fakeDangerousInstall("works");
    expect((await install({ id: "official/creative/simple-english" })).status).toBe(409);
    const second = await install({
      id: "official/creative/simple-english",
      confirmDangerous: true,
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, name: "simple-english" });
  });

  it("still blames the download when an incomplete install rolls back cleanly", async () => {
    // The other caller of rollback(): a skill whose SKILL.md names files that
    // were never fetched. The undo works, so the answer must stay the one that
    // describes the real cause.
    fakeHermes({
      name: "algorithmic-art",
      installPath: "algorithmic-art",
      files: {
        "SKILL.md": "---\nname: algorithmic-art\n---\nSee the [viewer](templates/viewer.html).\n",
      },
      lock: {
        identifier: "x/algorithmic-art",
        source: "clawhub",
        trust_level: "community",
        scan_verdict: "safe",
      },
      uninstall: "works",
    });

    const { status, body } = await install({ id: "x/algorithmic-art" });
    expect(status).toBe(502);
    expect(body).toMatchObject({ code: "incomplete_install" });
    expect(await readLock()).toEqual({});
  });

  it("reports the leftover when an incomplete install cannot be rolled back", async () => {
    fakeHermes({
      name: "algorithmic-art",
      installPath: "algorithmic-art",
      files: {
        "SKILL.md": "---\nname: algorithmic-art\n---\nSee the [viewer](templates/viewer.html).\n",
      },
      lock: {
        identifier: "x/algorithmic-art",
        source: "clawhub",
        trust_level: "community",
        scan_verdict: "safe",
      },
      uninstall: "throws",
    });

    const { status, body } = await install({ id: "x/algorithmic-art" });
    expect(status).toBe(409);
    expect(body.code).toBe("rollback_incomplete");
    // The missing files are still named — the customer loses no information.
    expect((body.missingFiles as unknown as string[]) ?? []).toContain("templates/viewer.html");
    expect(Object.keys(await readLock())).toEqual(["algorithmic-art"]);
  });
});
