import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// scripts/register-mcp.sh is what puts the ClawBox MCP server into Hermes'
// config. Before it existed, the only thing that ever registered the MCP was
// scripts/gateway-pre-start.sh — an ExecStartPre of the OpenClaw gateway unit,
// which the Hermes SKU masks — so `hermes mcp list` answered "No MCP servers
// configured" and the agent had no device tools at all.
//
// The script runs against the real ~/.hermes/config.yaml on a live appliance,
// so the properties worth pinning are the destructive ones: it must not lose
// the keys already in that file, it must not rewrite it when nothing changed,
// and it must refuse rather than overwrite when the file is not what it expects.

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");

function have(bin: string, args: string[]): boolean {
  const r = spawnSync(bin, args, { stdio: "ignore" });
  return r.status === 0;
}

// bash + python3 + PyYAML are all present on the device (and on CI Linux); a
// developer machine without them skips rather than fails.
const CAN_RUN =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);

const d = CAN_RUN ? describe : describe.skip;

let home: string;
let root: string;
let configPath: string;
let lockPath: string;

function run(env: Record<string, string> = {}): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: root,
      HERMES_CONFIG: configPath,
      HERMES_BIN: path.join(home, "fake-hermes"),
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: lockPath,
      ...env,
    },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Read the YAML back as JSON so the assertions are about values, not formatting. */
function readConfig(): Record<string, unknown> {
  const out = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
    { encoding: "utf-8" },
  );
  return JSON.parse(out);
}

function clawboxEntry(): Record<string, unknown> {
  const cfg = readConfig();
  const servers = cfg.mcp_servers as Record<string, Record<string, unknown>> | undefined;
  return servers?.clawbox ?? {};
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-reg-home-"));
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-reg-root-"));
  configPath = path.join(home, ".hermes", "config.yaml");
  lockPath = path.join(home, "edition.env");

  // The pieces the script insists on before it will write anything.
  fs.mkdirSync(path.join(root, "mcp"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp", "clawbox-mcp.ts"), "// stand-in\n");
  for (const bin of ["fake-hermes", "fake-bun"]) {
    const p = path.join(home, bin);
    fs.writeFileSync(p, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(p, 0o755);
  }
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(lockPath, "CLAWBOX_EDITION=hermes\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

d("register-mcp.sh — registering on Hermes", () => {
  it("adds mcp_servers.clawbox to a config that has none", () => {
    fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n");
    const r = run();
    expect(r.status).toBe(0);

    const entry = clawboxEntry();
    expect(entry.command).toBe(path.join(home, "fake-bun"));
    expect(entry.args).toEqual(["run", path.join(root, "mcp", "clawbox-mcp.ts")]);
    expect(entry.enabled).toBe(true);
  });

  it("keeps every key the config already had", () => {
    fs.writeFileSync(
      configPath,
      "model:\n  default: deepseek-v4-pro\nproviders:\n  clawai:\n    api_key: keep-me\nskills:\n  enabled: true\n",
    );
    run();

    const cfg = readConfig();
    expect(cfg.model).toEqual({ default: "deepseek-v4-pro" });
    expect(cfg.providers).toEqual({ clawai: { api_key: "keep-me" } });
    expect(cfg.skills).toEqual({ enabled: true });
  });

  it("leaves an MCP server someone else registered alone", () => {
    fs.writeFileSync(configPath, "mcp_servers:\n  other:\n    url: http://example.invalid\n");
    run();

    const servers = readConfig().mcp_servers as Record<string, unknown>;
    expect(servers.other).toEqual({ url: "http://example.invalid" });
    expect(servers.clawbox).toBeTruthy();
  });

  it("writes no bearer token into the config", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();

    // The MCP server reads data/.mcp-token itself, so the config carries no
    // secret and rotating the token is not a config-sync problem.
    const raw = fs.readFileSync(configPath, "utf-8");
    expect(raw).not.toMatch(/token/i);
    expect(JSON.stringify(clawboxEntry().env)).not.toMatch(/token/i);
  });

  it("keeps the config owner-only", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    fs.chmodSync(configPath, 0o600);
    run();
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("creates the config when Hermes has not been onboarded yet", () => {
    fs.rmSync(configPath, { force: true });
    const r = run();
    expect(r.status).toBe(0);
    expect(clawboxEntry().enabled).toBe(true);
  });

  it("mints the bearer token file if it is missing, owner-only", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    const tokenPath = path.join(root, "data", ".mcp-token");
    expect(fs.readFileSync(tokenPath, "utf-8").trim().length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(tokenPath).mode & 0o777).toBe(0o600);
  });

  it("does not disturb a bearer token that already exists", () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    const tokenPath = path.join(root, "data", ".mcp-token");
    const existing = "a".repeat(64);
    fs.writeFileSync(tokenPath, existing);
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    expect(fs.readFileSync(tokenPath, "utf-8").trim()).toBe(existing);
  });
});

d("register-mcp.sh — idempotence", () => {
  it("does not rewrite the file on a second run", () => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    const first = fs.readFileSync(configPath, "utf-8");

    const second = run();
    expect(second.stdout).toContain("already current");
    expect(fs.readFileSync(configPath, "utf-8")).toBe(first);
  });

  it("repairs an entry that was edited to point somewhere else", () => {
    fs.writeFileSync(
      configPath,
      "mcp_servers:\n  clawbox:\n    command: /usr/bin/false\n    args: []\n",
    );
    run();
    expect(clawboxEntry().command).toBe(path.join(home, "fake-bun"));
  });
});

d("register-mcp.sh — when it must do nothing", () => {
  it("exits without touching the config on an OpenClaw device", () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=openclaw\n");
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().mcp_servers).toBeUndefined();
  });

  it("registers on the premium dual SKU, which also runs Hermes", () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=dual\n");
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
    expect(clawboxEntry().enabled).toBe(true);
  });

  it("prefers the root-owned lock over the environment", () => {
    fs.writeFileSync(lockPath, "CLAWBOX_EDITION=openclaw\n");
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run({ CLAWBOX_EDITION: "hermes" });
    expect(readConfig().mcp_servers).toBeUndefined();
  });

  it("does nothing when Hermes is not installed", () => {
    fs.rmSync(path.join(home, "fake-hermes"));
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().mcp_servers).toBeUndefined();
  });
});

d("register-mcp.sh — refuses rather than clobbers", () => {
  it("fails loudly when the config is not valid YAML", () => {
    const broken = "model:\n  default: [unclosed\n";
    fs.writeFileSync(configPath, broken);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(broken);
  });

  it("fails when the MCP entry point is missing", () => {
    fs.rmSync(path.join(root, "mcp", "clawbox-mcp.ts"));
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const r = run();
    expect(r.status).not.toBe(0);
    expect(readConfig().mcp_servers).toBeUndefined();
  });

  it("fails when bun is not where it is expected", () => {
    fs.rmSync(path.join(home, "fake-bun"));
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    const r = run();
    expect(r.status).not.toBe(0);
  });
});

d("register-mcp.sh — the entry Hermes will accept", () => {
  beforeEach(() => {
    fs.writeFileSync(configPath, "model:\n  default: x\n");
    run();
  });

  it("launches a real executable, never a shell with an inline script", () => {
    // Hermes' own supply-chain gate rejects a shell interpreter as the command,
    // both when the entry is saved and again when the server is spawned.
    const entry = clawboxEntry();
    expect(path.basename(String(entry.command))).not.toMatch(/^(ba|z|k)?sh$|^cmd$/);
    expect(entry.args).toEqual(expect.arrayContaining(["run"]));
  });

  it("points the MCP at the device API on loopback", () => {
    expect(clawboxEntry().env).toEqual({ CLAWBOX_API_BASE: "http://127.0.0.1:80" });
  });

  it("allows enough time for a cold start on a loaded device", () => {
    expect(Number(clawboxEntry().connect_timeout)).toBeGreaterThanOrEqual(15);
  });
});
