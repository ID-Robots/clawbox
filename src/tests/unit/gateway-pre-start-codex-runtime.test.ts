import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

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

/**
 * Pull the auth-profile helpers the policy block calls out of the .sh verbatim.
 * The policy asks them which OpenAI credentials the box holds, and running a
 * hand-written stand-in here would test a copy of the rule, not the rule.
 */
function extractProfileHelpers(): string {
  const start = SCRIPT_SOURCE.indexOf("def _auth_profiles():");
  const end = SCRIPT_SOURCE.indexOf("def _openai_gpt_to_codex(", start);
  if (start < 0 || end < 0) throw new Error("auth profile helpers not found");
  return SCRIPT_SOURCE.slice(start, end);
}

const PROFILE_HELPERS = hasPython3 ? extractProfileHelpers() : "";

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
const MANAGED_CONSENT_MARKER = "# \u2500\u2500 Capability consent for the OTHER ClawBox-managed plugins";

function extractPluginFlow(): string {
  const start = SCRIPT_SOURCE.indexOf('CODEX_SHOULD_LOAD="$NEEDS_CODEX_PLUGIN"');
  // Ends where the block for the OTHER managed plugins begins: that one has its
  // own extraction and its own harness below, and it reads openclaw.json, which
  // this fragment's environment does not set.
  const end = SCRIPT_SOURCE.indexOf(MANAGED_CONSENT_MARKER, start);
  if (start < 0 || end < 0) throw new Error("Codex plugin command flow not found");
  return SCRIPT_SOURCE.slice(start, end);
}

/** The boot-path consent pass for deepseek / discord / whatsapp / our own plugin. */
function extractManagedConsentFlow(): string {
  const start = SCRIPT_SOURCE.indexOf(MANAGED_CONSENT_MARKER);
  const end = SCRIPT_SOURCE.indexOf("# Codex reads its ChatGPT session", start);
  if (start < 0 || end < 0) throw new Error("Managed-plugin consent flow not found");
  return SCRIPT_SOURCE.slice(start, end);
}

const PLUGIN_FLOW = extractPluginFlow();
const MANAGED_CONSENT_FLOW = extractManagedConsentFlow();

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
    PROFILE_HELPERS,
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
  layout?: "flat-managed" | "project-managed" | "registry";
  registryDependenciesOk?: boolean;
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
      CODEX_PLUGIN_LAYOUT: options.layout ?? "project-managed",
      CODEX_REGISTRY_DEPS_OK: options.registryDependenciesOk ? "1" : "0",
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

/**
 * Run the boot-path consent pass for the managed plugins that are NOT codex.
 *
 * TASK-603. The codex arm above has consented its one plugin on every boot
 * since OpenClaw 2 introduced declared-capability consent; the gateway refuses
 * readiness for any enabled plugin in that state, and ClawBox installs four
 * more. The 2026-09-01 outage was `discord`, and a reboot — the owner's first
 * move on a box that will not come up — changed nothing.
 */
function runManagedConsentFlow(options: {
  v2?: boolean;
  entries?: Record<string, unknown>;
  writeConfig?: boolean;
}): string[] {
  const config = path.join(dir, "managed-consent.json");
  if (options.writeConfig !== false) {
    writeFileSync(config, JSON.stringify({ plugins: { entries: options.entries ?? {} } }));
  }

  const log = path.join(dir, "managed-consent.log");
  const fakeOpenClaw = path.join(dir, "openclaw-managed");
  writeFileSync(fakeOpenClaw, '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$CODEX_TEST_LOG"\n');
  chmodSync(fakeOpenClaw, 0o755);

  execFileSync("bash", ["-c", `set -euo pipefail\n${MANAGED_CONSENT_FLOW}`], {
    env: {
      ...process.env,
      CLAWBOX_OPENCLAW_V2: options.v2 === false ? "0" : "1",
      OPENCLAW_CONFIG: config,
      OPENCLAW_BIN: fakeOpenClaw,
      CODEX_TEST_LOG: log,
    },
    stdio: "pipe",
  });

  return existsSync(log)
    ? readFileSync(log, "utf-8").trim().split("\n").filter(Boolean)
    : [];
}

describe("gateway-pre-start.sh managed-plugin capability consent", () => {
  it("consents every managed plugin openclaw.json says to load", () => {
    expect(runManagedConsentFlow({
      entries: {
        deepseek: { enabled: true },
        discord: { enabled: true },
        whatsapp: { enabled: true },
        "clawbox-email-directives": { enabled: true },
      },
    })).toEqual([
      "plugins enable deepseek --accept-capabilities",
      "plugins enable discord --accept-capabilities",
      "plugins enable whatsapp --accept-capabilities",
      "plugins enable clawbox-email-directives --accept-capabilities",
    ]);
  });

  it("never switches a plugin ON — only entries already enabled are consented", () => {
    // `plugins enable` writes `plugins.entries.<id>.enabled = true`, so a boot
    // script that ran it over an absent or disabled entry would be turning a
    // channel on behind the owner. Consent is for what the box already loads.
    expect(runManagedConsentFlow({
      entries: { discord: { enabled: false }, whatsapp: {} },
    })).toEqual([]);
  });

  it("leaves a plugin ClawBox does not manage alone", () => {
    expect(runManagedConsentFlow({ entries: { weatherbot: { enabled: true } } })).toEqual([]);
  });

  it("recognises the plugin under the alias the registry may have keyed it as", () => {
    // `ensureChannelPlugin` enables the plugin under the id `plugins list`
    // reports, which can be `openclaw-discord` or `@openclaw/discord`. Matching
    // the literal key would skip an enabled alias and leave the gateway
    // blocked on the very consent refusal this block exists to clear — and the
    // CLI has to be given the configured key back, because that is the name
    // the registry answers to.
    expect(runManagedConsentFlow({
      entries: {
        "openclaw-discord": { enabled: true },
        "@openclaw/whatsapp": { enabled: true },
      },
    })).toEqual([
      "plugins enable openclaw-discord --accept-capabilities",
      "plugins enable @openclaw/whatsapp --accept-capabilities",
    ]);
  });

  it("respects a disabled ALIAS as it respects a disabled canonical entry", () => {
    expect(runManagedConsentFlow({ entries: { "openclaw-discord": { enabled: false } } }))
      .toEqual([]);
  });

  it("does nothing on OpenClaw 1, which has no capability consent", () => {
    expect(runManagedConsentFlow({ v2: false, entries: { discord: { enabled: true } } }))
      .toEqual([]);
  });

  it("survives a missing or unparseable config rather than failing the pre-start", () => {
    // This is a blocking ExecStartPre under `set -euo pipefail`: a throw here
    // is a box with no gateway, which is strictly worse than an unconsented
    // plugin the journal will name.
    expect(runManagedConsentFlow({ writeConfig: false })).toEqual([]);
  });
});

/** Resolve a plugin exposed only through OpenClaw's own global registry. */
function resolveRegistryOnlyPlugin(): string {
  const openclawHome = path.join(dir, "openclaw-home");
  const registryRoot = path.join(dir, "global-plugins", "codex");
  mkdirSync(registryRoot, { recursive: true });
  writeFileSync(path.join(registryRoot, "package.json"), JSON.stringify({ version: "2026.8.1" }));

  const fakeOpenClaw = path.join(dir, "registry-openclaw");
  const registryJson = JSON.stringify({
    plugins: [{
      id: "codex",
      rootDir: registryRoot,
      source: path.join(registryRoot, "dist", "index.js"),
      dependencyStatus: { requiredInstalled: true },
    }],
  });
  writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env bash\nprintf '%s\\n' '${registryJson}'\n`,
  );
  chmodSync(fakeOpenClaw, 0o755);

  return execFileSync(
    "bash",
    ["-c", `set -euo pipefail\n${PLUGIN_RESOLVER}\nprintf '%s|%s|%s\\n' "$CODEX_PLUGIN_LAYOUT" "$CODEX_PLUGIN_DIR" "$CODEX_REGISTRY_DEPS_OK"`],
    {
      env: {
        ...process.env,
        OPENCLAW_HOME_DIR: openclawHome,
        OPENCLAW_BIN: fakeOpenClaw,
        CLAWBOX_OPENCLAW_V2: "1",
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
    expect(resolveRegistryOnlyPlugin()).toBe(
      `registry|${path.join(dir, "global-plugins", "codex")}|1`,
    );
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

  it("does not apply the managed nested-peer heuristic to a registry plugin", () => {
    expect(runPluginFlow({
      v2: true,
      needsCodex: true,
      enabledByConfig: false,
      installedVersion: "2026.8.1",
      peerHealthy: false,
      layout: "registry",
      registryDependenciesOk: true,
    })).toEqual(["plugins enable codex --accept-capabilities"]);
  });

  it("trusts parent-resolved registry dependencies for a project-managed plugin", () => {
    expect(runPluginFlow({
      v2: true,
      needsCodex: true,
      enabledByConfig: false,
      installedVersion: "2026.8.1",
      peerHealthy: false,
      layout: "project-managed",
      registryDependenciesOk: true,
    })).toEqual(["plugins enable codex --accept-capabilities"]);
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

// OpenClaw 2 references the ChatGPT subscription as `openai/<id>` and keeps
// the Codex runtime on that entry. The boot seed above only ever recognised
// the retired `codex/` namespace, so on the core ClawBox pins it repaired
// nothing — and the arm is what keeps a ChatGPT turn off the browser endpoint
// Cloudflare challenges.
describe.runIf(hasPython3)("the boot seed on OpenClaw 2", () => {
  const CHATGPT_ONLY = {
    auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
    agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
  };

  it("seeds the runtime arm for an openai/<id> primary on a ChatGPT box", () => {
    const models = applyPolicy(structuredClone(CHATGPT_ONLY), true);
    expect(models["openai/gpt-5.5"]).toEqual({ agentRuntime: { id: "codex" } });
  });

  it("seeds it for the fallbacks too", () => {
    const models = applyPolicy({
      ...structuredClone(CHATGPT_ONLY),
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5", fallbacks: ["openai/gpt-5.4", "deepseek/deepseek-v4-flash"] },
        },
      },
    }, true);
    expect(models["openai/gpt-5.4"]).toEqual({ agentRuntime: { id: "codex" } });
    expect(models["deepseek/deepseek-v4-flash"]).toBeUndefined();
  });

  it("leaves an openai/<id> alone on a box that also holds an API key", () => {
    // Ambiguous at boot: the same reference is the API-key route there, and
    // arming it would push those turns through the Codex app-server with no
    // ChatGPT account behind them. The chat route decides that one, from the
    // row the owner picked.
    const models = applyPolicy({
      auth: {
        profiles: {
          "openai:chatgpt": { provider: "openai", mode: "oauth" },
          "openai:default": { provider: "openai", mode: "api_key" },
        },
      },
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    }, true);
    expect(models["openai/gpt-5.5"]).toBeUndefined();
  });

  it("leaves an openai/<id> alone on a box with no ChatGPT sign-in at all", () => {
    const models = applyPolicy({
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    }, true);
    expect(models["openai/gpt-5.5"]).toBeUndefined();
  });

  it("does not widen the seed on OpenClaw 1, where openai/<id> is a keyed route", () => {
    const models = applyPolicy(structuredClone(CHATGPT_ONLY), false);
    expect(models["openai/gpt-5.5"]).toBeUndefined();
  });
});

// The `openai-codex/` -> `codex/` boot migration writes a namespace OpenClaw 2
// refuses. Its sibling — the `openai/<gpt>` -> `codex/<gpt>` rewrite — is
// v1-gated for exactly that reason; this one was not, so a v2 box ran a
// `config set` the core rejected on every boot and printed a WARN pointing at
// a retired namespace.
describe("the openai-codex primary migration", () => {
  it("runs only on OpenClaw 1", () => {
    const start = SCRIPT_SOURCE.indexOf(
      "# One-time config migration for devices updating from OpenClaw <=2026.5.x:",
    );
    expect(start).toBeGreaterThan(-1);
    const block = SCRIPT_SOURCE.slice(start, SCRIPT_SOURCE.indexOf("LEGACY_CODEX_PRIMARY=", start));
    expect(block).toContain('if [ "$CLAWBOX_OPENCLAW_V2" != "1" ]; then');
  });
});

// The arm had exactly one remover on the whole box and it was v1-gated, so on
// the core ClawBox pins nothing ever cleared it. The recovery that matters is
// the box whose ChatGPT sign-in is gone while the arm stayed: there is no
// account for it to route to, and every turn on that model dies on the
// Cloudflare-challenged browser endpoint.
describe.runIf(hasPython3)("the boot disarm on OpenClaw 2", () => {
  const ARMED = {
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.5" },
        models: { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } },
      },
    },
  };

  it("strips a codex arm on a box with no ChatGPT sign-in at all", () => {
    const models = applyPolicy({
      ...structuredClone(ARMED),
      auth: { profiles: { "openai:default": { provider: "openai", mode: "api_key" } } },
    }, true);
    expect(models["openai/gpt-5.5"]?.agentRuntime).toBeUndefined();
  });

  it("leaves it while a sign-in exists — the routes own that one", () => {
    // Ambiguous at boot on a dual-credential box, and the chat and configure
    // routes now write AND clear it from the row the owner picked.
    const models = applyPolicy({
      ...structuredClone(ARMED),
      auth: {
        profiles: {
          "openai:chatgpt": { provider: "openai", mode: "oauth" },
          "openai:default": { provider: "openai", mode: "api_key" },
        },
      },
    }, true);
    expect(models["openai/gpt-5.5"]?.agentRuntime).toEqual({ id: "codex" });
  });

  it("re-seeds rather than strips on a subscription-only box", () => {
    const models = applyPolicy({
      ...structuredClone(ARMED),
      auth: { profiles: { "openai:chatgpt": { provider: "openai", mode: "oauth" } } },
    }, true);
    expect(models["openai/gpt-5.5"]?.agentRuntime).toEqual({ id: "codex" });
  });
});
