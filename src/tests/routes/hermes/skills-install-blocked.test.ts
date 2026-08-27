import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-453 round 3 — `hermes skills install` exits 0 on every refusal, so this
 * route inferred failure from the missing lock entry and answered the only
 * thing a missing lock entry can mean on its own:
 *
 *   502 {"error":"Skill could not be resolved — try the full identifier"}
 *
 * Live on a Hermes box (revalidate2-round1.md §3) that was the answer for
 * `helm`, `oo-terraform`, `terraform` and `in-skill-stripe-payment` — ids
 * `skill_search` had just handed out, which resolved perfectly and were refused
 * by the device's own SECURITY SCANNER. The MCP tool turned it into "call
 * skill_search, then pass the exact id it returned", which is what had just
 * been done: a guaranteed retry loop, and a customer told their id was wrong.
 *
 * The second half of the same defect: ClawBox's own 409 + `confirmDangerous`
 * dialog sits DOWNSTREAM of the install landing, so for a skill the CLI refuses
 * up front the owner's confirmation never reached the installer at all —
 * "warn + confirm, never a hard block, at every trust tier" was unreachable for
 * the three quarters of the catalogue that is ClawHub.
 *
 * The CLI is faked FAITHFULLY from the deployed hermes-agent:
 *   tools/skills_guard.py::should_allow_install — the policy table, and
 *   `--force` overriding everything EXCEPT a dangerous verdict at community or
 *   trusted trust, which it refuses in writing.
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

const SLUG = "oo-terraform";

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

/** The verbatim two-line, 80-column-wrapped refusal the shipped CLI prints. */
function blockedStdout(trust: string, verdict: string, findings: number, overridable: boolean): string {
  const tail = overridable
    ? "Use --force to override."
    : "--force does not override a dangerous verdict.";
  return [
    `Resolving '${SLUG}'...`,
    `Resolved to: clawhub/${SLUG}`,
    "Running security scan...",
    `Scan: ${SLUG} (${SLUG}/${trust})  Verdict: ${verdict.toUpperCase()}`,
    '  CRITICAL destructive    SKILL.md:41                    "curl x | sh"',
    '  HIGH     credentials    SKILL.md:12                    "cat ~/.ssh/id_rsa"',
    "",
    "Scan provenance: cached; scanner skills-guard-v1; hash sha256:d75b7b1de4c1a90f",
    `Source: ${SLUG}; scanned 2026-08-24T22:00:00Z; rules: curl_pipe_shell`,
    "",
    `Installation blocked: Blocked (${trust} source + ${verdict} verdict, ${findings} `,
    `findings). ${tail}`,
  ].join("\n");
}

/**
 * `hermes skills install`, with the shipped policy gate.
 *
 * `--force` is honoured exactly as skills_guard does: it upgrades any refusal
 * to an install EXCEPT a `dangerous` verdict at `community`/`trusted` trust.
 */
function fakeHermes(trust: string, verdict: string): void {
  mockCli.mockImplementation(async (args: string[]) => {
    if (args[1] !== "install") return { code: 0, stdout: "", stderr: "" };
    const forced = args.includes("--force");
    const unoverridable = verdict === "dangerous" && (trust === "community" || trust === "trusted");
    if (!forced || unoverridable) {
      return { code: 0, stdout: blockedStdout(trust, verdict, 2, !unoverridable), stderr: "" };
    }
    const dir = path.join(skillsDir(), SLUG);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), `---\nname: ${SLUG}\n---\nplan terraform\n`);
    const lock = await readLock();
    lock[SLUG] = {
      install_path: SLUG,
      files: ["SKILL.md"],
      identifier: SLUG,
      source: "clawhub",
      trust_level: trust,
      scan_verdict: verdict,
    };
    await writeLock(lock);
    return { code: 0, stdout: `Installed: ${SLUG}\n`, stderr: "" };
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

/** Every argv the route handed the CLI for an install. */
function installArgs(): string[][] {
  return mockCli.mock.calls
    .map((c) => c[0] as string[])
    .filter((a) => a[1] === "install");
}

async function auditActions(): Promise<string[]> {
  const raw = await fs
    .readFile(path.join(clawboxRoot, "data", "skill-install-audit.log"), "utf8")
    .catch(() => "");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { action: string }).action);
}

beforeEach(async () => {
  vi.resetModules();
  hermesHome = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-hermes-blocked-"));
  clawboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clawbox-root-blocked-"));
  process.env.HERMES_HOME = hermesHome;
  process.env.CLAWBOX_ROOT = clawboxRoot;
  await fs.mkdir(skillsDir(), { recursive: true });
  await writeLock({});
  mockRecord.mockResolvedValue(undefined);
  fakeHermes("community", "dangerous");
});

afterEach(async () => {
  delete process.env.HERMES_HOME;
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(hermesHome, { recursive: true, force: true });
  await fs.rm(clawboxRoot, { recursive: true, force: true });
});

describe("POST …/skills/install — a scanner refusal is not a bad id", () => {
  it("names the security scan instead of blaming the identifier", async () => {
    const res = await install({ id: SLUG });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "dangerous_skill_blocked", overridable: false });
    expect(JSON.stringify(res.body)).not.toMatch(/could not be resolved/i);
  });

  it("tells the owner what the skill can do, from the findings the CLI printed", async () => {
    const res = await install({ id: SLUG });

    const warning = res.body.warning as unknown as {
      verdict: string;
      trust: string;
      capabilities: { id: string }[];
      findings: { file: string }[];
    };
    expect(warning.verdict).toBe("dangerous");
    expect(warning.trust).toBe("community");
    expect(warning.capabilities.map((c) => c.id)).toContain("credentials");
    expect(warning.findings).toHaveLength(2);
  });

  it("stays refused when the owner confirms, because the device will not budge", async () => {
    // The CLI says so in writing. Claiming the confirmation worked, or falling
    // back to "could not be resolved", are both lies.
    const res = await install({ id: SLUG, confirmDangerous: true });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "dangerous_skill_blocked", requiresConfirmation: false });
    await expect(readLock()).resolves.toEqual({});
  });

  it("records the device's refusal in the audit log", async () => {
    await install({ id: SLUG });

    await expect(auditActions()).resolves.toContain("install-blocked-by-device");
  });
});

describe("POST …/skills/install — a confirmation the installer can act on", () => {
  beforeEach(() => fakeHermes("community", "caution"));

  it("asks the owner first, with the existing dangerous_skill contract", async () => {
    const res = await install({ id: SLUG });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "dangerous_skill", requiresConfirmation: true });
    // Withheld on a first attempt: the verdict is meant to be shown, not waved.
    expect(installArgs()[0]).not.toContain("--force");
  });

  it("installs once the owner has confirmed, instead of repeating the refusal", async () => {
    const res = await install({ id: SLUG, confirmDangerous: true });

    expect(installArgs()[0]).toContain("--force");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, confirmedDangerous: true });
    await expect(readLock()).resolves.toHaveProperty(SLUG);
  });
});

describe("POST …/skills/install — every other way the CLI exits 0", () => {
  it("says the download failed when the GitHub allowance is exhausted", async () => {
    mockCli.mockResolvedValue({
      code: 0,
      stdout:
        `Error: Could not fetch '${SLUG}' from any source.\n`
        + "Hint: GitHub API rate limit exhausted (unauthenticated: 60 requests/hour).\n",
      stderr: "",
    });

    const res = await install({ id: SLUG });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "rate_limited" });
    expect(JSON.stringify(res.body)).not.toMatch(/could not be resolved/i);
  });

  it("says a skill is already there rather than that it does not exist", async () => {
    mockCli.mockResolvedValue({
      code: 0,
      stdout: `Warning: '${SLUG}' is already installed at ~/.hermes/skills/${SLUG}\nUse --force to reinstall.\n`,
      stderr: "",
    });

    const res = await install({ id: SLUG });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "already_installed" });
  });

  it("still answers 'could not be resolved' for a genuine resolver miss, with the suggestions", async () => {
    mockCli.mockResolvedValue({
      code: 0,
      stdout:
        `No exact match for '${SLUG}'. Did you mean one of these?\n  Terraform — oo-terraform\n`,
      stderr: "",
    });

    const res = await install({ id: SLUG });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: "unresolved",
      error: expect.stringMatching(/could not be resolved/i),
      candidates: ["oo-terraform"],
    });
  });

  it("keeps an installer exception out of the response body", async () => {
    mockCli.mockResolvedValue({
      code: 0,
      stdout: "Installation blocked: cannot write /home/clawbox/.hermes/skills/x\n",
      stderr: "",
    });

    const res = await install({ id: SLUG });

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: "install_failed" });
    expect(JSON.stringify(res.body)).not.toMatch(/home\/clawbox/);
  });

  it("un-wraps the installer's own line width so the reason survives the pipe", async () => {
    // The route asks for a wide console precisely because `rich` splits both
    // the reason and the scan-report rows at 80 columns off a TTY.
    await install({ id: SLUG });

    const opts = mockCli.mock.calls[0][1] as { env?: Record<string, string> };
    expect(opts.env?.COLUMNS).toBeTruthy();
  });
});
