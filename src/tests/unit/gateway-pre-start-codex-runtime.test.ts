import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// `agents.defaults.models["codex/*"].agentRuntime = {"id":"codex"}` is what
// routes a codex turn through the Codex app-server harness. WITHOUT it core
// uses its generic HTTP responses transport, which posts to
// https://chatgpt.com/backend-api/responses — a browser endpoint Cloudflare
// managed-challenges — and every turn fails with "the provider returned an HTML
// error page". Proven on a live box on 2026-07-28: with the key `CODEX OK`;
// remove it, restart, same box, HTML challenge.
//
// ClawBox used to delete this key unconditionally (it broke strict validation
// on an older pinned core). This exercises the real policy block out of the
// shipped script so that deletion can never come back for codex models.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const SCRIPT_SOURCE = readFileSync(SCRIPT, "utf-8");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** Pull the agentRuntime policy block out of the .sh verbatim. */
function extractPolicy(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf("agents_models = agents_defaults.get(\"models\")");
  const end = src.indexOf("# Security migration:", start);
  if (start < 0 || end < 0) throw new Error("agentRuntime policy block not found");
  return src.slice(start, end);
}

const POLICY = hasPython3 ? extractPolicy() : "";

/** Pull the configured/runtime Codex demand probe out of the shell heredoc. */
function extractNeedsProbe(): string {
  const startMarker = 'NEEDS_CODEX_PLUGIN="$(python3 - "$OPENCLAW_CONFIG" <<\'PY\'\n';
  const start = SCRIPT_SOURCE.indexOf(startMarker);
  const end = SCRIPT_SOURCE.indexOf('\nPY\n)"', start);
  if (start < 0 || end < 0) throw new Error("Codex demand probe not found");
  return SCRIPT_SOURCE.slice(start + startMarker.length, end);
}

const NEEDS_PROBE = hasPython3 ? extractNeedsProbe() : "";

/** Pull the enabled-plugin consent probe out of the shell heredoc verbatim. */
function extractEnabledProbe(): string {
  const startMarker = 'CODEX_PLUGIN_ENABLED="$(python3 - "$OPENCLAW_CONFIG" <<\'PY\'\n';
  const start = SCRIPT_SOURCE.indexOf(startMarker);
  const end = SCRIPT_SOURCE.indexOf('\nPY\n)"', start);
  if (start < 0 || end < 0) throw new Error("Codex enabled-plugin probe not found");
  return SCRIPT_SOURCE.slice(start + startMarker.length, end);
}

const ENABLED_PROBE = hasPython3 ? extractEnabledProbe() : "";

/** Pull the cross-layout plugin-root resolver out of the script verbatim. */
function extractPluginResolver(): string {
  const start = SCRIPT_SOURCE.indexOf(
    'CODEX_PLUGIN_DIR="$OPENCLAW_HOME_DIR/npm/node_modules/@openclaw/codex"',
  );
  const end = SCRIPT_SOURCE.indexOf('NEEDS_CODEX_PLUGIN="$(python3', start);
  if (start < 0 || end < 0) throw new Error("Codex plugin resolver not found");
  return SCRIPT_SOURCE.slice(start, end);
}

const PLUGIN_RESOLVER = extractPluginResolver();

/** Pull the package-health/repair/consent command flow out verbatim. */
function extractPluginFlow(): string {
  const start = SCRIPT_SOURCE.indexOf('CODEX_SHOULD_LOAD="$NEEDS_CODEX_PLUGIN"');
  const end = SCRIPT_SOURCE.indexOf("# Codex reads its ChatGPT session", start);
  if (start < 0 || end < 0) throw new Error("Codex plugin command flow not found");
  return SCRIPT_SOURCE.slice(start, end);
}

const PLUGIN_FLOW = extractPluginFlow();

let dir: string;

interface ModelSettings {
  agentRuntime?: { id?: string };
  params?: unknown;
  [key: string]: unknown;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "codex-runtime-policy-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the extracted policy against a config and return the resulting models map. */
function applyPolicy(
  config: Record<string, unknown>,
  openclawV2 = false,
): Record<string, ModelSettings> {
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(config));
  const program = [
    "import json, sys",
    "cfg = json.load(open(sys.argv[1]))",
    "changed = False",
    "agents_defaults = cfg.setdefault('agents', {}).setdefault('defaults', {})",
    "model_defaults = agents_defaults.setdefault('model', {})",
    `_clawbox_v2_codex = ${openclawV2 ? "True" : "False"}`,
    POLICY,
    "print(json.dumps(agents_defaults.get('models') or {}))",
  ].join("\n");
  return JSON.parse(
    execFileSync("python3", ["-c", program, file], { encoding: "utf-8" }).trim(),
  ) as Record<string, ModelSettings>;
}

/** Run the exact shell-embedded probe that decides whether consent is needed. */
function probeCodexEnabled(config: Record<string, unknown>): string {
  const file = path.join(dir, "enabled-config.json");
  writeFileSync(file, JSON.stringify(config));
  return execFileSync("python3", ["-c", ENABLED_PROBE, file], { encoding: "utf-8" }).trim();
}

/** Run the exact probe that decides whether Codex must be repaired/enabled. */
function probeNeedsCodex(config: Record<string, unknown>): string {
  const file = path.join(dir, "needs-config.json");
  writeFileSync(file, JSON.stringify(config));
  return execFileSync("python3", ["-c", NEEDS_PROBE, file], { encoding: "utf-8" }).trim();
}

interface PluginFlowOptions {
  v2: boolean;
  needsCodex: boolean;
  enabledByConfig: boolean;
  installedVersion?: string;
  peerHealthy?: boolean;
}

/** Execute the shipped shell command flow against a fake OpenClaw binary. */
function runPluginFlow(options: PluginFlowOptions): string[] {
  const pluginDir = path.join(dir, "plugin", "node_modules", "@openclaw", "codex");
  if (options.installedVersion) {
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({ version: options.installedVersion }),
    );
  }
  if (options.peerHealthy) {
    const peerDir = path.join(pluginDir, "node_modules", "openclaw");
    mkdirSync(peerDir, { recursive: true });
    writeFileSync(path.join(peerDir, "package.json"), JSON.stringify({ version: "2026.8.1" }));
  }

  const log = path.join(dir, "openclaw-commands.log");
  const fakeOpenClaw = path.join(dir, "openclaw");
  writeFileSync(fakeOpenClaw, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CODEX_TEST_LOG"\n');
  chmodSync(fakeOpenClaw, 0o755);

  execFileSync("bash", ["-c", `set -euo pipefail\n${PLUGIN_FLOW}`], {
    env: {
      ...process.env,
      CLAWBOX_OPENCLAW_V2: options.v2 ? "1" : "0",
      NEEDS_CODEX_PLUGIN: options.needsCodex ? "1" : "0",
      CODEX_PLUGIN_ENABLED: options.enabledByConfig ? "1" : "0",
      CODEX_PLUGIN_DIR: pluginDir,
      OPENCLAW_TARGET: "2026.8.1",
      OPENCLAW_BIN: fakeOpenClaw,
      CODEX_TEST_LOG: log,
    },
    stdio: "pipe",
  });

  return existsSync(log)
    ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean)
    : [];
}

/** Resolve a plugin exposed only through OpenClaw's own global registry. */
function resolveRegistryOnlyPlugin(): string {
  const openclawHome = path.join(dir, "openclaw-home");
  const registryRoot = path.join(dir, "global-plugins", "codex");
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(path.join(registryRoot, "package.json"), JSON.stringify({ version: "2026.8.1" }));

  const fakeOpenClaw = path.join(dir, "registry-openclaw");
  const registryJson = JSON.stringify({
    plugins: [{ id: "codex", rootDir: registryRoot, source: path.join(registryRoot, "dist", "index.js") }],
  });
  writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env bash\nprintf '%s\\n' '${registryJson}'\n`,
  );
  chmodSync(fakeOpenClaw, 0o755);

  return execFileSync(
    "bash",
    ["-c", `set -euo pipefail\n${PLUGIN_RESOLVER}\nprintf '%s\\n' "$CODEX_PLUGIN_DIR"`],
    {
      env: {
        ...process.env,
        OPENCLAW_HOME_DIR: openclawHome,
        OPENCLAW_BIN: fakeOpenClaw,
      },
      encoding: "utf-8",
    },
  ).trim();
}

describe.skipIf(!hasPython3)("gateway-pre-start.sh agentRuntime policy", () => {
  it("accepts declared capabilities when repairing the Codex plugin", () => {
    expect(SCRIPT_SOURCE).toContain('if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then');
    expect(SCRIPT_SOURCE).toContain('CODEX_CAPABILITY_ARGS=(--accept-capabilities)');
    expect(SCRIPT_SOURCE).toContain(
      'plugins install "$CODEX_SPEC" --force "${CODEX_CAPABILITY_ARGS[@]}"',
    );
  });

  it("accepts declared capabilities when the migrated plugin needs no reinstall", () => {
    const healthyV2Branch =
      'elif [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ "$CODEX_SHOULD_LOAD" = "1" ]';
    expect(SCRIPT_SOURCE).toContain(healthyV2Branch);
    expect(SCRIPT_SOURCE).toContain('CODEX_PLUGIN_ENABLED="$(python3 - "$OPENCLAW_CONFIG"');
    expect(SCRIPT_SOURCE).toContain(
      'if [ "$CODEX_SHOULD_LOAD" = "1" ]; then',
    );
    expect(SCRIPT_SOURCE).toContain(
      'plugins enable codex --accept-capabilities',
    );
    expect(SCRIPT_SOURCE.indexOf('plugins enable codex --accept-capabilities'))
      .toBeGreaterThan(SCRIPT_SOURCE.indexOf(healthyV2Branch));
  });

  it("treats an installed Codex plugin as enabled by default unless explicitly disabled", () => {
    expect(probeCodexEnabled({
      agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
      plugins: { entries: { codex: { enabled: true } } },
    })).toBe("1");
    expect(probeCodexEnabled({
      agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
      plugins: { entries: {} },
    })).toBe("1");
    expect(probeCodexEnabled({})).toBe("1");
    expect(probeCodexEnabled({ plugins: { entries: { codex: { enabled: false } } } })).toBe("0");
  });

  it("resolves a historical Codex package that only OpenClaw's registry can see", () => {
    expect(resolveRegistryOnlyPlugin()).toBe(path.join(dir, "global-plugins", "codex"));
  });

  it("detects OpenClaw v2's migrated OpenAI model with a Codex agent runtime", () => {
    const migratedConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
      plugins: { entries: { codex: { enabled: false } } },
    };
    const normalizedModels = applyPolicy(migratedConfig, true);
    const normalizedConfig = {
      ...migratedConfig,
      agents: {
        defaults: {
          ...migratedConfig.agents.defaults,
          models: normalizedModels,
        },
      },
    };

    expect(normalizedModels["openai/gpt-5.6-sol"].agentRuntime).toEqual({ id: "codex" });
    expect(probeNeedsCodex(normalizedConfig)).toBe("1");
    expect(probeCodexEnabled(normalizedConfig)).toBe("0");
    expect(runPluginFlow({
      v2: true,
      needsCodex: probeNeedsCodex(normalizedConfig) === "1",
      enabledByConfig: probeCodexEnabled(normalizedConfig) === "1",
      installedVersion: "2026.8.1",
      peerHealthy: true,
    })).toEqual(["plugins enable codex --accept-capabilities"]);
  });

  it("repairs a stale default-enabled v2 plugin at the pinned version", () => {
    expect(runPluginFlow({
      v2: true,
      needsCodex: false,
      enabledByConfig: true,
      installedVersion: "2026.7.0",
      peerHealthy: true,
    })).toEqual([
      "plugins install @openclaw/codex@2026.8.1 --force --accept-capabilities",
    ]);
  });

  it("repairs a broken peer dependency before consenting a default-enabled plugin", () => {
    expect(runPluginFlow({
      v2: true,
      needsCodex: false,
      enabledByConfig: true,
      installedVersion: "2026.8.1",
      peerHealthy: false,
    })).toEqual([
      "plugins install @openclaw/codex@2026.8.1 --force --accept-capabilities",
    ]);
  });

  it("consents a healthy default-enabled v2 plugin without reinstalling it", () => {
    expect(runPluginFlow({
      v2: true,
      needsCodex: false,
      enabledByConfig: true,
      installedVersion: "2026.8.1",
      peerHealthy: true,
    })).toEqual(["plugins enable codex --accept-capabilities"]);
  });

  it("leaves an explicitly disabled unused plugin alone", () => {
    expect(runPluginFlow({
      v2: true,
      needsCodex: false,
      enabledByConfig: false,
      installedVersion: "2026.8.1",
      peerHealthy: true,
    })).toEqual([]);
  });

  it("repairs a v1 plugin without passing the v2 capability flag", () => {
    expect(runPluginFlow({
      v2: false,
      needsCodex: true,
      enabledByConfig: false,
      installedVersion: "2026.8.1",
      peerHealthy: false,
    })).toEqual(["plugins install @openclaw/codex@2026.8.1 --force"]);
  });

  it("sets agentRuntime on the configured codex primary", () => {
    const models = applyPolicy({
      agents: { defaults: { model: { primary: "codex/gpt-5.5", fallbacks: [] } } },
    });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("sets agentRuntime on codex fallbacks too", () => {
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "deepseek/deepseek-v4-flash", fallbacks: ["codex/gpt-5.5"] },
        },
      },
    });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("never strips agentRuntime from a codex model", () => {
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5" },
          models: { "codex/gpt-5.5": { agentRuntime: { id: "codex" } } },
        },
      },
    });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("repairs a codex entry whose agentRuntime was removed", () => {
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5" },
          models: { "codex/gpt-5.5": {} },
        },
      },
    });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("still strips an orphaned agentRuntime from a non-codex model", () => {
    // The original reason the strip existed: a newer-than-pinned plugin wrote
    // the key, a downgrade orphaned it, and strict validation bricked the page.
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "deepseek/deepseek-v4-flash" },
          models: { "deepseek/deepseek-v4-flash": { agentRuntime: { id: "codex" } } },
        },
      },
    });
    expect(models["deepseek/deepseek-v4-flash"].agentRuntime).toBeUndefined();
  });

  it("preserves other per-model settings while adding agentRuntime", () => {
    const models = applyPolicy({
      agents: {
        defaults: {
          model: { primary: "codex/gpt-5.5" },
          models: { "codex/gpt-5.5": { params: { thinking: "high" } } },
        },
      },
    });
    expect(models["codex/gpt-5.5"].params).toEqual({ thinking: "high" });
    expect(models["codex/gpt-5.5"].agentRuntime).toEqual({ id: "codex" });
  });

  it("does nothing when no codex model is configured", () => {
    const models = applyPolicy({
      agents: { defaults: { model: { primary: "llamacpp/gemma4-e2b-it-q4_0" } } },
    });
    expect(models).toEqual({});
  });
});
