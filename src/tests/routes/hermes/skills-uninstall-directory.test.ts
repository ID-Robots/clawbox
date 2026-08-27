import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Removing a Hermes skill has TWO halves, and the uninstall route only ever
 * checked one.
 *
 * PR #517 rewrote the install route's `rollback()` around exactly that rule:
 * `hermes skills uninstall` removes the LOCK ENTRY, and "a skill directory left
 * behind would be loaded by the agent even with no lock entry" — so the rollback
 * removes the directory itself and re-stats it, and answers `rollback_incomplete`
 * when it survives.
 *
 * The uninstall route drives the SAME command and applied only the first half:
 * it re-read the lock, saw the entry gone and answered `{"ok":true}`. On the
 * device state #517's own test covers — a lock entry whose `install_path` the
 * path validator refuses, or an `fs.rm` that cannot traverse a root-owned
 * subtree, "the case this device family produces" — the CLI drops the entry and
 * leaves the files. The route then reported a successful removal while the skill
 * was still on disk, and:
 *
 *   * `enumerateInstalledSkills` re-lists the leftover directory as origin
 *     `local`, so the store shows it again under a padlock;
 *   * `HermesSkillsStore.uninstallTargetFor` refuses to offer Remove for
 *     anything whose origin is not `hub`, so the customer can no longer remove
 *     the skill the agent is still loading;
 *   * MCP `skill_uninstall`'s post-condition counts that same `local` row and
 *     answers CONFLICT — so the two surfaces contradict each other.
 *
 * The CLI is faked FAITHFULLY: exit 0 always, the outcome only in prose, the
 * lock entry dropped on a real uninstall, and the directory removed only when
 * the path the lock recorded stays inside the skills tree — which is precisely
 * what the deployed CLI's own validator enforces.
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

import { runHermesCli } from "@/lib/hermes-cli";
import { saveEnv } from "../../helpers/env";

const mockCli = vi.mocked(runHermesCli);

const NAME = "oo-terraform";
const DIR = "oo-terraform";

let hermesHome: string;

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

async function readLock(): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(skillsDir(), ".hub", "lock.json"), "utf8");
  return (JSON.parse(raw) as { installed: Record<string, unknown> }).installed;
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

/**
 * `hermes skills uninstall` as the box runs it: it drops its own lock entry and
 * prints a success sentence, and it deletes the directory ONLY when the path the
 * lock recorded resolves inside the skills tree — the same refusal the deployed
 * validator makes.
 */
function fakeHermes(): void {
  mockCli.mockImplementation(async (args: string[]) => {
    if (args[1] !== "uninstall") return { code: 0, stdout: "", stderr: "" };
    const name = args[2];
    const lock = await readLock();
    const entry = lock[name] as { install_path?: string } | undefined;
    if (!entry) {
      return {
        code: 0,
        stdout: `Error: '${name}' is not a hub-installed skill (may be a builtin)\n`,
        stderr: "",
      };
    }
    delete lock[name];
    await writeLock(lock);
    const recorded = path.resolve(skillsDir(), entry.install_path ?? "");
    if (entry.install_path && recorded.startsWith(skillsDir() + path.sep)) {
      await fs.rm(recorded, { recursive: true, force: true });
    }
    return { code: 0, stdout: `Uninstalled '${name}' from ${name}\n`, stderr: "" };
  });
}

async function uninstall(id: string) {
  const { POST } = await import("@/app/setup-api/hermes/skills/uninstall/route");
  const res = await POST(
    new Request("http://localhost/setup-api/hermes/skills/uninstall", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Put the skill on disk and describe it in the lock. */
async function seed(installPath: string | undefined): Promise<void> {
  await fs.mkdir(path.join(skillsDir(), DIR), { recursive: true });
  await fs.writeFile(
    path.join(skillsDir(), DIR, "SKILL.md"),
    "---\nname: oo-terraform\ndescription: plans terraform\n---\nrun terraform\n",
  );
  await writeLock({
    [NAME]: {
      ...(installPath === undefined ? {} : { install_path: installPath }),
      files: ["SKILL.md"],
      identifier: NAME,
      source: "clawhub",
      trust_level: "community",
      scan_verdict: "safe",
    },
  });
}

let restoreEnv: () => void;

beforeEach(async () => {
  vi.resetModules();
  restoreEnv = saveEnv("HERMES_HOME", "CLAWBOX_ROOT");
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-uninst-dir-"));
  process.env.HERMES_HOME = hermesHome;
  await fs.mkdir(skillsDir(), { recursive: true });
  fakeHermes();
});

afterEach(async () => {
  restoreEnv();
  await fs.rm(hermesHome, { recursive: true, force: true });
});

describe("POST …/skills/uninstall — a clean lock is only half a removal", () => {
  it("does not report a removal while the skill directory is still on disk", async () => {
    // The lock entry the path validator refuses: the CLI drops the entry and
    // leaves the files exactly where the agent reads them.
    await seed("oo-terraform/../../escape");

    const res = await uninstall(NAME);

    expect(await readLock()).not.toHaveProperty(NAME);
    expect(await exists(path.join(skillsDir(), DIR, "SKILL.md"))).toBe(true);
    expect(res.body.ok).not.toBe(true);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("removal_incomplete");
    expect(res.body.leftover).toMatchObject({ lockEntry: false, directory: "present" });
  });

  it("tells the customer where the leftover can actually be dealt with", async () => {
    await seed("oo-terraform/../../escape");

    const res = await uninstall(NAME);

    // The store cannot offer Remove for it any more, so "remove it from the
    // Skills store" would be advice that cannot be followed.
    expect(String(res.body.error)).toMatch(/still on the device/i);
    expect(String(res.body.error)).toMatch(/deleted on the device/i);
    expect(String(res.body.error)).not.toMatch(/remove .* from the Skills store/i);
    // Nothing device-internal is echoed: the refused path came from the lock.
    expect(JSON.stringify(res.body)).not.toContain("escape");
    expect(JSON.stringify(res.body)).not.toContain(hermesHome);
  });

  it("does not answer success while the store re-lists the leftover as a local skill", async () => {
    await seed("oo-terraform/../../escape");

    const res = await uninstall(NAME);

    const { enumerateInstalledSkills } = await import("@/lib/hermes-skills-server");
    const listed = (await enumerateInstalledSkills()).find((s) => s.id === NAME);
    // This is what the customer is left looking at: a skill the agent still
    // loads, now with an origin the store will not offer to remove.
    expect(listed).toMatchObject({ origin: "local" });
    expect(res.body.ok).not.toBe(true);
  });

  it("removes the directory the CLI left behind when the recorded path allows it", async () => {
    // The other half of the same rule: the route does not merely report the
    // leftover, it takes the same second swing `rollback()` takes.
    await seed(DIR);
    mockCli.mockImplementation(async (args: string[]) => {
      if (args[1] !== "uninstall") return { code: 0, stdout: "", stderr: "" };
      // The CLI drops the entry and its `fs.rm` does nothing — the root-owned
      // subtree case, where the removal it believes it made never happened.
      const lock = await readLock();
      delete lock[args[2]];
      await writeLock(lock);
      return { code: 0, stdout: `Uninstalled '${args[2]}' from ${args[2]}\n`, stderr: "" };
    });

    const res = await uninstall(NAME);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(await exists(path.join(skillsDir(), DIR))).toBe(false);
  });
});

describe("POST …/skills/uninstall — a real removal is still a success", () => {
  it("answers ok when both halves are gone", async () => {
    await seed(DIR);

    const res = await uninstall(NAME);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: NAME, name: NAME });
    expect(await readLock()).not.toHaveProperty(NAME);
    expect(await exists(path.join(skillsDir(), DIR))).toBe(false);
  });

  it("does not turn an unverifiable directory into a failure", async () => {
    // No install_path: nothing was checked, and "not checked" is not "left
    // behind". The lock entry — the only thing the store lists — is gone.
    await seed(undefined);

    const res = await uninstall(NAME);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(res.body.code).not.toBe("removal_incomplete");
  });
});
