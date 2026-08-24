import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-453 round 2 — a ClawHub id that `skill_search` returned could not be
 * installed, so the agent's only documented next step was a loop.
 *
 * Live on the QA box, 2026-08-24:
 *   skill_search "qr code" -> {"id":"qrcode-decode","source":"clawhub", ...}
 *   skill_install qrcode-decode
 *     -> {"code":"NOT_FOUND","message":"That skill id did not resolve.",
 *         "next":"Call skill_search, then pass the exact id it returned."}
 *   POST /setup-api/hermes/skills/install {"id":"qrcode-decode"} -> HTTP 502
 *
 * The CLI is faked FAITHFULLY here: it installs when it is handed an argument
 * containing a slash, and — exactly like the shipped
 * `_resolve_short_name()` — prints a "did you mean" table and exits 0 having
 * installed NOTHING when handed a bare name whose catalog NAME does not match.
 * That is the behaviour the route has to work around, so the test asserts
 * against it rather than against a mock of the fix.
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

const SLUG = "qrcode-decode";

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

/**
 * `hermes skills install`, as it actually behaves for a ClawHub row.
 *
 * A slash-less argument is routed through short-name resolution, which matches
 * on the catalog NAME ("QR Code Decode"), never on the slug — so it exits 0
 * with a suggestion table and an untouched lock. `clawhub/<slug>` has a slash,
 * so it goes straight to the ClawHub adapter and installs, recording the bare
 * slug as both the lock key and the identifier (SkillBundle(name=slug,
 * identifier=slug) in tools/skills_hub.py).
 */
function fakeHermes(): void {
  mockCli.mockImplementation(async (args: string[]) => {
    if (args[1] !== "install") return { code: 0, stdout: "", stderr: "" };
    const arg = args[2];
    if (!arg.includes("/")) {
      return {
        code: 0,
        stdout: `No exact match for '${arg}'. Did you mean one of these?\n  QR Code Decode — ${SLUG}\n`,
        stderr: "",
      };
    }
    const dir = path.join(skillsDir(), SLUG);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: qrcode-detect\n---\ndecode qr codes\n`);
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
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

/** The argument the route actually handed the CLI. */
function installArg(): string | undefined {
  const call = mockCli.mock.calls.find((c) => (c[0] as string[])[1] === "install");
  return call ? (call[0] as string[])[2] : undefined;
}

beforeEach(async () => {
  vi.resetModules();
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-clawhub-"));
  clawboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-root-clawhub-"));
  process.env.HERMES_HOME = hermesHome;
  process.env.CLAWBOX_ROOT = clawboxRoot;
  await fs.mkdir(skillsDir(), { recursive: true });
  await writeLock({});
  mockRecord.mockResolvedValue(undefined);
  fakeHermes();
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(hermesHome, { recursive: true, force: true });
  await fs.rm(clawboxRoot, { recursive: true, force: true });
});

describe("POST /setup-api/hermes/skills/install — ClawHub ids from search", () => {
  it("installs a bare ClawHub slug that search returned", async () => {
    mockRecord.mockResolvedValue({
      id: SLUG,
      name: "QR Code Decode",
      source: "clawhub",
      trust: "community",
      tags: [],
      hay: "",
    } as unknown as Awaited<ReturnType<typeof getCatalogRecord>>);

    const res = await install({ id: SLUG });

    expect(installArg()).toBe(`clawhub/${SLUG}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: SLUG, name: SLUG });
    await expect(readLock()).resolves.toHaveProperty(SLUG);
  });

  it("works on a device whose catalog index has not been built yet", async () => {
    // The browse route's degraded CLI path returns rows with no catalog record
    // behind them; a bare slug still can only be a ClawHub one.
    mockRecord.mockResolvedValue(undefined);

    const res = await install({ id: SLUG });

    expect(installArg()).toBe(`clawhub/${SLUG}`);
    expect(res.status).toBe(200);
  });

  it("leaves a prefixed id from any other registry untouched", async () => {
    mockRecord.mockResolvedValue({
      id: "NVIDIA/skills/skills/aiq-deploy",
      name: "aiq-deploy",
      source: "github",
      trust: "community",
      tags: [],
      hay: "",
    } as unknown as Awaited<ReturnType<typeof getCatalogRecord>>);

    await install({ id: "NVIDIA/skills/skills/aiq-deploy" });

    expect(installArg()).toBe("NVIDIA/skills/skills/aiq-deploy");
  });

  it("still 502s when the CLI genuinely installs nothing", async () => {
    // The un-mapped shape: no slash reaches the adapter, the lock stays empty.
    mockCli.mockResolvedValue({ code: 0, stdout: "No exact match", stderr: "" });

    const res = await install({ id: SLUG });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/could not be resolved/i) });
  });
});
