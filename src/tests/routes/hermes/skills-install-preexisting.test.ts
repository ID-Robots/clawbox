import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `rollback()` may only undo what THIS request did.
 *
 * PR #517 taught the install route to report a rollback it could not complete.
 * It did not establish that there was anything of this route's to roll back.
 * `hermes skills install` on an already-installed skill exits 0 printing "is
 * already installed" and writes nothing — #517's own faithful fake reproduces
 * exactly that ("The installer will not write over its own lock entry"). The
 * pre-existing entry then makes `landed` true, the scan gate re-reads that
 * entry's STORED verdict, `isFlaggedVerdict` treats anything outside
 * CLEAN_VERDICTS as flagged — `caution` included, which is most of ClawHub —
 * and with no `confirmDangerous` the route rolled back, uninstalling a skill the
 * customer already had, including one they had previously confirmed through the
 * danger dialog. It then said "This skill did not pass the device's security
 * scan", describing an install it never made.
 *
 * Reachable from MCP with no UI at all: `skill_install` has no installed-list
 * pre-condition (unlike `skill_uninstall`, which has one), so an agent asked
 * twice to install the same skill destroys the existing installation.
 *
 * The second half of the same file: the post-condition #517 added asks "did the
 * entry we tried to remove survive?" but answered it with `isInHubLock(lockName,
 * entry.identifier)`, whose identifier arm scans EVERY entry. `lockName` came
 * out of the lock, so the CLI can only have removed that one key — the identifier
 * arm can therefore only produce FALSE POSITIVES, and a second copy of the same
 * store id under a different lock key turns a clean rollback into
 * `rollback_incomplete`.
 *
 * The CLI is faked FAITHFULLY, from the same observations #517's fake was built
 * on: it refuses to overwrite its own lock entry, it honours `--name`, and its
 * uninstall removes the lock key and the directory that key recorded.
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
import { saveEnv } from "../../helpers/env";

const mockCli = vi.mocked(runHermesCli);
const mockRecord = vi.mocked(getCatalogRecord);

let hermesHome: string;
let clawboxRoot: string;

function skillsDir(): string {
  return path.join(hermesHome, "skills");
}

async function writeLock(installed: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.join(skillsDir(), ".hub"), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir(), ".hub", "lock.json"),
    JSON.stringify({ version: 1, installed }),
  );
}

async function readLock(): Promise<Record<string, Record<string, unknown>>> {
  const raw = await fs.readFile(path.join(skillsDir(), ".hub", "lock.json"), "utf8");
  return (JSON.parse(raw) as { installed: Record<string, Record<string, unknown>> }).installed;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function writeSkill(installPath: string, body: string): Promise<void> {
  const dir = path.join(skillsDir(), installPath);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), body);
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

/**
 * The device's installer and uninstaller, as observed on the box.
 *
 * install:   refuses to overwrite its own lock entry (exit 0, "is already
 *            installed"); otherwise writes the files and the lock entry under
 *            the `--name` key when one is given.
 * uninstall: removes the lock key and the directory that key recorded, and will
 *            not delete a path that escapes the skills tree.
 */
function fakeHermes(newInstall: {
  /** The lock key the installer would use when no `--name` is passed. */
  defaultName: string;
  installPath: string;
  files: Record<string, string>;
  lock: Record<string, unknown>;
}): void {
  mockCli.mockImplementation(async (args: string[]) => {
    if (args[1] === "install") {
      const nameFlag = args.indexOf("--name");
      const key = nameFlag > -1 ? args[nameFlag + 1] : newInstall.defaultName;
      const lock = await readLock();
      if (Object.prototype.hasOwnProperty.call(lock, key)) {
        return { code: 0, stdout: `Skill '${key}' is already installed\n`, stderr: "" };
      }
      const installPath = nameFlag > -1 ? key : newInstall.installPath;
      for (const [rel, content] of Object.entries(newInstall.files)) {
        const abs = path.join(skillsDir(), installPath, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
      lock[key] = {
        install_path: installPath,
        files: Object.keys(newInstall.files),
        ...newInstall.lock,
      };
      await writeLock(lock);
      return { code: 0, stdout: `Installed '${key}'\n`, stderr: "" };
    }
    if (args[1] === "uninstall") {
      const lock = await readLock();
      const entry = lock[args[2]] as { install_path?: string } | undefined;
      if (!entry) {
        return { code: 0, stdout: `Error: '${args[2]}' is not a hub-installed skill\n`, stderr: "" };
      }
      delete lock[args[2]];
      await writeLock(lock);
      const recorded = path.resolve(skillsDir(), entry.install_path ?? "");
      if (entry.install_path && recorded.startsWith(skillsDir() + path.sep)) {
        await fs.rm(recorded, { recursive: true, force: true });
      }
      return { code: 0, stdout: `Uninstalled '${args[2]}'\n`, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

async function install(body: Record<string, unknown>) {
  const { POST } = await import("@/app/setup-api/hermes/skills/install/route");
  const res = await POST(
    new Request("http://localhost/setup-api/hermes/skills/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

let restoreEnv: () => void;

beforeEach(async () => {
  vi.resetModules();
  restoreEnv = saveEnv("HERMES_HOME", "CLAWBOX_ROOT");
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-pre-"));
  clawboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-root-pre-"));
  process.env.HERMES_HOME = hermesHome;
  process.env.CLAWBOX_ROOT = clawboxRoot;
  await fs.mkdir(skillsDir(), { recursive: true });
  await writeLock({});
  mockRecord.mockResolvedValue(undefined);
});

afterEach(async () => {
  restoreEnv();
  await fs.rm(hermesHome, { recursive: true, force: true });
  await fs.rm(clawboxRoot, { recursive: true, force: true });
});

// ── An install request may not remove an install it did not make ────────────

describe("a re-install of a skill the device already has removes nothing", () => {
  /** The customer's existing, complete, flagged install. */
  async function seedFlagged(verdict: string): Promise<void> {
    await writeSkill("creative/simple-english", "---\nname: simple-english\n---\nplain english\n");
    await writeLock({
      "simple-english": {
        install_path: "creative/simple-english",
        files: ["SKILL.md"],
        identifier: "official/creative/simple-english",
        source: "official",
        trust_level: "builtin",
        scan_verdict: verdict,
        scan_provenance: { ...DANGEROUS_SCAN, verdict },
      },
    });
    fakeHermes({
      defaultName: "simple-english",
      installPath: "creative/simple-english",
      files: { "SKILL.md": "---\nname: simple-english\n---\nplain english\n" },
      lock: { identifier: "official/creative/simple-english", scan_verdict: verdict },
    });
  }

  it("leaves the lock entry and the files alone on an unconfirmed second install", async () => {
    await seedFlagged("dangerous");

    await install({ id: "official/creative/simple-english" });

    // The whole defect in two assertions: the customer's skill is still there.
    expect(Object.keys(await readLock())).toEqual(["simple-english"]);
    expect(await exists(path.join(skillsDir(), "creative", "simple-english", "SKILL.md"))).toBe(
      true,
    );
  });

  it("says the skill is already installed rather than refusing an install it never made", async () => {
    await seedFlagged("dangerous");

    const { status, body } = await install({ id: "official/creative/simple-english" });

    expect(status).toBe(409);
    expect(body.code).toBe("already_installed");
    expect(body.code).not.toBe("dangerous_skill");
    // Nothing to confirm: confirming would ask the device to install a skill it
    // already has, and the answer must not read as though it had been removed.
    expect(body.requiresConfirmation).not.toBe(true);
    expect(String(body.error)).toMatch(/already installed/i);
    // The scan verdict is still carried, so the store can still say WHY the
    // device is unhappy about a skill the customer is keeping.
    expect(body.warning).toBeTruthy();
  });

  it("treats a caution verdict the same way — that is most of the community catalogue", async () => {
    await seedFlagged("caution");

    const { body } = await install({ id: "official/creative/simple-english" });

    expect(Object.keys(await readLock())).toEqual(["simple-english"]);
    expect(body.code).toBe("already_installed");
  });

  it("does not delete an existing install because its file list is short", async () => {
    // The route's OTHER rollback caller, reached with a clean verdict: a skill
    // whose SKILL.md names a support file the installer never fetched. That is a
    // reason to tell the customer, not a licence to remove what they had.
    await writeSkill(
      "algorithmic-art",
      "---\nname: algorithmic-art\n---\nSee the [viewer](templates/viewer.html).\n",
    );
    await writeLock({
      "algorithmic-art": {
        install_path: "algorithmic-art",
        files: ["SKILL.md"],
        identifier: "x/algorithmic-art",
        source: "clawhub",
        trust_level: "community",
        scan_verdict: "safe",
      },
    });
    fakeHermes({
      defaultName: "algorithmic-art",
      installPath: "algorithmic-art",
      files: { "SKILL.md": "---\nname: algorithmic-art\n---\n" },
      lock: { identifier: "x/algorithmic-art", scan_verdict: "safe" },
    });

    const { status, body } = await install({ id: "x/algorithmic-art" });

    expect(Object.keys(await readLock())).toEqual(["algorithmic-art"]);
    expect(await exists(path.join(skillsDir(), "algorithmic-art", "SKILL.md"))).toBe(true);
    expect(status).toBe(502);
    expect(body.code).toBe("incomplete_install");
    // …and the message may not claim the skill was not installed, because it is.
    expect(String(body.error)).not.toMatch(/was not installed/i);
    expect(String(body.error)).toMatch(/left in place|left alone|already/i);
  });

  it("still rolls back an install this request DID make", async () => {
    // The guard against over-correcting: with nothing pre-existing, a flagged
    // first install is still undone and still answered `dangerous_skill`.
    fakeHermes({
      defaultName: "simple-english",
      installPath: "creative/simple-english",
      files: { "SKILL.md": "---\nname: simple-english\n---\nplain english\n" },
      lock: {
        identifier: "official/creative/simple-english",
        source: "official",
        trust_level: "builtin",
        scan_verdict: "dangerous",
        scan_provenance: DANGEROUS_SCAN,
      },
    });

    const { status, body } = await install({ id: "official/creative/simple-english" });

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "dangerous_skill", requiresConfirmation: true });
    expect(await readLock()).toEqual({});
    expect(await exists(path.join(skillsDir(), "creative", "simple-english"))).toBe(false);
  });
});

// ── The post-condition has to ask about the KEY it tried to remove ──────────

describe("a rollback that removed its own entry is not incomplete", () => {
  it("is not failed by a different lock key that shares the identifier", async () => {
    // The customer already runs this skill under its default name. The store id
    // is installed a second time under an explicit `--name`, and the device
    // records the adapter's normalised identifier on both.
    await writeSkill("creative/simple-english", "---\nname: simple-english\n---\nplain english\n");
    await writeLock({
      "simple-english": {
        install_path: "creative/simple-english",
        files: ["SKILL.md"],
        identifier: "creative/simple-english",
        source: "official",
        trust_level: "builtin",
        scan_verdict: "safe",
      },
    });
    fakeHermes({
      defaultName: "simple-english",
      installPath: "creative/simple-english",
      files: { "SKILL.md": "---\nname: simple-english\n---\nplain english\n" },
      lock: {
        identifier: "creative/simple-english",
        source: "official",
        trust_level: "builtin",
        scan_verdict: "dangerous",
        scan_provenance: DANGEROUS_SCAN,
      },
    });

    const { status, body } = await install({
      id: "official/creative/simple-english",
      name: "simple-english-2",
    });

    // The rollback did its whole job: its own key and its own directory are gone.
    expect(Object.keys(await readLock())).toEqual(["simple-english"]);
    expect(await exists(path.join(skillsDir(), "simple-english-2"))).toBe(false);
    // So the customer must get the confirmation dialog, not an instruction to
    // remove something from a store that no longer lists it.
    expect(status).toBe(409);
    expect(body.code).toBe("dangerous_skill");
    expect(body.code).not.toBe("rollback_incomplete");
    expect(body.requiresConfirmation).toBe(true);
  });

  it("still reports a leftover when the key itself survived", async () => {
    // The guard on the other side: a rollback the CLI would not carry out is
    // still reported, identifier arm or no identifier arm.
    fakeHermes({
      defaultName: "simple-english",
      installPath: "creative/simple-english",
      files: { "SKILL.md": "---\nname: simple-english\n---\nplain english\n" },
      lock: {
        identifier: "official/creative/simple-english",
        source: "official",
        trust_level: "builtin",
        scan_verdict: "dangerous",
        scan_provenance: DANGEROUS_SCAN,
      },
    });
    mockCli.mockImplementationOnce(async (args: string[]) => {
      // The install runs for real; the uninstall that follows throws (the 30 s
      // timeout on a loaded Jetson).
      const lock = await readLock();
      await fs.mkdir(path.join(skillsDir(), "creative", "simple-english"), { recursive: true });
      await fs.writeFile(
        path.join(skillsDir(), "creative", "simple-english", "SKILL.md"),
        "---\nname: simple-english\n---\nplain english\n",
      );
      lock["simple-english"] = {
        install_path: "creative/simple-english",
        files: ["SKILL.md"],
        identifier: "official/creative/simple-english",
        source: "official",
        trust_level: "builtin",
        scan_verdict: "dangerous",
        scan_provenance: DANGEROUS_SCAN,
      };
      await writeLock(lock);
      expect(args[1]).toBe("install");
      return { code: 0, stdout: "", stderr: "" };
    });
    mockCli.mockImplementationOnce(async () => {
      throw new Error("hermes skills uninstall timed out after 30000ms");
    });

    const { status, body } = await install({ id: "official/creative/simple-english" });

    expect(status).toBe(409);
    expect(body.code).toBe("rollback_incomplete");
    expect(Object.keys(await readLock())).toEqual(["simple-english"]);
  });
});
