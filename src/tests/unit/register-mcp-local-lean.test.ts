import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test default is not
// enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// What scripts/register-mcp.sh does for the on-device model on a Hermes box, at
// every web-server start:
//
//   * installs and enables the clawbox_local_lean plugin (llm_request
//     middleware: the lean prompt and tools for the box's own llama.cpp model);
//   * makes Hermes' Tool Search follow the default model — off while the
//     default is the local llama.cpp model, Hermes' own default otherwise —
//     touching only the legacy scalar `tools.tool_search: false` ClawBox writes
//     (the boot half of src/lib/hermes-local-tool-search.ts).
//
// Same sandbox as register-mcp-email-hook.test.ts: a temporary HOME, a stub
// `hermes` and a fake bun, so nothing here reaches a real Hermes.

const REPO = path.resolve(__dirname, "../../..");
const SCRIPT = path.join(REPO, "scripts", "register-mcp.sh");
const LEAN = "clawbox_local_lean";
const LLAMACPP = "http://127.0.0.1/setup-api/local-ai/llamacpp/v1";
const OLLAMA = "http://127.0.0.1/setup-api/local-ai/ollama/v1";

function have(bin: string, args: string[]): boolean {
  return spawnSync(bin, args, { stdio: "ignore" }).status === 0;
}

const CAN_RUN =
  process.platform !== "win32"
  && have("bash", ["-c", "true"])
  && have("python3", ["-c", "import yaml"]);
const d = CAN_RUN ? describe : describe.skip;

let home: string;
let configPath: string;
let pluginsDir: string;

function run() {
  const hermesBin = path.join(home, "fake-hermes");
  const r = spawnSync("bash", [SCRIPT], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "",
      HOME: home,
      CLAWBOX_ROOT: REPO,
      HERMES_CONFIG: configPath,
      HERMES_BIN: hermesBin,
      BUN_BIN: path.join(home, "fake-bun"),
      CLAWBOX_EDITION_FILE: path.join(home, "edition.env"),
    }),
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function readConfig(): Record<string, unknown> {
  const out = execFileSync(
    "python3",
    ["-c", "import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1])) or {}))", configPath],
    { encoding: "utf-8" },
  );
  return JSON.parse(out);
}

const tools = () => readConfig().tools as Record<string, unknown> | undefined;

function defaultOn(provider: string, localUrl: string | null, extra = ""): void {
  fs.writeFileSync(
    configPath,
    [
      "model:",
      "  default: gemma4-e2b-it-q4_0",
      `  provider: ${provider}`,
      ...(localUrl ? ["providers:", "  clawlocal:", `    base_url: ${localUrl}`, "    api_mode: openai"] : []),
      extra,
    ].join("\n") + "\n",
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-lean-home-"));
  configPath = path.join(home, ".hermes", "config.yaml");
  pluginsDir = path.join(home, ".hermes", "plugins");
  fs.mkdirSync(path.join(home, ".hermes"), { recursive: true });
  fs.writeFileSync(path.join(home, "edition.env"), "CLAWBOX_EDITION=hermes\n");
  fs.writeFileSync(path.join(home, "fake-bun"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(home, "fake-bun"), 0o755);
  fs.writeFileSync(path.join(home, "fake-hermes"), "#!/usr/bin/env bash\nexit 0\n");
  fs.chmodSync(path.join(home, "fake-hermes"), 0o755);
  fs.writeFileSync(configPath, "model:\n  default: deepseek-v4-pro\n  provider: clawai\n");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

d("register-mcp.sh — the lean-mode plugin", () => {
  it("installs the shipped plugin, all of it, and enables it beside the others", () => {
    fs.writeFileSync(configPath, "plugins:\n  enabled:\n    - clawai\n");
    const r = run();
    expect(r.status).toBe(0);
    const dir = path.join(pluginsDir, LEAN);
    expect(fs.readdirSync(dir).sort()).toEqual(["__init__.py", "local_lean.py", "plugin.yaml"]);
    for (const file of ["__init__.py", "local_lean.py", "plugin.yaml"]) {
      expect(fs.readFileSync(path.join(dir, file), "utf-8"))
        .toBe(fs.readFileSync(path.join(REPO, "scripts/hermes-plugins", LEAN, file), "utf-8"));
    }
    const enabled = (readConfig().plugins as { enabled: string[] }).enabled;
    expect(enabled[0]).toBe("clawai");
    expect(enabled).toContain(LEAN);
    expect(r.stdout).toContain(`enabled the ${LEAN} plugin`);
  });

  it("drops stale bytecode, and changes nothing on a second run", () => {
    run();
    const cache = path.join(pluginsDir, LEAN, "__pycache__");
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, "local_lean.cpython-311.pyc"), "stale");
    const before = fs.readFileSync(configPath, "utf-8");
    const r = run();
    expect(fs.existsSync(cache)).toBe(false);
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
    expect(r.stdout).toContain("already current");
  });

  it("removes a copy that died half-way rather than leaving Hermes to import it", () => {
    run();
    const target = path.join(pluginsDir, LEAN, "local_lean.py");
    fs.rmSync(target);
    fs.mkdirSync(target);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`could not install the ${LEAN} plugin`);
    expect(fs.existsSync(path.join(pluginsDir, LEAN))).toBe(false);
  });
});

d("register-mcp.sh — Hermes' Tool Search follows the default model", () => {
  it("turns it off while the default is the box's own llama.cpp model", () => {
    defaultOn("clawlocal", LLAMACPP);
    const r = run();
    expect(r.status).toBe(0);
    expect(tools()).toEqual({ tool_search: false });
    expect(r.stdout).toContain("turned Hermes' Tool Search off");
    // Idempotent.
    expect(run().stdout).toContain("already current");
  });

  it("gives it back when the default moved on, keeping the rest of tools", () => {
    defaultOn("clawai", LLAMACPP, "tools:\n  tool_search: false\n  other: 1\n");
    const r = run();
    expect(tools()).toEqual({ other: 1 });
    expect(r.stdout).toContain("gave Hermes' Tool Search back its default");

    defaultOn("clawai", null, "tools:\n  tool_search: false\n");
    run();
    expect(readConfig()).not.toHaveProperty("tools");
  });

  it("never touches an owner's own setting", () => {
    for (const provider of ["clawlocal", "clawai"]) {
      defaultOn(provider, LLAMACPP, "tools:\n  tool_search:\n    enabled: 'off'\n");
      run();
      expect(tools()).toEqual({ tool_search: { enabled: "off" } });
      defaultOn(provider, LLAMACPP, "tools:\n  tool_search: true\n");
      run();
      expect(tools()).toEqual({ tool_search: true });
    }
  });

  it("leaves an Ollama-backed local default alone: its tools are not narrowed", () => {
    defaultOn("clawlocal", OLLAMA);
    run();
    expect(readConfig()).not.toHaveProperty("tools");
  });
});
