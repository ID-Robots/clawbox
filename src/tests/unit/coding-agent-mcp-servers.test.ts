/**
 * A project's MCP allowlist (src/lib/project-mcp-servers.ts) reaching a run's
 * argv, against a FAKE claude-ds — the same harness coding-agent.test.ts uses.
 *
 * What is pinned here is what an owner relies on when they tick a server in a
 * project's settings:
 *
 *  - the run starts with exactly the servers they ticked, read from the
 *    harness's OWN config (OpenClaw `mcp.servers`, Hermes `mcp_servers`), and
 *    `--strict-mcp-config` still keeps every other server out;
 *  - the server's credentials travel in a 0600 file under data/ that every run
 *    is denied and that is gone when the run settles — never in argv, never in
 *    the evidence folder the run can read, never on the run record;
 *  - a project nobody ticked anything for gets today's argv, byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { saveEnv } from "@/tests/helpers/env";
import { readFirstTurn } from "@/tests/helpers/fake-harness";

// Starts real processes through @/lib/coding-agent — see test-timeout-hygiene.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/coding-agent-notify", () => ({ announceCodingAgent: vi.fn(async () => undefined) }));
vi.mock("@/lib/mem-available", () => ({ memAvailableMb: vi.fn(async () => 8000) }));
vi.mock("@/lib/project-icon", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/project-icon")>()),
  ensureProjectIcon: vi.fn(async () => ({ icon: "skipped", favicon: false })),
}));

type Lib = typeof import("@/lib/coding-agent");

/** A placeholder in the shape a board token has; never a real credential. */
const BOARD_TOKEN = "fixture-board-token-0123456789";
const HEADER_TOKEN = "fixture-header-token-9876543210";

let lib: Lib;
let base: string;
let home: string;
let root: string;
let restore: () => void;

const argvFile = () => path.join(base, "argv.txt");
/** The --mcp-config file as the harness found it, copied at spawn: the runner deletes it at the settle. */
const copiedConfig = () => path.join(base, "mcp-config.json");
const copiedMode = () => path.join(base, "mcp-config.mode");
const configPathFile = () => path.join(base, "mcp-config.path");

const RESULT_TEXT = `Read the board with ${BOARD_TOKEN}.`;

function installFakeHarness(): void {
  const binDir = path.join(home, ".local", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "claude"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const init = '{"type":"system","subtype":"init","session_id":"sess-mcp-1","model":"deepseek-v4-flash","permissionMode":"acceptEdits"}';
  // The run echoes the token back, as a careless one would: the record must not keep it.
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1, result: RESULT_TEXT, session_id: "sess-mcp-1" });
  fs.writeFileSync(
    path.join(binDir, "claude-ds"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$@" > "${argvFile()}"`,
      'prev=""',
      'for a in "$@"; do',
      `  if [ "$prev" = "--mcp-config" ] && [ -f "$a" ]; then cp "$a" "${copiedConfig()}"; stat -c %a "$a" > "${copiedMode()}"; printf '%s' "$a" > "${configPathFile()}"; fi`,
      '  prev="$a"',
      "done",
      readFirstTurn(),
      `echo '${init}'`,
      `echo '${result}'`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function writeBoxConfig(extra: Record<string, unknown> = {}): void {
  boxExtra = extra;
  fs.writeFileSync(
    path.join(root, "data", "config.json"),
    JSON.stringify({ clawai_token: "claw_test_token", clawai_tier: "flash", coding_agent_enabled: true, ...extra }),
  );
}

function makeProject(id: string): string {
  const dir = path.join(root, "data", "code-projects", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ projectId: id, name: id }));
  fs.writeFileSync(path.join(dir, "index.html"), "<html></html>");
  return dir;
}

/**
 * The allowlist, written the way the store keeps it: one key in the box's own
 * config.json, which every run is already denied by name — so the feature adds
 * no entry under data/ for a run's deny list to discover.
 */
let boxExtra: Record<string, unknown> = {};
function seedAllowlist(projects: unknown): void {
  writeBoxConfig({ ...boxExtra, coding_agent_mcp_servers: projects });
}

/** The box's OpenClaw config, with the clawbox server and the board beside it. */
function seedOpenclaw(servers: Record<string, unknown>): void {
  const dir = path.join(home, ".openclaw");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "openclaw.json"), JSON.stringify({ mcp: { servers } }), { mode: 0o600 });
}

function seedHermes(yaml: string): void {
  const dir = path.join(home, ".hermes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.yaml"), yaml, { mode: 0o600 });
}

const CLAWBOX_ENTRY = { command: "bun", args: ["run", "mcp/clawbox-mcp.ts"], env: { CLAWBOX_ROOT: "/opt/clawbox" } };
const BOARD_ENTRY = { command: "node", args: ["board.js"], env: { BOARD_TOKEN } };

function readArgv(): string[] {
  return fs.readFileSync(argvFile(), "utf-8").split("\n").filter(Boolean);
}

/** The --mcp-config value: inline JSON (a run with nothing extra), else the file it names. */
function mcpConfig(argv: string[]): { mcpServers: Record<string, Record<string, unknown>> } {
  const value = argv[argv.indexOf("--mcp-config") + 1];
  return JSON.parse(value.startsWith("{") ? value : fs.readFileSync(copiedConfig(), "utf-8"));
}

async function runIn(projectId: string) {
  const run = await lib.startRun({ task: "Read the board", projectId, source: "agent" });
  const done = await lib.waitForRun(run.id, 15_000);
  if (!done) throw new Error("run vanished");
  return done;
}

beforeEach(async () => {
  restore = saveEnv("HOME", "CLAWBOX_ROOT", "USER", "LOGNAME", "SESSION_SECRET", "CLAWBOX_MCP_TOKEN", "CLAWBOX_EDITION", "HERMES_HOME", "OPENCLAW_HOME", "OPENCLAW_CONFIG_PATH");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "coding-agent-mcp-"));
  home = path.join(base, "home");
  root = path.join(home, "clawbox");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  process.env.HOME = home;
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "the-web-servers-secret";
  process.env.CLAWBOX_MCP_TOKEN = "the-mcp-bearer-token-value";
  process.env.CLAWBOX_EDITION = "openclaw";
  delete process.env.HERMES_HOME;
  delete process.env.OPENCLAW_HOME;
  delete process.env.OPENCLAW_CONFIG_PATH;
  installFakeHarness();
  writeBoxConfig();
  vi.resetModules();
  lib = await import("@/lib/coding-agent");
});

afterEach(async () => {
  await lib._resetCodingAgentStateForTests();
  restore();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("a project that opted into a harness-configured server", () => {
  it("starts the run with the board beside clawbox, from a 0600 file outside the evidence folder", async () => {
    makeProject("site");
    seedOpenclaw({ clawbox: CLAWBOX_ENTRY, board: BOARD_ENTRY, other: { command: "node", args: ["other.js"] } });
    seedAllowlist({ site: ["board"] });
    const run = await runIn("site");

    const argv = readArgv();
    expect(argv).toContain("--strict-mcp-config");
    const cfg = mcpConfig(argv);
    expect(Object.keys(cfg.mcpServers)).toContain("board");
    // Exactly what was ticked: the harness's other server stays out, and the
    // run's own clawbox server is still the run's, not the harness's entry.
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["board", "clawbox"]);
    expect(cfg.mcpServers.clawbox.env).toMatchObject({ CLAWBOX_MCP_PROFILE: "browser", CLAWBOX_ROOT: root });
    expect(cfg.mcpServers.board).toMatchObject({ command: "node", args: ["board.js"], env: { BOARD_TOKEN } });
    // Its tools are approved as a whole server, the one the owner ticked.
    expect(argv).toContain("mcp__board");
    expect(argv.some((a) => a.startsWith("mcp__other"))).toBe(false);

    // The credential is in the file and nowhere a process listing reaches.
    expect(argv.join(" ")).not.toContain(BOARD_TOKEN);
    const file = fs.readFileSync(configPathFile(), "utf-8");
    expect(fs.readFileSync(copiedMode(), "utf-8").trim()).toBe("600");
    expect(path.isAbsolute(file)).toBe(true);
    const evidence = path.join(root, "data", "coding-agent-artifacts", run.id);
    expect(file.startsWith(evidence + path.sep)).toBe(false);
    expect(file.startsWith(path.join(root, "data") + path.sep)).toBe(true);
    // Denied to the run's file tools, like every credential store under data/.
    const denied = argv.slice(argv.indexOf("--disallowedTools") + 1);
    expect(denied.some((rule) => rule.startsWith("Read(/") && (rule === `Read(/${file})` || (rule.endsWith("/**)") && file.startsWith(rule.slice("Read(/".length, -"/**)".length) + path.sep))))).toBe(true);
    // …and gone once the run has settled.
    expect(fs.existsSync(file)).toBe(false);

    // A run that printed the token does not keep it on its record.
    expect(run.status).toBe("completed");
    expect(JSON.stringify(run)).not.toContain(BOARD_TOKEN);
    const evidenceFiles = fs.existsSync(evidence) ? fs.readdirSync(evidence, { recursive: true, encoding: "utf-8" }) : [];
    for (const rel of evidenceFiles) {
      const abs = path.join(evidence, rel);
      if (fs.statSync(abs).isFile()) expect(fs.readFileSync(abs, "utf-8")).not.toContain(BOARD_TOKEN);
    }
  });

  it("carries an HTTP server's headers in the file, never in argv", async () => {
    makeProject("site");
    seedOpenclaw({
      clawbox: CLAWBOX_ENTRY,
      docs: { url: "https://mcp.example.com/mcp", transport: "streamable-http", headers: { Authorization: `Bearer ${HEADER_TOKEN}` } },
    });
    seedAllowlist({ site: ["docs"] });
    await runIn("site");
    const argv = readArgv();
    const cfg = mcpConfig(argv);
    expect(cfg.mcpServers.docs).toEqual({ type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${HEADER_TOKEN}` } });
    expect(argv).toContain("mcp__docs");
    expect(argv.join(" ")).not.toContain(HEADER_TOKEN);
  });

  it("approves only the tools the harness's own filter lets through", async () => {
    makeProject("site");
    seedOpenclaw({ clawbox: CLAWBOX_ENTRY, board: { ...BOARD_ENTRY, toolFilter: { include: ["board_read", "board_list"] } } });
    seedAllowlist({ site: ["board"] });
    await runIn("site");
    const argv = readArgv();
    expect(argv).toContain("mcp__board__board_read");
    expect(argv).toContain("mcp__board__board_list");
    expect(argv).not.toContain("mcp__board");
  });

  it("reads a Hermes box's config.yaml the same way", async () => {
    process.env.CLAWBOX_EDITION = "hermes";
    vi.resetModules();
    lib = await import("@/lib/coding-agent");
    makeProject("site");
    seedHermes([
      "model:",
      "  provider: custom",
      "mcp_servers:",
      "  clawbox:",
      "    command: bun",
      "    args: [run, mcp/clawbox-mcp.ts]",
      "  board:",
      "    command: node",
      "    args:",
      "      - board.js",
      "    env:",
      `      BOARD_TOKEN: "${BOARD_TOKEN}"`,
      "",
    ].join("\n"));
    seedAllowlist({ site: ["board"] });
    const run = await runIn("site");
    const argv = readArgv();
    const cfg = mcpConfig(argv);
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["board", "clawbox"]);
    expect(cfg.mcpServers.board).toMatchObject({ command: "node", args: ["board.js"], env: { BOARD_TOKEN } });
    expect(argv).toContain("mcp__board");
    expect(argv.join(" ")).not.toContain(BOARD_TOKEN);
    expect(JSON.stringify(run)).not.toContain(BOARD_TOKEN);
  });
});

describe("ClawBox read-only tools", () => {
  it("swaps the run's server to the read-only profile and approves those tools by name", async () => {
    makeProject("site");
    seedAllowlist({ site: ["clawbox"] });
    await runIn("site");
    const argv = readArgv();
    const cfg = mcpConfig(argv);
    expect(Object.keys(cfg.mcpServers)).toEqual(["clawbox"]);
    expect(cfg.mcpServers.clawbox.env).toMatchObject({ CLAWBOX_MCP_PROFILE: "run-read" });
    expect(argv).toContain("mcp__clawbox__device_status");
    for (const tool of lib.MCP_BROWSER_TOOLS) expect(argv).toContain(tool);
    // Nothing that writes: no mail, no switches, no whole-server grant.
    expect(argv).not.toContain("mcp__clawbox__email_send");
    expect(argv).not.toContain("mcp__clawbox__coding_agent_run");
    expect(argv).not.toContain("mcp__clawbox");
  });

  it("is not applied while the owner has the ClawBox MCP server switched off", async () => {
    makeProject("site");
    writeBoxConfig({ clawbox_mcp_enabled: false, coding_agent_mcp_servers: { site: ["clawbox"] } });
    await runIn("site");
    const argv = readArgv();
    expect(mcpConfig(argv).mcpServers.clawbox.env).toMatchObject({ CLAWBOX_MCP_PROFILE: "browser" });
    expect(argv).not.toContain("mcp__clawbox__device_status");
  });
});

describe("a project with an empty allowlist", () => {
  /** argv with this run's id taken out, so two runs can be compared byte for byte. */
  const normalised = (argv: string[], runId: string) => argv.map((a) => a.split(runId).join("<run>"));

  it("gets today's argv, byte for byte, whatever the box has configured", async () => {
    makeProject("site");
    // One run first, so the folders a run creates under data/ exist for both
    // of the runs compared: a run's file deny list names what data/ holds.
    await runIn("site");
    // Today: a box with no allowlist and no harness extras at all.
    const before = await runIn("site");
    const today = normalised(readArgv(), before.id);
    expect(today.filter((a) => a.startsWith("mcp__"))).toHaveLength(lib.MCP_BROWSER_TOOLS.length + 2);
    expect(today[today.indexOf("--mcp-config") + 1].startsWith("{")).toBe(true);

    // The same box once a board is configured and ANOTHER project opted in.
    seedOpenclaw({ clawbox: CLAWBOX_ENTRY, board: BOARD_ENTRY });
    seedAllowlist({ other: ["board", "clawbox"], site: [] });
    const after = await runIn("site");
    const argv = readArgv();
    expect(normalised(argv, after.id)).toEqual(today);
    expect(Object.keys(mcpConfig(argv).mcpServers)).toEqual(["clawbox"]);
    expect(argv.join(" ")).not.toContain(BOARD_TOKEN);
  });

  it("falls back to today's tools when the stored allowlist is not one", async () => {
    makeProject("site");
    seedOpenclaw({ clawbox: CLAWBOX_ENTRY, board: BOARD_ENTRY });
    seedAllowlist({ site: "board" });
    await runIn("site");
    const argv = readArgv();
    expect(Object.keys(mcpConfig(argv).mcpServers)).toEqual(["clawbox"]);
    expect(argv.filter((a) => a.startsWith("mcp__"))).toHaveLength(lib.MCP_BROWSER_TOOLS.length + 2);
  });
});

describe("a read-only run", () => {
  it("is handed none of the project's servers", async () => {
    makeProject("site");
    seedOpenclaw({ clawbox: CLAWBOX_ENTRY, board: BOARD_ENTRY });
    seedAllowlist({ site: ["board", "clawbox"] });
    const run = await lib.startRun({ task: "Plan it", projectId: "site", source: "agent", readOnly: true });
    await lib.waitForRun(run.id, 15_000);
    const argv = readArgv();
    expect(argv.some((a) => a.startsWith("mcp__board") || a.startsWith("mcp__clawbox__device_status"))).toBe(false);
    expect(fs.existsSync(configPathFile())).toBe(false);
    expect(argv.join(" ")).not.toContain(BOARD_TOKEN);
  });
});

describe("what the harness's config offers", () => {
  type Store = typeof import("@/lib/project-mcp-servers");
  let store: Store;
  beforeEach(async () => {
    store = await import("@/lib/project-mcp-servers");
  });

  const byName = async () => Object.fromEntries((await store.readHarnessMcpServers()).servers.map((s) => [s.name, store.listingOf(s)]));

  it("translates what a run can reproduce and names why it cannot the rest", async () => {
    seedOpenclaw({
      clawbox: CLAWBOX_ENTRY,
      board: BOARD_ENTRY,
      events: { url: "https://events.example.com/sse" },
      oauth: { url: "https://mcp.example.com/mcp", transport: "streamable-http", auth: "oauth" },
      placeholder: { command: "node", args: ["x.js"], env: { TOKEN: "${BOARD_TOKEN}" } },
      folder: { command: "node", args: ["x.js"], cwd: "/srv/x" },
      globbed: { command: "node", args: ["x.js"], toolFilter: { include: ["read_*"] } },
      "bad name": { command: "node" },
      off: { command: "node", enabled: false },
    });
    const servers = await byName();
    expect(Object.keys(servers).sort()).toEqual(["bad name", "board", "events", "folder", "globbed", "oauth", "placeholder"]);
    expect(servers.board).toMatchObject({ usable: true, transport: "stdio" });
    expect(servers.events).toMatchObject({ usable: true, transport: "sse" });
    for (const name of ["oauth", "placeholder", "folder", "globbed", "bad name"]) {
      expect(servers[name].usable, name).toBe(false);
      expect(servers[name].reason, name).toBeTruthy();
    }
    // The code the owner's page words in their language, one per kind of refusal.
    expect(Object.fromEntries(["oauth", "placeholder", "folder", "globbed", "bad name"].map((n) => [n, servers[n].reasonCode]))).toEqual({
      oauth: "oauth", placeholder: "placeholder", folder: "cwd", globbed: "toolFilter", "bad name": "badName",
    });
    // No listing carries a value.
    expect(JSON.stringify(servers)).not.toContain(BOARD_TOKEN);
  });

  it("turns the harness's exclude filter into the run's deny rules", async () => {
    seedOpenclaw({ board: { ...BOARD_ENTRY, toolFilter: { exclude: ["board_delete"] } } });
    seedAllowlist({ site: ["board"] });
    const plan = await store.resolveRunMcpPlan("site");
    expect(plan).toMatchObject({ allowedTools: ["mcp__board"], disallowedTools: ["mcp__board__board_delete"] });
    expect(plan?.secrets).toEqual([{ name: "board.BOARD_TOKEN", value: BOARD_TOKEN }]);
  });

  it("is the union of both harnesses on a dual box, OpenClaw's entry first", async () => {
    process.env.CLAWBOX_EDITION = "dual";
    vi.resetModules();
    store = await import("@/lib/project-mcp-servers");
    seedOpenclaw({ board: BOARD_ENTRY });
    seedHermes("mcp_servers:\n  board:\n    command: python3\n  notes:\n    url: https://notes.example.com/mcp\n    headers:\n      Authorization: \"Bearer " + HEADER_TOKEN + "\"\n");
    const { servers, unreadable } = await store.readHarnessMcpServers();
    expect(unreadable).toEqual([]);
    expect(servers.map((s) => [s.name, s.harness])).toEqual([["board", "openclaw"], ["notes", "hermes"]]);
    seedAllowlist({ site: ["notes"] });
    const plan = await store.resolveRunMcpPlan("site");
    expect(plan?.servers.notes).toEqual({ type: "http", url: "https://notes.example.com/mcp", headers: { Authorization: `Bearer ${HEADER_TOKEN}` } });
    // The header whole, and the token alone, so a run that prints either is scrubbed.
    expect(plan?.secrets.map((s) => s.value)).toEqual([`Bearer ${HEADER_TOKEN}`, HEADER_TOKEN]);
  });

  it("says which harness it could not read rather than reporting no servers", async () => {
    fs.mkdirSync(path.join(home, ".openclaw"), { recursive: true });
    fs.writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{ half a file");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = await store.readHarnessMcpServers();
    expect(read).toEqual({ servers: [], unreadable: ["openclaw"] });
    errors.mockRestore();
    seedAllowlist({ site: ["board"] });
    expect(await store.resolveRunMcpPlan("site")).toMatchObject({ names: [], missing: ["board"] });
  });

  it("drops a deleted project's list and leaves the others", async () => {
    seedAllowlist({ site: ["board"], other: ["clawbox"] });
    await store.deleteProjectMcpAllowlist("site");
    expect(await store.readProjectMcpAllowlist("site")).toEqual([]);
    expect(await store.readProjectMcpAllowlist("other")).toEqual(["clawbox"]);
  });
});
