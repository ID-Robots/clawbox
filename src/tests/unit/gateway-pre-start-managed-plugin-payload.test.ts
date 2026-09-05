import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// TASK-602. Plugin payloads live under `~/.openclaw/npm/projects/openclaw-<id>-
// <hash>__openclaw-generation__g-<generation>`, keyed to the core that
// installed them, so a core bump strands the packages built for the old
// generation and the gateway refuses readiness over a payload that is not
// there. `plugins enable` — the consent verb this loop has always run — cannot
// answer that: it says "Plugin not found" and exits non-zero, and the loop
// warned and let the gateway try again with nothing changed.
//
// This is the BOOT path, and it is the one that matters here: a box that is
// already down gets a reboot from its owner long before it gets an update, and
// `src/lib/updater.ts` only repairs the same state during an update. The Codex
// block a few lines above already reinstalls its own payload pinned to the
// core; the channel plugins the Settings panel installs did not.
//
// The real block is run out of the shipped script against a fake `openclaw`
// that records its argv, so what is pinned is the code that boots the gateway
// and not a copy of it.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

/** The managed-plugin consent loop, verbatim, from its guard to its closing `fi`. */
function extractBlock(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const marker = src.indexOf('  MANAGED_ENABLED_PLUGINS="$(python3 - "$OPENCLAW_CONFIG"');
  if (marker < 0) throw new Error("managed plugin block not found in gateway-pre-start.sh");
  const start = src.lastIndexOf('if [ "$CLAWBOX_OPENCLAW_V2" = "1" ]; then', marker);
  const end = src.indexOf("\n  done\nfi\n", marker);
  if (start < 0 || end < 0) throw new Error("managed plugin block boundaries not found");
  return src.slice(start, end + "\n  done\nfi\n".length);
}

const BLOCK = hasBash && hasPython3 ? extractBlock() : "";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "pre-start-managed-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface RunOptions {
  /** `plugins.entries` as openclaw.json carries it. */
  entries: Record<string, { enabled: boolean }>;
  /** Plugin ids whose `plugins enable` the fake CLI refuses. */
  enableFails?: string[];
  /** Install specs (argv[3]) the fake CLI refuses. */
  installFails?: string[];
  /** The core target as the script resolved it; "" = unknown. */
  target?: string;
}

function run(opts: RunOptions): { argv: string[]; stdout: string } {
  const config = path.join(dir, "openclaw.json");
  writeFileSync(config, JSON.stringify({ plugins: { entries: opts.entries } }));

  const log = path.join(dir, "argv.log");
  const bin = path.join(dir, "openclaw");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      `echo "$*" >> "${log}"`,
      'if [ "$2" = "enable" ]; then',
      `  for r in ${(opts.enableFails ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '    if [ "$3" = "$r" ]; then exit 1; fi',
      "  done",
      "fi",
      'if [ "$2" = "install" ]; then',
      `  for r in ${(opts.installFails ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '    if [ "$3" = "$r" ]; then exit 1; fi',
      "  done",
      "fi",
      "exit 0",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);

  const result = spawnSync("bash", ["-c", BLOCK], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAWBOX_OPENCLAW_V2: "1",
      OPENCLAW_CONFIG: config,
      OPENCLAW_BIN: bin,
      OPENCLAW_TARGET: opts.target ?? "2026.8.1",
    }),
  });
  if (result.status !== 0) throw new Error(`block exited ${result.status}: ${result.stderr}`);

  let argv: string[] = [];
  try {
    argv = readFileSync(log, "utf-8").trim().split("\n").filter(Boolean);
  } catch {
    /* the CLI was never run */
  }
  return { argv, stdout: result.stdout };
}

describe.skipIf(!hasBash || !hasPython3)("gateway-pre-start.sh managed plugin payload repair", () => {
  it("consents and stops there while the payload is intact", () => {
    const { argv } = run({ entries: { discord: { enabled: true } } });
    expect(argv).toEqual(["plugins enable discord --accept-capabilities"]);
  });

  it("reinstalls the pinned payload when the consent verb cannot find the plugin", () => {
    const { argv, stdout } = run({
      entries: { discord: { enabled: true } },
      enableFails: ["discord"],
    });
    expect(argv).toEqual([
      "plugins enable discord --accept-capabilities",
      "plugins install @openclaw/discord@2026.8.1 --force --accept-capabilities",
    ]);
    expect(stdout).toContain("discord plugin payload reinstalled");
  });

  it("repairs the payload under the alias the registry answers to", () => {
    // `ensureChannelPlugin` can enable the plugin as `openclaw-whatsapp`, and
    // the npm package is `@openclaw/whatsapp` either way.
    const { argv } = run({
      entries: { "openclaw-whatsapp": { enabled: true } },
      enableFails: ["openclaw-whatsapp"],
    });
    expect(argv).toEqual([
      "plugins enable openclaw-whatsapp --accept-capabilities",
      "plugins install @openclaw/whatsapp@2026.8.1 --force --accept-capabilities",
    ]);
  });

  it("warns and keeps booting when the reinstall fails too", () => {
    const { stdout } = run({
      entries: { discord: { enabled: true } },
      enableFails: ["discord"],
      installFails: ["@openclaw/discord@2026.8.1"],
    });
    expect(stdout).toContain("WARN: could not confirm discord plugin capabilities");
  });

  it("leaves a managed plugin with no npm package of ours to its own installer", () => {
    // deepseek comes from ClawHub and clawbox-email-directives is copied out of
    // the checkout; both have their own block in this script, and an
    // `@openclaw/<id>` guess would fetch a package that is not the plugin.
    const { argv } = run({
      entries: { deepseek: { enabled: true } },
      enableFails: ["deepseek"],
    });
    expect(argv).toEqual(["plugins enable deepseek --accept-capabilities"]);
  });

  it("does not guess a spec when the core target is unknown", () => {
    // An unpinned `@openclaw/discord` resolves @latest, which is how the codex
    // plugin drifted ahead of the pinned core and crashed every chat.
    const { argv } = run({
      entries: { discord: { enabled: true } },
      enableFails: ["discord"],
      target: "",
    });
    expect(argv).toEqual(["plugins enable discord --accept-capabilities"]);
  });
});
