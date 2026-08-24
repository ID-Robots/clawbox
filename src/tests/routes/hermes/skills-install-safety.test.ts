import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-452 — the install API's safety contract, against a real skills tree.
 *
 * Everything below reproduces something that happened on the QA box on
 * 2026-08-22 and then asserts the new answer:
 *
 *   crit9a  `anthropics/skills/skills/algorithmic-art` installed 2 of its 4
 *           upstream files and answered {"ok":true} with a lock entry calling
 *           the truncation complete.
 *   crit9b  a store skill named `pdf` displaces the 17-file bundled `pdf`,
 *           because the installer's only collision guard reads the hub lock and
 *           the lock never contains bundled skills.
 *   crit9c  `official/creative/simple-english` installed in 1.4 s with
 *           scan_verdict `dangerous` and two CRITICAL findings.
 *
 * The Hermes CLI is faked, but it is faked FAITHFULLY: the fake writes the same
 * truncated directory and the same lock entry the real one wrote, so the route
 * is exercised against the actual failure and not against a mock of the fix.
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

/** ~/.hermes/skills — where the CLI installs and where the route verifies. */
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

/**
 * A `hermes skills install` that behaves exactly like the shipped one: writes
 * whatever files it decided to fetch, records a lock entry, exits 0. Uninstall
 * removes both, which is what the route's rollback relies on.
 */
function fakeHermes(opts: {
  name: string;
  installPath: string;
  files: Record<string, string>;
  lock: Record<string, unknown>;
}) {
  mockCli.mockImplementation(async (args: string[]) => {
    if (args[1] === "install") {
      const dir = path.join(skillsDir(), opts.installPath);
      for (const [rel, content] of Object.entries(opts.files)) {
        const abs = path.join(dir, rel);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content);
      }
      const lock = await readLock();
      lock[opts.name] = { install_path: opts.installPath, files: Object.keys(opts.files), ...opts.lock };
      await writeLock(lock);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[1] === "uninstall") {
      const lock = await readLock();
      delete lock[args[2]];
      await writeLock(lock);
      await fs.rm(path.join(skillsDir(), opts.installPath), { recursive: true, force: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
}

// ── crit9c: a flagged skill is warned about and confirmed, never silent ─────

const SIMPLE_ENGLISH_SCAN = {
  verdict: "dangerous",
  scanner_version: "1.4.0",
  findings: [
    {
      pattern_id: "agent-instruction-overwrite",
      severity: "critical",
      category: "persistence",
      file: "SKILL.md",
      line: 308,
      description: "- **Agent instructions (prompts, AGENTS.md)**: a system prom",
    },
    {
      pattern_id: "agent-instruction-overwrite",
      severity: "critical",
      category: "persistence",
      file: "references/use-cases.md",
      line: 41,
      description: "## Instructions for AI agents (prompts, AGENTS.md, skills)",
    },
  ],
};

function fakeDangerousOfficialInstall() {
  fakeHermes({
    name: "simple-english",
    installPath: "creative/simple-english",
    files: { "SKILL.md": "---\nname: simple-english\n---\nplain english\n" },
    lock: {
      identifier: "official/creative/simple-english",
      source: "official",
      // The exact contradiction from the box: the installer resolved `builtin`
      // trust (so its policy table said "allow") for a dangerous verdict.
      trust_level: "builtin",
      scan_verdict: "dangerous",
      scan_provenance: SIMPLE_ENGLISH_SCAN,
    },
  });
}

describe("dangerous verdict → warn + confirm (TASK-452 crit9c)", () => {
  it("refuses the official dangerous skill with a structured 409, at builtin trust", async () => {
    fakeDangerousOfficialInstall();
    const { status, body } = await install({ id: "official/creative/simple-english" });

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "dangerous_skill", requiresConfirmation: true });
    const warning = body.warning as unknown as {
      trust: string;
      verdict: string;
      capabilities: { id: string; locations: string[] }[];
      findings: unknown[];
      severityCounts: Record<string, number>;
    };
    // The tier that used to be the exemption is named in the payload.
    expect(warning.trust).toBe("builtin");
    expect(warning.verdict).toBe("dangerous");
    expect(warning.capabilities[0]).toMatchObject({ id: "agentInstructions" });
    expect(warning.capabilities[0].locations).toEqual(["SKILL.md:308", "references/use-cases.md:41"]);
    expect(warning.severityCounts.critical).toBe(2);
    expect(warning.findings).toHaveLength(2);
  });

  it("leaves NOTHING on disk and no lock entry after the refusal", async () => {
    fakeDangerousOfficialInstall();
    await install({ id: "official/creative/simple-english" });

    expect(await readLock()).toEqual({});
    expect(await exists(path.join(skillsDir(), "creative", "simple-english"))).toBe(false);
  });

  it("installs on the confirmed call, and only then", async () => {
    fakeDangerousOfficialInstall();
    const first = await install({ id: "official/creative/simple-english" });
    expect(first.status).toBe(409);

    const second = await install({ id: "official/creative/simple-english", confirmDangerous: true });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, name: "simple-english", confirmedDangerous: true });
    expect(Object.keys(await readLock())).toEqual(["simple-english"]);
    expect(await exists(path.join(skillsDir(), "creative", "simple-english", "SKILL.md"))).toBe(true);
  });

  it("audit-logs who confirmed what, and does not log a confirmation for the refusal", async () => {
    fakeDangerousOfficialInstall();
    await install({ id: "official/creative/simple-english" });
    await install({ id: "official/creative/simple-english", confirmDangerous: true });

    const { readSkillAuditLog } = await import("@/lib/hermes-skill-audit");
    const log = await readSkillAuditLog();
    expect(log.map((r) => r.action)).toEqual(["install-confirmed", "install-refused"]);
    expect(log[0]).toMatchObject({
      id: "official/creative/simple-english",
      name: "simple-english",
      verdict: "dangerous",
      trust: "builtin",
      findingCount: 2,
      capabilities: ["agentInstructions"],
    });
    expect(typeof log[0].actor).toBe("string");
    expect(log[0].actor.length).toBeGreaterThan(0);
    expect(Date.parse(log[0].at)).not.toBeNaN();
  });

  it("does not accept a truthy non-true confirmation", async () => {
    fakeDangerousOfficialInstall();
    const { status } = await install({
      id: "official/creative/simple-english",
      confirmDangerous: "yes",
    });
    expect(status).toBe(409);
  });

  it("installs a clean skill without asking anything", async () => {
    fakeHermes({
      name: "get-forecast",
      installPath: "weather/get-forecast",
      files: { "SKILL.md": "---\nname: get-forecast\n---\nforecast\n" },
      lock: { identifier: "browse-sh/x/get-forecast", source: "browse-sh", trust_level: "community", scan_verdict: "safe" },
    });
    const { status, body } = await install({ id: "browse-sh/x/get-forecast" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, name: "get-forecast" });
    expect(body.warning).toBeUndefined();
  });
});

// ── crit9b: a store skill may not shadow a bundled one ──────────────────────

describe("bundled-name shadowing is refused (TASK-452 crit9b)", () => {
  beforeEach(async () => {
    // A stock device: the bundled pdf lives at productivity/pdf and is listed
    // in .bundled_manifest, while the hub lock is empty — which is exactly why
    // the installer's lock-based collision guard cannot see it.
    await fs.mkdir(path.join(skillsDir(), "productivity", "pdf", "scripts"), { recursive: true });
    await fs.writeFile(path.join(skillsDir(), "productivity", "pdf", "SKILL.md"), "---\nname: pdf\n---\nbundled\n");
    await fs.writeFile(path.join(skillsDir(), ".bundled_manifest"), "pdf:934abf0803033eb595c32d733bfb38ff\n");
  });

  it("refuses the colliding install and never runs the CLI", async () => {
    mockCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const { status, body } = await install({ id: "anthropics/skills/skills/pdf" });

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "bundled_conflict", conflictsWith: "pdf", requiresDistinctName: true });
    expect(mockCli).not.toHaveBeenCalled();
  });

  it("leaves the bundled skill untouched", async () => {
    mockCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    await install({ id: "anthropics/skills/skills/pdf" });
    expect(await fs.readFile(path.join(skillsDir(), "productivity", "pdf", "SKILL.md"), "utf8")).toContain(
      "bundled",
    );
    // And nothing landed at the flat path that would have won the dedup walk.
    expect(await exists(path.join(skillsDir(), "pdf"))).toBe(false);
  });

  it("also refuses when the COLLIDING NAME only comes from the catalogue record", async () => {
    // clawhub identifiers are bare, so the id's last segment is not always the
    // skill's name; the catalogue's name has to be checked too.
    mockRecord.mockResolvedValue({ id: "clawhub/pdf-tools", name: "pdf", source: "clawhub" } as never);
    mockCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const { status, body } = await install({ id: "clawhub/pdf-tools" });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: "bundled_conflict", conflictsWith: "pdf" });
  });

  it("accepts the same skill under a distinct name", async () => {
    fakeHermes({
      name: "pdf-store",
      installPath: "pdf-store",
      files: { "SKILL.md": "---\nname: pdf-store\n---\nstore pdf\n" },
      lock: { identifier: "anthropics/skills/skills/pdf", source: "github", trust_level: "trusted", scan_verdict: "safe" },
    });
    const { status, body } = await install({ id: "anthropics/skills/skills/pdf", name: "pdf-store" });
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, name: "pdf-store" });
    // The bundled one is still the only `pdf`.
    expect(await exists(path.join(skillsDir(), "productivity", "pdf", "SKILL.md"))).toBe(true);
  });

  it("refuses a distinct name that is itself taken", async () => {
    mockCli.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const { status, body } = await install({ id: "anthropics/skills/skills/pdf", name: "pdf" });
    expect(status).toBe(409);
    expect(body).toMatchObject({ conflictsWith: "pdf" });
    expect(mockCli).not.toHaveBeenCalled();
  });
});

// ── crit9a: an incomplete download is not an install ────────────────────────

const ART_SKILL_MD = `---
name: algorithmic-art
license: Complete terms in LICENSE.txt
---

See the [viewer](templates/viewer.html).

- **templates/generator_template.js**: Reference for p5.js best practices.
`;

/** The tree GitHub returns for anthropics/skills — 4 blobs under the skill. */
const ART_TREE = {
  truncated: false,
  tree: [
    { path: "skills/algorithmic-art/SKILL.md", type: "blob", mode: "100644", size: ART_SKILL_MD.length, sha: "a".repeat(40) },
    { path: "skills/algorithmic-art/LICENSE.txt", type: "blob", mode: "100644", size: 4, sha: "b".repeat(40) },
    { path: "skills/algorithmic-art/templates/viewer.html", type: "blob", mode: "100644", size: 7, sha: "c".repeat(40) },
    { path: "skills/algorithmic-art/templates/generator_template.js", type: "blob", mode: "100644", size: 15, sha: "d".repeat(40) },
  ],
};

/** The truncated install the shipped fetcher actually produced: 2 of 4 files. */
function fakeTruncatedGithubInstall() {
  mockRecord.mockResolvedValue({
    id: "anthropics/skills/skills/algorithmic-art",
    name: "algorithmic-art",
    source: "github",
    trust: "trusted",
    repo: "anthropics/skills",
    repoPath: "skills/algorithmic-art",
  } as never);
  fakeHermes({
    name: "algorithmic-art",
    installPath: "algorithmic-art",
    files: { "SKILL.md": ART_SKILL_MD, "templates/viewer.html": "<html>\n" },
    lock: {
      identifier: "anthropics/skills/skills/algorithmic-art",
      source: "github",
      trust_level: "trusted",
      scan_verdict: "safe",
    },
  });
}

function githubFetch(blobs: Record<string, string> | null) {
  return vi.fn(async (url: string) => {
    if (url.includes("/git/trees/")) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ART_TREE } as unknown as Response;
    }
    const sha = url.split("/").pop() as string;
    if (!blobs || !(sha in blobs)) {
      return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ encoding: "base64", content: Buffer.from(blobs[sha]).toString("base64") }),
    } as unknown as Response;
  });
}

describe("incomplete download is refused (TASK-452 crit9a)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("completes the two files the installer skipped and reports the repair", async () => {
    fakeTruncatedGithubInstall();
    const { gitBlobSha } = await import("@/lib/hermes-skill-manifest");
    const licence = "MIT\n";
    const template = "// p5 template\n";
    // The tree's shas have to be the real object ids, because the route only
    // writes a blob whose bytes hash back to the id it asked for.
    ART_TREE.tree[1].sha = gitBlobSha(Buffer.from(licence));
    ART_TREE.tree[3].sha = gitBlobSha(Buffer.from(template));
    ART_TREE.tree[1].size = licence.length;
    ART_TREE.tree[3].size = template.length;
    ART_TREE.tree[0].size = ART_SKILL_MD.length;
    ART_TREE.tree[2].size = "<html>\n".length;
    vi.stubGlobal(
      "fetch",
      githubFetch({ [ART_TREE.tree[1].sha]: licence, [ART_TREE.tree[3].sha]: template }),
    );

    const { status, body } = await install({ id: "anthropics/skills/skills/algorithmic-art" });
    expect(status).toBe(200);
    expect(body.files).toMatchObject({ origin: "github-tree", expected: 4, present: 4 });
    expect((body.files as unknown as { repaired: string[] }).repaired.sort()).toEqual([
      "LICENSE.txt",
      "templates/generator_template.js",
    ]);
    // The file the skill's own SKILL.md names is finally on disk.
    expect(
      await fs.readFile(path.join(skillsDir(), "algorithmic-art", "templates", "generator_template.js"), "utf8"),
    ).toBe(template);
    // …and the lock no longer describes the truncated bundle as the whole
    // skill. `files: ["SKILL.md", "templates/viewer.html"]` was the other half
    // of the finding: the disk was wrong AND the record of it agreed.
    expect((await readLock())["algorithmic-art"].files).toEqual([
      "LICENSE.txt",
      "SKILL.md",
      "templates/generator_template.js",
      "templates/viewer.html",
    ]);
  });

  it("refuses and rolls back when the missing files cannot be obtained", async () => {
    fakeTruncatedGithubInstall();
    vi.stubGlobal("fetch", githubFetch(null));

    const { status, body } = await install({ id: "anthropics/skills/skills/algorithmic-art" });
    expect(status).toBe(502);
    expect(body).toMatchObject({ code: "incomplete_install", expectedCount: 4, presentCount: 2 });
    expect((body.missingFiles as unknown as string[]).sort()).toEqual([
      "LICENSE.txt",
      "templates/generator_template.js",
    ]);
    // No lock entry, no half-installed directory — the state the finding said
    // was left behind as `{"ok":true}` with `files: [2 of 4]`.
    expect(await readLock()).toEqual({});
    expect(await exists(path.join(skillsDir(), "algorithmic-art"))).toBe(false);
  });

  it("falls back to the paths SKILL.md names when the tree is unreachable", async () => {
    // An offline device, or a source with no repo in the catalogue: there is no
    // hash to verify against and no repair possible, but a SKILL.md that points
    // at files which were never fetched is still a broken install.
    mockRecord.mockResolvedValue(undefined);
    fakeHermes({
      name: "algorithmic-art",
      installPath: "algorithmic-art",
      files: { "SKILL.md": ART_SKILL_MD, "templates/viewer.html": "<html>\n" },
      lock: { identifier: "x/algorithmic-art", source: "clawhub", trust_level: "community", scan_verdict: "safe" },
    });

    const { status, body } = await install({ id: "x/algorithmic-art" });
    expect(status).toBe(502);
    expect(body).toMatchObject({ code: "incomplete_install", manifestOrigin: "skill-md" });
    expect((body.missingFiles as unknown as string[]).sort()).toEqual([
      "LICENSE.txt",
      "templates/generator_template.js",
    ]);
    expect(await readLock()).toEqual({});
  });

  it("passes a skill whose SKILL.md names nothing it does not have", async () => {
    mockRecord.mockResolvedValue(undefined);
    fakeHermes({
      name: "simple",
      installPath: "misc/simple",
      files: { "SKILL.md": "---\nname: simple\n---\nNo support files here.\n" },
      lock: { identifier: "clawhub/simple", source: "clawhub", trust_level: "community", scan_verdict: "safe" },
    });
    const { status } = await install({ id: "clawhub/simple" });
    expect(status).toBe(200);
  });
});

describe("input validation still holds", () => {
  it("rejects a URL install", async () => {
    const { status } = await install({ id: "https://evil.example/SKILL.md" });
    expect(status).toBe(400);
    expect(mockCli).not.toHaveBeenCalled();
  });

  it("rejects a flag-shaped id", async () => {
    const { status } = await install({ id: "--force" });
    expect(status).toBe(400);
  });
});
