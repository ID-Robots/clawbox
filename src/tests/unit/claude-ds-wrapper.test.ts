import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CODING_HARNESS_COMMAND, CODING_HARNESS_WRAPPER_PATH } from "@/lib/coding-harness";

/**
 * These run the SHIPPED wrapper — scripts/claude-ds, the same bytes install.sh
 * copies to ~/.local/bin — with a fake `claude` on PATH that records the
 * environment it was handed. Asserting against a re-implementation would have
 * missed every bug that matters here, because all of them are about which
 * variables reach the CLI.
 *
 * What must never regress:
 *
 *  - The wrapper must not leak ANTHROPIC_BASE_URL into anything but its own
 *    child. OpenClaw drives `claude-cli` through the SAME binary, so a global
 *    export reroutes every OpenClaw Claude call to DeepSeek silently.
 *  - The model must follow the plan. ClawBox AI answers 403 for
 *    deepseek-v4-pro below the Max plan, so a hard-wired pro default would
 *    ship a harness that is broken for most owners.
 *  - An inherited Anthropic credential must lose. ANTHROPIC_API_KEY outranks
 *    ANTHROPIC_AUTH_TOKEN, so a stale key in the environment would send the
 *    run to Anthropic under a DeepSeek model name.
 *  - A box with no ClawBox AI login must say so in words its owner can act on,
 *    and must not start Claude Code at all.
 */

const REPO = process.cwd();
const WRAPPER = path.join(REPO, "scripts", "claude-ds");

let home: string;
let root: string;
let binDir: string;
let envDump: string;
let claudeLog: string;

/** Write the device config the wrapper reads. */
function writeDeviceConfig(config: Record<string, unknown>): void {
  mkdirSync(path.join(root, "data"), { recursive: true });
  writeFileSync(path.join(root, "data", "config.json"), JSON.stringify(config), "utf-8");
}

/** A stand-in for Claude Code that records its environment and its argv. */
function installFakeClaude(): void {
  const fake = path.join(binDir, "claude");
  writeFileSync(
    fake,
    [
      "#!/usr/bin/env bash",
      `env > "${envDump}"`,
      `printf '%s\\n' "$@" > "${claudeLog}"`,
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function runWrapper(
  extraEnv: Record<string, string | undefined> = {},
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [WRAPPER, ...args], {
    encoding: "utf-8",
    env: {
      // A MINIMAL path on purpose. Inheriting the host's PATH made the
      // "Claude Code is not installed" case find the developer's own `claude`
      // and pass for the wrong reason.
      PATH: `${binDir}:/usr/bin:/bin`,
      HOME: home,
      CLAWBOX_ROOT: root,
      ...extraEnv,
      // A deliberately minimal environment; NODE_ENV is not part of it.
    } as unknown as NodeJS.ProcessEnv,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** The environment the fake `claude` was launched with. */
function capturedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(envDump, "utf-8").split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

beforeEach(() => {
  const base = mkdtempSync(path.join(tmpdir(), "claude-ds-"));
  home = path.join(base, "home");
  root = path.join(base, "clawbox");
  binDir = path.join(base, "bin");
  envDump = path.join(base, "env.txt");
  claudeLog = path.join(base, "argv.txt");
  mkdirSync(home, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  installFakeClaude();
  writeDeviceConfig({ clawai_token: "claw_test_token", clawai_tier: "flash" });
});

afterEach(() => {
  rmSync(path.dirname(home), { recursive: true, force: true });
});

describe("the shipped wrapper", () => {
  it("is executable in the repository, so the copy install.sh makes is runnable", () => {
    // install.sh uses `install -m 755`, but a wrapper committed non-executable
    // would still break `bash scripts/claude-ds` for anyone running it in place.
    expect(existsSync(WRAPPER)).toBe(true);
    expect(statSync(WRAPPER).mode & 0o111).not.toBe(0);
  });

  it("is valid bash", () => {
    expect(() => execFileSync("bash", ["-n", WRAPPER])).not.toThrow();
  });

  it("names the same command the desktop icon types", () => {
    expect(path.basename(WRAPPER)).toBe(CODING_HARNESS_COMMAND);
    expect(CODING_HARNESS_WRAPPER_PATH.endsWith(`/${CODING_HARNESS_COMMAND}`)).toBe(true);
  });
});

describe("routing to ClawBox AI", () => {
  it("points Claude Code at the Anthropic surface of the proxy, not at DeepSeek", () => {
    // Reaching api.deepseek.com directly cannot work: the box holds a portal
    // token, and the DeepSeek keys live only on the proxy.
    expect(runWrapper().status).toBe(0);
    expect(capturedEnv().ANTHROPIC_BASE_URL).toBe("https://clawbox.com/api/ai/anthropic");
  });

  it("honours CLAWBOX_AI_PROXY_URL — the same variable the device's provider config uses", () => {
    runWrapper({ CLAWBOX_AI_PROXY_URL: "https://staging.example/api/ai" });
    expect(capturedEnv().ANTHROPIC_BASE_URL).toBe("https://staging.example/api/ai/anthropic");
  });

  it("does not produce a double slash when the proxy URL has a trailing one", () => {
    runWrapper({ CLAWBOX_AI_PROXY_URL: "https://staging.example/api/ai/" });
    expect(capturedEnv().ANTHROPIC_BASE_URL).toBe("https://staging.example/api/ai/anthropic");
  });

  it("sends the device's own portal token", () => {
    runWrapper();
    expect(capturedEnv().ANTHROPIC_AUTH_TOKEN).toBe("claw_test_token");
  });

  it("passes its arguments through to Claude Code untouched", () => {
    runWrapper({}, ["-p", "explain this repo"]);
    expect(readFileSync(claudeLog, "utf-8")).toBe("-p\nexplain this repo\n");
  });
});

describe("which model the owner actually gets", () => {
  it("gives a Max box the pro model", () => {
    // "pro" is the DEVICE tier name for the Max plan — the only tier ClawBox AI
    // lets reach deepseek-v4-pro.
    writeDeviceConfig({ clawai_token: "claw_test_token", clawai_tier: "pro" });
    runWrapper();
    expect(capturedEnv().ANTHROPIC_MODEL).toBe("deepseek-v4-pro[1m]");
  });

  it("gives every other plan flash, because the proxy 403s pro below Max", () => {
    for (const tier of ["flash", "free", ""]) {
      writeDeviceConfig({ clawai_token: "claw_test_token", clawai_tier: tier });
      runWrapper();
      expect(capturedEnv().ANTHROPIC_MODEL, `tier=${tier || "<unset>"}`).toBe("deepseek-v4-flash");
    }
  });

  it("gives flash when the tier field is missing entirely", () => {
    writeDeviceConfig({ clawai_token: "claw_test_token" });
    runWrapper();
    expect(capturedEnv().ANTHROPIC_MODEL).toBe("deepseek-v4-flash");
  });

  it("keeps the cheap model in the haiku and subagent slots on every plan", () => {
    writeDeviceConfig({ clawai_token: "claw_test_token", clawai_tier: "pro" });
    runWrapper();
    const env = capturedEnv();
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("deepseek-v4-flash");
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe("deepseek-v4-flash");
  });

  it("lets an override win over the plan", () => {
    runWrapper({ CLAUDE_DS_MODEL: "deepseek-v4-pro" });
    const env = capturedEnv();
    expect(env.ANTHROPIC_MODEL).toBe("deepseek-v4-pro");
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("deepseek-v4-pro");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("deepseek-v4-pro");
  });

  it("says on screen which model is about to answer", () => {
    writeDeviceConfig({ clawai_token: "claw_test_token", clawai_tier: "pro" });
    expect(runWrapper().stderr).toContain("deepseek-v4-pro[1m]");
  });
});

describe("isolation from the rest of the box", () => {
  it("keeps its own Claude Code state directory, never the shared ~/.claude", () => {
    runWrapper();
    const dir = capturedEnv().CLAUDE_CONFIG_DIR;
    expect(dir).toBe(path.join(home, ".claude-ds"));
    expect(dir).not.toBe(path.join(home, ".claude"));
    expect(existsSync(dir)).toBe(true);
  });

  it("clears an inherited Anthropic credential, which would otherwise outrank the portal token", () => {
    runWrapper({
      ANTHROPIC_API_KEY: "sk-ant-inherited",
      ANTHROPIC_OAUTH_TOKEN: "oat-inherited",
    });
    const env = capturedEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_OAUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("claw_test_token");
  });

  it("writes no shell rc file — a global ANTHROPIC_BASE_URL would reroute OpenClaw itself", () => {
    const bashrc = path.join(home, ".bashrc");
    writeFileSync(bashrc, "# original\n", "utf-8");
    runWrapper();
    expect(readFileSync(bashrc, "utf-8")).toBe("# original\n");
    // And the script contains no rc-appending at all.
    const source = readFileSync(WRAPPER, "utf-8");
    expect(source).not.toMatch(/>>\s*.*\.(bashrc|profile|zshrc)/);
  });
});

describe("failing in a way the owner can act on", () => {
  it("refuses, and never starts Claude Code, when ClawBox AI is not connected", () => {
    writeDeviceConfig({ hostname: "clawbox" });
    const run = runWrapper();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Settings");
    expect(existsSync(envDump)).toBe(false);
  });

  it("distinguishes a corrupt config from a missing login", () => {
    // Both used to be "something went wrong"; they need different answers.
    mkdirSync(path.join(root, "data"), { recursive: true });
    writeFileSync(path.join(root, "data", "config.json"), "{not json", "utf-8");
    const run = runWrapper();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("not readable JSON");
    expect(run.stderr).not.toContain("Settings");
  });

  it("names the repair command when Claude Code is not installed", () => {
    rmSync(path.join(binDir, "claude"));
    const run = runWrapper();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("--step coding_harness");
  });

  it("never prints the token", () => {
    const run = runWrapper();
    expect(run.stdout).not.toContain("claw_test_token");
    expect(run.stderr).not.toContain("claw_test_token");
  });
});
