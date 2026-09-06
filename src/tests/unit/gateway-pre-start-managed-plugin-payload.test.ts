import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { testEnv } from "@/tests/helpers/env";
import { repairHelpers } from "@/tests/helpers/gateway-pre-start";
import { OFFICIAL_CHANNEL_PLUGINS } from "@/lib/openclaw-channels";

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

// A refusal this loop cannot repair now ends in `clawbox_plugin_boot_without`
// rather than a warning, so the block no longer runs without those helpers.
const BLOCK = hasBash && hasPython3 ? `${repairHelpers()}\n${extractBlock()}` : "";

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
  /** Plugin ids whose `plugins enable` answers the core's "Plugin not found". */
  payloadMissing?: string[];
  /** Plugin ids whose `plugins enable` fails for some OTHER reason. */
  enableFails?: string[];
  /** Install specs (argv[3]) the fake CLI refuses. */
  installFails?: string[];
  /** The INSTALLED core's release as the script resolved it; "" = unknown. */
  effective?: string;
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
      // The core's own sentence for a package that is not on disk, verbatim.
      `  for r in ${(opts.payloadMissing ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '    if [ "$3" = "$r" ]; then echo "Plugin not found: $3. Run \`openclaw plugins list\` to see installed plugins." >&2; exit 1; fi',
      "  done",
      `  for r in ${(opts.enableFails ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '    if [ "$3" = "$r" ]; then echo "timeout" >&2; exit 124; fi',
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

  // Under the shipped script's own options, so an `&&` list or a failing
  // pipeline in the extracted block fails here the way it would on a box.
  const result = spawnSync("bash", ["-c", "set -euo pipefail\n" + BLOCK], {
    encoding: "utf-8",
    env: testEnv({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      CLAWBOX_OPENCLAW_V2: "1",
      OPENCLAW_CONFIG: config,
      OPENCLAW_BIN: bin,
      // This case's own root, so the repair marker the helpers write does not
      // leak between cases through the run-wide one.
      CLAWBOX_ROOT: dir,
      CLAWBOX_OPENCLAW_EFFECTIVE: opts.effective ?? "2026.8.1",
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

  it("reinstalls the pinned payload when the core says the package is not there", () => {
    const { argv, stdout } = run({
      entries: { discord: { enabled: true } },
      payloadMissing: ["discord"],
    });
    expect(argv).toEqual([
      "plugins enable discord --accept-capabilities",
      "plugins install @openclaw/discord@2026.8.1 --force --accept-capabilities",
    ]);
    expect(stdout).toContain("discord plugin payload reinstalled");
  });

  it("does NOT reinstall when the consent verb failed for any other reason", () => {
    // A cold-Jetson `plugins enable` that overran its 60 s budget, a config
    // lock, a registry hiccup: none of them is a missing payload, and a 120 s
    // npm install on a BLOCKING ExecStartPre is not their repair.
    const { argv, stdout } = run({
      entries: { discord: { enabled: true }, whatsapp: { enabled: true } },
      enableFails: ["discord", "whatsapp"],
    });
    expect(argv.filter((line) => line.startsWith("plugins"))).toEqual([
      "plugins enable discord --accept-capabilities",
      "plugins enable whatsapp --accept-capabilities",
    ]);
    expect(argv.some((line) => line.startsWith("plugins install"))).toBe(false);
    expect(stdout).toContain("WARN: could not confirm discord plugin capabilities");
    // …and the plugin is switched off so the gateway can start without it
    // (TASK-606): the refusal is real, it is just not one an install repairs.
    expect(argv).toContain('config set plugins.entries["discord"].enabled false --strict-json');
    expect(stdout).toContain("booting without it");
  });

  it("repairs the payload under the alias the registry answers to", () => {
    // `ensureChannelPlugin` can enable the plugin as `openclaw-whatsapp`, and
    // the npm package is `@openclaw/whatsapp` either way.
    const { argv } = run({
      entries: { "openclaw-whatsapp": { enabled: true } },
      payloadMissing: ["openclaw-whatsapp"],
    });
    expect(argv).toEqual([
      "plugins enable openclaw-whatsapp --accept-capabilities",
      "plugins install @openclaw/whatsapp@2026.8.1 --force --accept-capabilities",
    ]);
  });

  it("says the reinstall failed, not that capabilities are unconfirmed", () => {
    // The boot log is the primary evidence for this failure mode; "could not
    // confirm capabilities" would send whoever reads it after the wrong thing.
    const { stdout } = run({
      entries: { discord: { enabled: true } },
      payloadMissing: ["discord"],
      installFails: ["@openclaw/discord@2026.8.1"],
    });
    expect(stdout).toContain("could not reinstall the discord plugin payload");
  });

  it("leaves a managed plugin with no npm package of ours to its own installer", () => {
    // deepseek comes from ClawHub and clawbox-email-directives is copied out of
    // the checkout; both have their own block in this script, and an
    // `@openclaw/<id>` guess would fetch a package that is not the plugin.
    const { argv, stdout } = run({
      entries: { deepseek: { enabled: true } },
      payloadMissing: ["deepseek"],
    });
    expect(argv).toEqual(["plugins enable deepseek --accept-capabilities"]);
    expect(stdout).toContain("ClawBox has no npm package of its own for it");
  });

  it("repairs exactly the channel plugins the Settings panel installs", () => {
    // The shell `case` and OFFICIAL_CHANNEL_PLUGINS are one list in two
    // languages: a channel added to the panel and forgotten here is a box that
    // loses that channel — and its gateway — on the next core bump, with no
    // reboot that heals it.
    const src = readFileSync(SCRIPT, "utf-8");
    const shellCase = /\n\s+([a-z|-]+)\)\s+MANAGED_PLUGIN_PKG="@openclaw\/\$MANAGED_PLUGIN_KEY"/.exec(src);
    expect(shellCase, "the payload-repair case arm was not found").not.toBeNull();
    expect(shellCase?.[1].split("|").sort())
      .toEqual(Object.keys(OFFICIAL_CHANNEL_PLUGINS).sort());
    for (const [id, npmPackage] of Object.entries(OFFICIAL_CHANNEL_PLUGINS)) {
      // The shell builds the spec as `@openclaw/<id>`, so a package that is not
      // named after its plugin id would be silently mis-installed.
      expect(npmPackage).toBe(`@openclaw/${id}`);
    }
  });

  it("falls back to the unpinned spec only when the installed core is unknown", () => {
    // Pinned to the INSTALLED core, not to the checkout's pin file: this script
    // never installs the core, so a box that pulled new ClawBox code before its
    // core update landed would otherwise install a plugin its runtime refuses.
    const { argv } = run({
      entries: { discord: { enabled: true } },
      payloadMissing: ["discord"],
      effective: "",
    });
    expect(argv).toEqual([
      "plugins enable discord --accept-capabilities",
      "plugins install @openclaw/discord --force --accept-capabilities",
    ]);
  });
});
