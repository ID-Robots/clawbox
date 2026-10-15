import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanTree } from "../../../scripts/harness-contract/scan.mjs";

/**
 * The harness-contract guard (docs/harness-contract.md), offline: what the
 * scanner reads out of ClawBox's source, and how the checker judges a usage
 * against a harness surface. The surfaces themselves come from the pinned
 * harnesses, so they are exercised by the `harness-contract` CI job; here they
 * are small fixtures.
 */
// Spawns node and scans the whole tree: see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 30_000 });
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CHECK = path.join(REPO, "scripts/harness-contract/check.mjs");

type Usage = { harness: string; kind: string; name: string; site: string; flags?: string[]; op?: string; force?: boolean; method?: string };
type Scan = { usages: Usage[]; unchecked: { harness: string; kind: string; site: string; why: string }[] };

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-contract-"));
  dirs.push(dir);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const found = (scan: Scan, harness: string, kind: string, name: string) =>
  scan.usages.filter((u) => u.harness === harness && u.kind === kind && u.name === name);

describe("the scanner", () => {
  const fixture = () => scanTree(tree({
    "src/lib/a.ts": [
      'const KEY = "tools.profile";',
      'const capArgs = ["--accept-capabilities"];',
      "export async function f(order: string[], cond: boolean, spec: string, id: string) {",
      '  await spawnOpenclawCli(["plugins", "install", spec, "--force", ...capArgs]);',
      '  const args = ["memory", "status", "--json"];',
      '  if (cond) args.push("--deep");',
      "  await execFile(openclawBin(), args);",
      "  const alt = cond",
      '    ? ["models", "auth", "order", "set", "--provider", "openai", ...order]',
      '    : ["models", "auth", "order", "clear", "--provider", "openai"];',
      "  await spawnOpenclawCli(alt);",
      '  await runOpenclawConfigSet([KEY, "full"]);',
      '  await runOpenclawConfigSetBatch([["a.b", "1"], [`plugins.entries["${id}"].enabled`, "true"]]);',
      '  await gatewayWsCall("config.get", {});',
      '  await this.link.request(cond ? "chat.send" : "chat.abort", {});',
      '  if (frame.event === "connect.challenge") return;',
      '  // runOpenclawConfigSet(["commented.out", "x"]);',
      "  await runOpenclawConfigSet(dynamicArgs());",
      "}",
      "async function setVia(argv: string[]): Promise<void> {",
      '  await spawnOpenclawCli(["config", "set", ...argv]);',
      "}",
      'export const g = () => setVia(["learned.key", "v"]);',
    ].join("\n"),
    "src/lib/hermes-x.ts": [
      'const PROVIDER = "clawbox-local";',
      "const KEYS = { local: `tts.providers.${PROVIDER}.type` } as const;",
      "const EVENT = {",
      '  ready: "gateway.ready",',
      "  /** a comment between members */",
      '  delta: "message.delta",',
      "};",
      "export async function h(cond: boolean, id: string, t: string) {",
      '  await runHermesCli(["config", "set", "tts.provider", "x"]);',
      "  await hermesConfigGet(KEYS.local);",
      '  await dashboardRpc("reload.env", {});',
      '  send({ method: cond ? "session.resume" : "session.create" });',
      '  await dashboardFetch(`/api/providers/oauth/${id}/start`, { method: "POST" });',
      "  return new WebSocket(`${ORIGIN}/api/ws?ticket=${t}`);",
      "}",
    ].join("\n"),
    "install.sh": [
      '#!/usr/bin/env bash',
      'OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"',
      'HERMES_TTS_BIN="${HERMES_BIN:-$HOME/.local/bin/hermes}"',
      "oc_config_set() {",
      '  as_clawbox "$OPENCLAW_BIN" config set "$@"',
      "}",
      "capture() {",
      "  local secs=$1",
      "  shift",
      '  timeout -k 5 "$secs" "$OPENCLAW_BIN" "$@" </dev/null',
      "}",
      'oc_config_set agents.defaults.model.primary "x"',
      "capture 60 plugins enable codex --accept-capabilities",
      'if [ -x "$OPENCLAW_BIN" ]; then',
      '  echo "run openclaw doctor --fix by hand"',
      '  V="$("$OPENCLAW_BIN" --version 2>/dev/null)"',
      "fi",
      'dirname "$OPENCLAW_BIN"',
      'tts_cli() { as_clawbox env HOME="$H" "$HERMES_TTS_BIN" "$@"; }',
      'tts_cli config set "tts.providers.$P.command" "$C" --force',
      '# "$OPENCLAW_BIN" doctor --commented-out',
    ].join("\n"),
    "config/x.service": "[Service]\nExecStart=/home/clawbox/.local/bin/hermes dashboard --no-open\n",
    "clawkeep/clawkeep/openclaw.py": [
      "def f(binary, x):",
      '    args = ["backup", "create", "--json"]',
      "    if x:",
      '        args.append("--verify")',
      "    return _run(binary, args, timeout=1)",
    ].join("\n"),
    "scripts/openclaw-plugins/p/index.mjs": 'export default (api) => { api.on("before_tool_call", () => {}); };\n',
    "src/tests/unit/x.test.ts": 'spawnOpenclawCli(["never", "read"]);\n',
  })) as Scan;

  it("reads OpenClaw CLI argv through arrays, pushes, ternaries, spreads and wrappers", () => {
    const scan = fixture();
    expect(found(scan, "openclaw", "cli", "plugins install")[0].flags).toEqual(["--force", "--accept-capabilities"]);
    expect(found(scan, "openclaw", "cli", "memory status")[0].flags).toEqual(["--json", "--deep"]);
    expect(found(scan, "openclaw", "cli", "models auth order set")[0].site).toBe("src/lib/a.ts:11");
    expect(found(scan, "openclaw", "cli", "models auth order clear")).toHaveLength(1);
    expect(found(scan, "openclaw", "cli", "never read")).toEqual([]);
    expect(found(scan, "openclaw", "config", "learned.key")[0].site).toBe("src/lib/a.ts:23");
  });

  it("reads config keys through constants, batches and bracket paths, and lists what it cannot", () => {
    const scan = fixture();
    for (const key of ["tools.profile", "a.b", "plugins.entries.*.enabled"]) expect(found(scan, "openclaw", "config", key), key).toHaveLength(1);
    expect(found(scan, "openclaw", "config", "commented.out")).toEqual([]);
    expect(scan.unchecked).toContainEqual(expect.objectContaining({ harness: "openclaw", kind: "config", site: "src/lib/a.ts:18" }));
  });

  it("reads gateway methods and events, and plugin hooks", () => {
    const scan = fixture();
    for (const m of ["config.get", "chat.send", "chat.abort"]) expect(found(scan, "openclaw", "rpc", m), m).toHaveLength(1);
    expect(found(scan, "openclaw", "event", "connect.challenge")[0].site).toBe("src/lib/a.ts:16");
    expect(found(scan, "openclaw", "hook", "before_tool_call")).toHaveLength(1);
  });

  it("reads the Hermes CLI, config keys, dashboard RPC, events and routes", () => {
    const scan = fixture();
    expect(found(scan, "hermes", "config", "tts.provider")[0]).toMatchObject({ op: "set" });
    expect(found(scan, "hermes", "config", "tts.providers.clawbox-local.type")[0]).toMatchObject({ op: "get" });
    for (const m of ["reload.env", "session.resume", "session.create"]) expect(found(scan, "hermes", "rpc", m), m).toHaveLength(1);
    expect(found(scan, "hermes", "event", "gateway.ready")[0].site).toBe("src/lib/hermes-x.ts:4");
    expect(found(scan, "hermes", "event", "message.delta")[0].site).toBe("src/lib/hermes-x.ts:6");
    expect(found(scan, "hermes", "route", "/api/providers/oauth/*/start")[0].method).toBe("POST");
    expect(found(scan, "hermes", "route", "/api/ws")[0].method).toBe("WS");
    expect(found(scan, "hermes", "cli", "dashboard")[0]).toMatchObject({ site: "config/x.service:2", flags: ["--no-open"] });
  });

  it("follows shell functions that forward to a harness, and skips what only names one", () => {
    const scan = fixture();
    expect(found(scan, "openclaw", "config", "agents.defaults.model.primary")[0].site).toBe("install.sh:12");
    expect(found(scan, "openclaw", "cli", "plugins enable codex")[0]).toMatchObject({ site: "install.sh:13", flags: ["--accept-capabilities"] });
    expect(found(scan, "openclaw", "cli", "")[0]).toMatchObject({ site: "install.sh:16", flags: ["--version"] });
    const cliSites = scan.usages.filter((u) => u.harness === "openclaw" && u.kind === "cli").map((u) => u.site);
    expect(cliSites, "the echo that names the CLI").not.toContain("install.sh:15");
    expect(cliSites, "dirname of the binary").not.toContain("install.sh:18");
    expect(cliSites, "the -x test of the binary").not.toContain("install.sh:14");
    expect(found(scan, "openclaw", "cli", "doctor")).toEqual([]);
    expect(found(scan, "hermes", "config", "tts.providers.*.command")[0]).toMatchObject({ site: "install.sh:20", force: true });
    expect(found(scan, "openclaw", "cli", "backup create")[0].flags).toEqual(["--json", "--verify"]);
  });

  it("never drops a call shape silently: it reads it, or lists it as unchecked", () => {
    const scan = scanTree(tree({
      "src/lib/b.ts": [
        "export async function f(cond: boolean, p: string) {",
        '  const base = cond ? ["models", "list"] : ["modles", "lst"];',
        '  await spawnOpenclawCli([...base, "--json"]);',
        '  await spawnOpenclawCli(["models", "list", `--provder=${p}`]);',
        '  await spawnOpenclawCli(["--log-level", "error", "config", "set", "agents.defaults.model.fallback", "x"]);',
        "}",
      ].join("\n"),
      "install.sh": [
        'OPENCLAW_BIN="$NPM_PREFIX/bin/openclaw"',
        'sudo -u clawbox "$OPENCLAW_BIN" doctor --fiks',
        '"$OPENCLAW_BIN" models list --provder="$P"',
        '"$OPENCLAW_BIN" --log-level error config set agents.defaults.model.fallback x',
      ].join("\n"),
    })) as Scan;
    expect(found(scan, "openclaw", "cli", "modles lst")).toHaveLength(1);
    expect(found(scan, "openclaw", "cli", "models list").flatMap((u) => u.flags)).toEqual(expect.arrayContaining(["--json", "--provder"]));
    expect(found(scan, "openclaw", "cli", "doctor")[0]).toMatchObject({ site: "install.sh:2", flags: ["--fiks"] });
    for (const site of ["src/lib/b.ts:5", "install.sh:4"]) {
      expect(scan.unchecked, site).toContainEqual(expect.objectContaining({ site, why: expect.stringContaining("options before the command") }));
    }
  });

  it("tells a regex from a division by the token before it, not by its spelling", () => {
    // `step.do/2` divides. Read as the start of a regex, the `/` ran to the
    // next slash — the first one of `//` — so the comment was never blanked
    // and the call written in it was taken for a real one.
    const scan = scanTree(tree({
      "src/lib/c.ts": [
        "export async function f(step: { do: number }, s: string) {",
        '  const half = step.do/2; // spawnOpenclawCli(["never", "read"])',
        '  if (half > 1) return /["\']/.test(s);',
        '  await spawnOpenclawCli(["skills", "list", "--json"]);',
        "}",
      ].join("\n"),
    })) as Scan;
    expect(found(scan, "openclaw", "cli", "never read")).toEqual([]);
    expect(found(scan, "openclaw", "cli", "skills list")[0]?.site).toBe("src/lib/c.ts:4");
  });

  it("finds, in this tree, what the hand-made maps of ClawBox's harness use list", () => {
    // A floor, not a census: one representative of each kind the research
    // mapped by hand (2026-10-15). A scanner change that loses a pattern fails
    // here rather than quietly checking less.
    const scan = scanTree(REPO) as Scan;
    const expectAt = (harness: string, kind: string, name: string, file: string, needle: string) => {
      const hits = found(scan, harness, kind, name).filter((u) => u.site.startsWith(`${file}:`));
      expect(hits.length, `${harness} ${kind} ${name} in ${file}`).toBeGreaterThan(0);
      const lines = fs.readFileSync(path.join(REPO, file), "utf-8").split("\n");
      for (const h of hits) expect(lines[Number(h.site.split(":").pop()) - 1], h.site).toContain(needle);
    };
    expectAt("openclaw", "config", "agents.defaults.model.fallbacks", "install.sh", "agents.defaults.model.fallbacks");
    expectAt("openclaw", "cli", "plugins install", "install.sh", "plugins install");
    expectAt("openclaw", "rpc", "web.login.start", "src/lib/openclaw-whatsapp.ts", "gatewayCall(");
    expectAt("openclaw", "event", "session.approval", "src/lib/gateway-approvals.ts", "session.approval");
    expectAt("openclaw", "hook", "before_tool_call", "scripts/openclaw-plugins/clawbox-path-guard/index.mjs", "before_tool_call");
    expectAt("hermes", "cli", "gateway install", "src/lib/hermes-telegram.ts", "runHermesCli(");
    expectAt("hermes", "config", "tts.providers.*.command", "install.sh", "--force");
    expectAt("hermes", "rpc", "prompt.submit", "src/lib/hermes-dashboard-turn.ts", "prompt.submit");
    expectAt("hermes", "event", "message.delta", "src/lib/hermes-dashboard-turn.ts", "message.delta");
    expectAt("hermes", "route", "/api/auth/ws-ticket", "src/lib/hermes-dashboard-auth.ts", "/api/auth/ws-ticket");
    expect(found(scan, "hermes", "cli", "chat")[0].flags).toEqual(expect.arrayContaining(["--image", "--resume"]));
  });
});

describe("the checker", () => {
  const PIN = "2026.10.3";
  type Unchecked = { harness: string; kind: string; site: string; why: string };
  const run = (opts: {
    usages: Usage[]; allow?: unknown[]; stateRow?: number; unchecked?: Unchecked[];
    recorded?: Record<string, Record<string, number>>; event?: string;
    hermesConfig?: Record<string, unknown>; routes?: [string, string][];
  }) => {
    const dir = tree({
      "config/harness-contract-allowlist.json": JSON.stringify({ entries: opts.allow ?? [] }),
      "config/harness-contract-unchecked.json": JSON.stringify(opts.recorded ?? {}),
      "src/lib/updater.ts": `const OPENCLAW_STATE_SCHEMA_BY_VERSION: Readonly<Record<string, number>> = {\n  "${PIN}": ${opts.stateRow ?? 20},\n};\n`,
      "install.sh": 'OPENCLAW_NODE_ENGINE=">=24.16.0 <25, or >=26.1.0"\nHERMES_PIN_COMMIT="${HERMES_PIN_COMMIT:-' + "a".repeat(40) + '}"\n',
      "usage.json": JSON.stringify({ usages: opts.usages, unchecked: opts.unchecked ?? [] }),
      "openclaw.json": JSON.stringify({
        version: PIN, build: "abc", schemaVersions: { state: 20, agent: 24 }, engines: { node: ">=24.16.0 <25 || >=26.1.0" },
        cli: {
          "": { usage: "Usage: openclaw [options] [command]", canonical: [], aliases: [], positional: [], children: ["config"], options: ["--version"] },
          config: { usage: "Usage: openclaw config [options] [command]", canonical: ["config"], aliases: [], positional: [], children: ["set"], options: [] },
          "config set": { usage: "Usage: openclaw config set [options] [path] [value]", canonical: ["config", "set"], aliases: [], positional: ["[path]", "[value]"], children: [], options: ["--json"] },
        },
        configPaths: ["agents.defaults.model.fallbacks", "plugins.entries.*.enabled"], rpcMethods: ["chat.send"], events: ["chat"], hooks: ["before_tool_call"],
      }),
      "hermes.json": JSON.stringify({
        cli: [{ path: "hermes", aliases: [], options: [] }], chatRules: { present: false }, validatorRefusalRule: true,
        config: opts.hermesConfig ?? {}, openrpc: {},
        // The pinned dashboard's real shape: specific routes plus the SPA's catch-all.
        routes: opts.routes ?? [["GET", "/api/model/options"], ["POST", "/api/auth/ws-ticket"], ["GET", "/{full_path:path}"]],
      }),
      "meta.json": JSON.stringify({ openclawPin: PIN, hermesCommit: "a".repeat(40), hermesTag: "v0.0.1", hermesTagCommit: null, hermesPinSite: "install.sh:2" }),
    });
    const r = spawnSync("node", [CHECK, dir, ...["usage", "openclaw", "hermes", "meta"].map((f) => path.join(dir, `${f}.json`))],
      { encoding: "utf-8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_EVENT_NAME: opts.event ?? "" } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const bad: Usage = { harness: "openclaw", kind: "config", name: "agents.defaults.model.fallback", op: "set", site: "install.sh:6918" };
  const good: Usage = { harness: "openclaw", kind: "config", name: "plugins.entries.codex.enabled", op: "set", site: "src/lib/x.ts:3" };
  const gap = { harness: "openclaw", kind: "config", name: bad.name, category: "known-gap", reason: "a test", sites: ["install.sh:6918"], expires: "2999-01-01" };

  it("names the pinned version, the key and the ClawBox file:line on every failure", () => {
    const r = run({ usages: [bad, good, { harness: "openclaw", kind: "cli", name: "config set", words: ["config", "set"], flags: ["--jsonn"], site: "a.sh:1" } as Usage] });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`FAIL    openclaw@${PIN} config agents.defaults.model.fallback — not a key of the pinned config schema  ← install.sh:6918`);
    expect(r.out).toContain(`FAIL    openclaw@${PIN} flag openclaw config set --jsonn — no such option  ← a.sh:1`);
    expect(r.out).not.toContain("plugins.entries.codex.enabled");
  });

  it("accepts an allow-listed failure, and says so", () => {
    const r = run({ usages: [bad], allow: [gap] });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/ALLOWED openclaw@2026\.10\.3 config agents\.defaults\.model\.fallback .*known-gap until 2999-01-01: a test/);
  });

  it("fails an allow-list entry that has expired, matches nothing, or gives no reason", () => {
    expect(run({ usages: [bad], allow: [{ ...gap, expires: "2000-01-01" }] }).out).toMatch(/FAIL .*expired 2000-01-01/);
    expect(run({ usages: [good], allow: [gap] }).out).toMatch(/FAIL .*matches no failure any more/);
    const noReason = run({ usages: [bad], allow: [{ ...gap, reason: "" }] });
    expect(noReason.code).toBe(1);
    expect(noReason.out).toMatch(/needs category .* reason/);
  });

  it("covers only the files an allow-list entry names", () => {
    const again: Usage = { ...bad, site: "src/lib/new-writer.ts:7" };
    const r = run({ usages: [bad, again], allow: [gap] });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ALLOWED openclaw@2026\.10\.3 config agents\.defaults\.model\.fallback .* ← install\.sh:6918/);
    expect(r.out).toMatch(/FAIL    openclaw@2026\.10\.3 config agents\.defaults\.model\.fallback .*not covered by .* ← src\/lib\/new-writer\.ts:7/);
  });

  it("warns on a pull request, and fails elsewhere, once an entry has expired", () => {
    const expired = [{ ...gap, expires: "2000-01-01" }];
    const onPr = run({ usages: [bad], allow: expired, event: "pull_request" });
    expect(onPr.code).toBe(0);
    expect(onPr.out).toMatch(/WARN .*expired 2000-01-01/);
    expect(run({ usages: [bad], allow: expired, event: "push" }).code).toBe(1);
  });

  it("does not let the dashboard's catch-all route vouch for a route that is not there", () => {
    const route = (name: string, method?: string): Usage => ({ harness: "hermes", kind: "route", name, method, site: "src/lib/hermes-x.ts:1" });
    const r = run({ usages: [route("/api/model/options"), route("/api/auth/ws-ticket", "POST"), route("/api/definitely-not-a-route"), route("/api/model/gone", "GET")] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL    hermes@v0.0.1 route ANY /api/definitely-not-a-route — no such route on the pinned dashboard");
    expect(r.out).toContain("FAIL    hermes@v0.0.1 route GET /api/model/gone");
    expect(r.out).not.toMatch(/route .*\/api\/model\/options|ws-ticket/);
  });

  it("fails a Hermes key ClawBox writes outside `hermes config set` that the pinned validator does not know", () => {
    const write: Usage = { harness: "hermes", kind: "config", name: "agent.clarify_timout", op: "write", site: "src/lib/hermes-x.ts:9" };
    const r = run({ usages: [write], hermesConfig: { "agent.clarify_timout": { known: false, refused: false, suggestion: "agent.clarify_timeout" } } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL    hermes@v0.0.1 config agent.clarify_timout — written into config.yaml, but not a key the pinned validator knows (did you mean agent.clarify_timeout)");
  });

  it("fails when more call sites are computed at runtime than are recorded", () => {
    const why = "runOpenclawConfigSet: the key is computed at runtime";
    const unchecked = [1, 2].map((n) => ({ harness: "openclaw", kind: "config", site: `src/lib/x.ts:${n}`, why }));
    expect(run({ usages: [], unchecked, recorded: { "src/lib/x.ts": { [why]: 2 } } }).code).toBe(0);
    const grew = run({ usages: [], unchecked, recorded: { "src/lib/x.ts": { [why]: 1 } } });
    expect(grew.code).toBe(1);
    expect(grew.out).toMatch(/FAIL    openclaw@2026\.10\.3 unchecked src\/lib\/x\.ts: runOpenclawConfigSet.* 2 call site\(s\), 1 recorded .* ← src\/lib\/x\.ts:1, src\/lib\/x\.ts:2/);
  });

  it("fails when the updater's state-schema row disagrees with the pinned package", () => {
    const r = run({ usages: [], stateRow: 19 });
    expect(r.code).toBe(1);
    expect(r.out).toContain('OPENCLAW_STATE_SCHEMA_BY_VERSION["2026.10.3"] — is 19; the pinned package.json says openclaw.schemaVersions.state = 20');
  });
});

describe("the committed allow-list", () => {
  it("gives every entry a reason, an expiry and sites that exist", () => {
    const { entries } = JSON.parse(fs.readFileSync(path.join(REPO, "config/harness-contract-allowlist.json"), "utf-8"));
    for (const e of entries) {
      expect(["known-gap", "version-guarded"], e.name).toContain(e.category);
      expect(e.reason.trim().length, e.name).toBeGreaterThan(20);
      expect(e.expires, e.name).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      for (const s of e.sites) expect(fs.existsSync(path.join(REPO, s.split(":")[0])), s).toBe(true);
    }
  });
});

describe("the workflow", () => {
  it("is the `harness-contract` check, on PRs to beta and main and on pushes to beta", () => {
    // Read as text, like ci-workflows.test.ts: the repo carries no YAML parser.
    const wf = fs.readFileSync(path.join(REPO, ".github/workflows/harness-contract.yml"), "utf-8");
    expect(wf).toMatch(/^on:\n {2}pull_request:\n {4}branches: \[beta, main\]\n {2}push:\n {4}branches: \[beta\]\n/m);
    expect(wf).toMatch(/^ {2}harness-contract:\n {4}name: harness-contract\n/m);
    expect(wf).toContain("run: scripts/harness-contract/run.sh");
  });
});
