import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Report B — "hermes timed out" on install.
 *
 * A skill fetched from GitHub (every browse.sh row) goes over the
 * unauthenticated GitHub API — 60 req/hr, slow on a Jetson — so
 * `hermes skills install` genuinely runs tens of seconds and can pass
 * INSTALL_TIMEOUT_MS. runHermesCli then SIGKILLs the child and throws
 * "hermes timed out", discarding stdout/stderr. The old catch answered with
 * that bare phrase and stopped — but the kill RACES the install: the files and
 * the lock entry can already be on disk. That is the same trap PR #504/#510
 * closed for the exit-0 refusal path (the CLI's word is not the truth about
 * what landed — the lock is), one layer up.
 *
 * These faithful fakes reject with "hermes timed out" exactly as runHermesCli
 * does on SIGKILL — one after the install has already written the lock, one
 * before it wrote anything.
 */
vi.mock("@/lib/harness", () => ({
  getActiveHarness: vi.fn(async () => "hermes"),
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));
vi.mock("@/lib/hermes-cli", async () => {
  const actual = await vi.importActual<typeof import("@/lib/hermes-cli")>("@/lib/hermes-cli");
  return { ...actual, runHermesCli: vi.fn() };
});
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

const SLUG = "slow-skill";

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

/** Write a landed skill exactly as the ClawHub adapter would. */
async function landSkill(): Promise<void> {
  const dir = path.join(skillsDir(), SLUG);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${SLUG}\n---\ndoes a slow thing\n`);
  const lock = await readLock();
  lock[SLUG] = {
    install_path: SLUG,
    files: ["SKILL.md"],
    identifier: SLUG,
    source: "clawhub",
    trust_level: "community",
    scan_verdict: "safe",
  };
  await writeLock(lock);
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
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

beforeEach(async () => {
  vi.resetModules();
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-timeout-"));
  clawboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-root-timeout-"));
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

describe("POST /setup-api/hermes/skills/install — a timeout must not lie about the outcome", () => {
  it("reports SUCCESS when the skill landed before the CLI was killed", async () => {
    // The race: files + lock written, THEN SIGKILL → "hermes timed out".
    mockCli.mockImplementation(async () => {
      await landSkill();
      throw new Error("hermes timed out");
    });

    const res = await install({ id: SLUG });

    // Old behaviour: 502 { error: "hermes timed out" } — a false failure for a
    // skill that is on the device. The lock is the truth.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: SLUG, name: SLUG });
    await expect(readLock()).resolves.toHaveProperty(SLUG);
  });

  it("answers with an actionable deadline message when nothing landed", async () => {
    mockCli.mockRejectedValue(new Error("hermes timed out"));

    const res = await install({ id: SLUG });

    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ code: "install_timeout" });
    // The customer never sees the CLI's word for its own SIGKILL.
    expect(res.body.error).not.toMatch(/hermes timed out/i);
    expect(res.body.error).toMatch(/too long|try again/i);
    await expect(readLock()).resolves.not.toHaveProperty(SLUG);
  });

  it("still 502s on a non-timeout spawn failure (unchanged)", async () => {
    mockCli.mockRejectedValue(new Error("Hermes is not installed on this device"));

    const res = await install({ id: SLUG });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: "Hermes is not installed on this device" });
  });
});

// HERMES-04. The two answers this route composed without a code — the CLI it
// could not run, and the CLI that exited non-zero — now carry one, so the store
// can say them in the owner's language instead of painting the sentence.
describe("a CLI the install route could not run carries a code", () => {
  it("names a missing binary cli_missing", async () => {
    mockCli.mockRejectedValue(new Error("Hermes is not installed on this device"));

    const res = await install({ id: SLUG });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "cli_missing" });
  });

  it("names a non-zero exit install_failed, keeping the traceback for the log", async () => {
    mockCli.mockResolvedValue({ code: 1, stdout: "", stderr: "Traceback (most recent call last):" });

    const res = await install({ id: SLUG });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "install_failed" });
    expect(String(res.body.error)).not.toMatch(/Traceback/);
  });
});
