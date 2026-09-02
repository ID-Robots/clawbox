import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-547 — the uninstall route answered `{"ok":true}` for skills it never
 * removed, because it read the CLI's EXIT CODE and `hermes skills uninstall`
 * exits 0 whether it removed the skill or refused to. `do_uninstall`
 * (hermes_cli/skills_hub.py:1222) prints `uninstall_skill`'s refusal
 * (tools/skills_hub.py:4081) and returns — so asking to remove a builtin, a
 * name that does not exist, or a skill whose lock entry the path validator
 * rejects all came back as success, and the store's UI told the customer the
 * skill was gone while the device still had it. The exact defect class
 * PR #504 fixed for install; the install route's own rollback comment already
 * recorded the fact for uninstall.
 *
 * The CLI is faked FAITHFULLY from the deployed hermes-agent: exit 0 always,
 * the outcome only in the printed sentence, the lock entry removed only on a
 * real uninstall.
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

let hermesHome: string;

const INSTALLED = "oo-terraform";

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

/**
 * `hermes skills uninstall`, exactly as the box runs it: the confirmation
 * prompt on stdout, exit 0 no matter what, and the outcome only in prose.
 * An entry whose install_path the validator would reject is refused with the
 * raw exception string, and its lock entry survives.
 */
function fakeHermes(): void {
  mockCli.mockImplementation(async (args: string[]) => {
    if (args[1] !== "uninstall") return { code: 0, stdout: "", stderr: "" };
    const name = args[2];
    const prompt = `\nUninstall '${name}'?\nConfirm [y/N]: `;
    const lock = await readLock();
    const entry = lock[name] as { install_path?: string } | undefined;
    if (!entry) {
      return {
        code: 0,
        stdout: `${prompt}Error: '${name}' is not a hub-installed skill (may be a builtin)\n`,
        stderr: "",
      };
    }
    if ((entry.install_path ?? "").includes("..")) {
      return {
        code: 0,
        stdout:
          `${prompt}Error: Refusing to uninstall '${name}': lock entry install_path `
          + `'${entry.install_path}' escapes the skills directory\n`,
        stderr: "",
      };
    }
    delete lock[name];
    await writeLock(lock);
    return {
      code: 0,
      stdout: `${prompt}Uninstalled '${name}' from ${name}\n`,
      stderr: "",
    };
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

let restoreEnv: () => void;

beforeEach(async () => {
  vi.resetModules();
  restoreEnv = saveEnv("HERMES_HOME", "CLAWBOX_ROOT");
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-uninst-"));
  process.env.HERMES_HOME = hermesHome;
  await fs.mkdir(skillsDir(), { recursive: true });
  await writeLock({
    [INSTALLED]: {
      install_path: INSTALLED,
      files: ["SKILL.md"],
      identifier: INSTALLED,
      source: "clawhub",
      trust_level: "community",
      scan_verdict: "safe",
    },
  });
  fakeHermes();
});

afterEach(async () => {
  restoreEnv();
  await fs.rm(hermesHome, { recursive: true, force: true });
});

describe("POST …/skills/uninstall — a refusal is not a success", () => {
  it("does not report success for a name the device never had", async () => {
    const res = await uninstall("no-such-skill");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "not_installed" });
    expect(res.body.ok).toBeUndefined();
  });

  it("says a skill that came with the device cannot be removed", async () => {
    // `.bundled_manifest` is `name:hash` per line — the shipped skills.
    await fs.writeFile(path.join(skillsDir(), ".bundled_manifest"), "pdf:abc123\nqr:def456\n");

    const res = await uninstall("pdf");

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "builtin_skill" });
    expect(String(res.body.error)).toMatch(/came with this device/i);
  });

  it("reports the lock-path validator's refusal without echoing its exception", async () => {
    await writeLock({
      poisoned: { install_path: "../../.ssh", identifier: "poisoned", source: "clawhub" },
    });

    const res = await uninstall("poisoned");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "uninstall_refused" });
    expect(JSON.stringify(res.body)).not.toContain(".ssh");
    expect(JSON.stringify(res.body)).not.toContain("escapes the skills directory");
  });

  it("does not report success when the CLI says something unrecognised and the lock still holds the skill", async () => {
    mockCli.mockResolvedValue({ code: 0, stdout: "a sentence from a future CLI\n", stderr: "" });

    const res = await uninstall(INSTALLED);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "uninstall_failed" });
    expect(await readLock()).toHaveProperty(INSTALLED);
  });

  it("does not report success when the confirmation was not accepted", async () => {
    mockCli.mockResolvedValue({
      code: 0,
      stdout: `\nUninstall '${INSTALLED}'?\nConfirm [y/N]: Cancelled.\n`,
      stderr: "",
    });

    const res = await uninstall(INSTALLED);

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "uninstall_failed" });
  });
});

describe("POST …/skills/uninstall — a real uninstall still works", () => {
  it("answers ok and the lock entry is gone", async () => {
    const res = await uninstall(INSTALLED);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: INSTALLED, name: INSTALLED });
    expect(await readLock()).not.toHaveProperty(INSTALLED);
  });

  it("accepts a wording change from a future CLI when the lock proves the removal", async () => {
    mockCli.mockImplementation(async (args: string[]) => {
      const lock = await readLock();
      delete lock[args[2]];
      await writeLock(lock);
      return { code: 0, stdout: "Skill removed.\n", stderr: "" };
    });

    const res = await uninstall(INSTALLED);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it("names a CLI it could not run by code, for the store to say in the owner's language", async () => {
    // HERMES-04: the generic catch used to answer the CLI's own sentence and
    // nothing else.
    mockCli.mockRejectedValue(new Error("Hermes is not installed on this device"));

    const res = await uninstall(INSTALLED);

    expect(res.status).toBe(502);
    expect(res.body.code).toBe("cli_missing");
  });

  it("still answers 502 for a non-zero exit", async () => {
    mockCli.mockResolvedValue({ code: 1, stdout: "", stderr: "Traceback (most recent call last)" });

    const res = await uninstall(INSTALLED);

    expect(res.status).toBe(502);
    expect(String(res.body.error)).not.toContain("Traceback");
  });
});
