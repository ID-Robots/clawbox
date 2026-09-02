import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

// gateway-pre-start.sh installs @openclaw/deepseek-provider on a paired box
// that lacks it, PINNED to the installed core. The day OpenClaw 2026.8.2
// shipped, the unpinned spec resolved to a build declaring `pluginApi
// >=2026.8.2`; the pinned 2026.8.1 runtime refused it ("requires plugin API
// >=2026.8.2, but this OpenClaw runtime exposes 2026.8.1") and every fresh
// install parked at a gateway that never reported ready (E2E Install caught
// it). The real block is run out of the shipped script against a fake
// `openclaw` that records its argv, so the ordering is pinned by the code
// that boots the gateway and not by a copy of it.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** The deepseek plugin block, verbatim, from its guard to the workspace resolver that follows it. */
function extractBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const start = src.indexOf('if [ "$CLAWBOX_OPENCLAW_V2" = "1" ] && [ ! -f "$OPENCLAW_HOME_DIR/extensions/deepseek/openclaw.plugin.json" ]; then');
  const end = src.indexOf("# Resolve the workspace from agents.defaults.workspace", start);
  if (start < 0 || end < 0) throw new Error("deepseek plugin block not found in gateway-pre-start.sh");
  return src.slice(start, end);
}

const BLOCK = hasBash && hasPython3 ? extractBlock() : "";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pre-start-deepseek-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RunOptions {
  /** The installed core's release as the script resolved it; "" = could not be asked. */
  effective: string;
  /** Specs (argv[3] of `plugins install`) the fake CLI refuses. */
  refuse?: string[];
  /** Whether openclaw.json carries a deepseek provider with a key. */
  configured?: boolean;
  /** Whether the plugin is already on disk. */
  present?: boolean;
}

function run(opts: RunOptions): { installs: string[]; stdout: string } {
  const home = path.join(dir, "openclaw-home");
  mkdirSync(home, { recursive: true });
  if (opts.present) {
    mkdirSync(path.join(home, "extensions", "deepseek"), { recursive: true });
    writeFileSync(path.join(home, "extensions", "deepseek", "openclaw.plugin.json"), "{}");
  }
  const config = path.join(dir, "openclaw.json");
  writeFileSync(
    config,
    JSON.stringify(
      opts.configured === false
        ? { models: { providers: {} } }
        : { models: { providers: { deepseek: { apiKey: "sk-test", baseUrl: "https://clawbox.com/api/ai" } } } },
    ),
  );
  const log = path.join(dir, "installs.log");
  const bin = path.join(dir, "openclaw");
  // Records every `plugins install <spec>` and refuses the specs it is told
  // to — a ClawHub build the runtime rejects exits non-zero the same way.
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `echo "$3" >> "${log}"`,
      `for r in ${(opts.refuse ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '  if [ "$3" = "$r" ]; then echo "refused $3" >&2; exit 1; fi',
      "done",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  const result = spawnSync("bash", ["-c", BLOCK], {
    encoding: "utf-8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAWBOX_OPENCLAW_V2: "1",
      OPENCLAW_HOME_DIR: home,
      OPENCLAW_CONFIG: config,
      OPENCLAW_BIN: bin,
      CLAWBOX_OPENCLAW_EFFECTIVE: opts.effective,
    },
  });
  if (result.status !== 0) throw new Error(`block exited ${result.status}: ${result.stderr}`);
  let installs: string[] = [];
  try {
    installs = readFileSync(log, "utf-8").trim().split("\n").filter(Boolean);
  } catch {
    /* nothing was installed */
  }
  return { installs, stdout: result.stdout };
}

describe.skipIf(!hasBash || !hasPython3)("gateway-pre-start.sh deepseek plugin install", () => {
  it("installs the build matching the installed core and stops there", () => {
    const { installs, stdout } = run({ effective: "2026.8.1" });
    expect(installs).toEqual(["clawhub:@openclaw/deepseek-provider@2026.8.1"]);
    expect(stdout).toContain("installed (clawhub:@openclaw/deepseek-provider@2026.8.1)");
  });

  it("falls back to the unpinned spec only when the pinned build is refused", () => {
    const { installs, stdout } = run({
      effective: "2026.9.1",
      refuse: ["clawhub:@openclaw/deepseek-provider@2026.9.1"],
    });
    expect(installs).toEqual([
      "clawhub:@openclaw/deepseek-provider@2026.9.1",
      "clawhub:@openclaw/deepseek-provider",
    ]);
    expect(stdout).toContain("installed (clawhub:@openclaw/deepseek-provider)");
  });

  it("warns, and keeps booting, when neither spec installs", () => {
    const { installs, stdout } = run({
      effective: "2026.8.1",
      refuse: ["clawhub:@openclaw/deepseek-provider@2026.8.1", "clawhub:@openclaw/deepseek-provider"],
    });
    expect(installs).toHaveLength(2);
    expect(stdout).toContain("WARN: could not install @openclaw/deepseek-provider");
  });

  it("goes straight to the unpinned spec when the core's release is unknown", () => {
    const { installs } = run({ effective: "" });
    expect(installs).toEqual(["clawhub:@openclaw/deepseek-provider"]);
  });

  it("installs nothing when the plugin is already on disk", () => {
    expect(run({ effective: "2026.8.1", present: true }).installs).toEqual([]);
  });

  it("installs nothing on a box with no deepseek provider configured", () => {
    expect(run({ effective: "2026.8.1", configured: false }).installs).toEqual([]);
  });
});
