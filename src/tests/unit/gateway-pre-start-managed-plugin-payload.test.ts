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
  /**
   * Plugin ids whose `plugins enable` is KILLED at the deadline, by exit code.
   *
   * 124 is `timeout` firing at the ceiling; 137 is the SIGKILL `-k 5` sends
   * five seconds later. Neither says anything about whether the consent was
   * written: `plugins enable` writes `plugins.entries.<id>.enabled` and THEN
   * spends seconds loading the gateway SDK.
   */
  enableKilled?: Record<string, number>;
  /**
   * `plugins inspect --all --json` stdout; omitted = the CLI cannot answer.
   *
   * The consent answer is the `diagnostics` array, not `status`/`activated` —
   * those two are the config's own `enabled` bit under another name and are
   * true before the consent verb has run.
   */
  inspectJson?: string;
  /** Install specs (argv[3]) the fake CLI refuses. */
  installFails?: string[];
  /** The INSTALLED core's release as the script resolved it; "" = unknown. */
  effective?: string;
}

function run(opts: RunOptions): {
  argv: string[];
  stdout: string;
  stderr: string;
  marker: Record<string, { disabled?: boolean; stage?: string }>;
} {
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
      // A refusal the core CHOSE to make: it ran, it answered, it said no.
      `  for r in ${(opts.enableFails ?? []).map((s) => `'${s}'`).join(" ")}; do`,
      '    if [ "$3" = "$r" ]; then echo "refused" >&2; exit 1; fi',
      "  done",
      // Killed. The process never got to say anything.
      ...Object.entries(opts.enableKilled ?? {}).map(
        ([id, code]) => `  if [ "$3" = '${id}' ]; then exit ${code}; fi`,
      ),
      "fi",
      'if [ "$2" = "inspect" ]; then',
      ...(opts.inspectJson === undefined
        ? ["  exit 1"]
        : [`  printf '%s' '${opts.inspectJson}'; exit 0`]),
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
  let marker: Record<string, { disabled?: boolean; stage?: string }> = {};
  try {
    marker = JSON.parse(readFileSync(path.join(dir, "data", "plugin-repair.json"), "utf-8"));
  } catch {
    /* no marker was written */
  }
  return { argv, stdout: result.stdout, stderr: result.stderr, marker };
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
    // A config lock, a registry hiccup, a surface the core would not accept:
    // none of them is a missing payload, and a 120 s npm install on a BLOCKING
    // ExecStartPre is not their repair. A verb KILLED at its deadline is not in
    // this family at all and has its own cases below — it is the one failure
    // that says nothing about whether the consent was recorded.
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

  // ── A consent verb KILLED at its deadline (TASK-606 follow-up) ───────────
  //
  // `timeout -k 5 60 openclaw plugins enable <id> --accept-capabilities` has one
  // failure that says NOTHING about whether the consent landed: the kill at the
  // deadline. The verb writes `plugins.entries.<id>.enabled` and THEN spends
  // seconds loading the gateway SDK, so on a cold Jetson the consent is recorded
  // and the process is still killed. The loop read every non-zero exit as a
  // refusal and switched the entry OFF for it — so a box booted without a
  // correctly consented Discord, and it did NOT heal, because the loop only
  // visits entries that are already `enabled: true`.
  //
  // The entry is already `true` before the call, so re-reading `enabled` cannot
  // separate a landed consent from a lost one — and neither can `status` /
  // `activated`, which are that same bit under another name. The core's consent
  // DIAGNOSTIC is the only field that carries the answer.
  const CONSENT_DIAGNOSTIC = (id: string) =>
    `Plugin \"${id}\" requires capability consent; disable and re-enable it or run ...`;

  it.each([124, 137])("switches nothing off when a killed verb had recorded the consent (exit %i)", (code) => {
    // No diagnostic names discord, so the core has its consent.
    const { argv, stdout, marker } = run({
      entries: { discord: { enabled: true } },
      enableKilled: { discord: code },
      inspectJson: '{"diagnostics":[]}',
    });
    expect(argv).toContain("plugins inspect --all --json");
    expect(stdout).toContain("discord plugin capabilities accepted/current");
    expect(argv.some((line) => line.includes("enabled false"))).toBe(false);
    expect(marker).toEqual({});
  });

  it("still switches off when a killed verb had NOT recorded the consent", () => {
    // The core names discord, so readiness really would be refused over it and
    // the gateway would burn its start limit. Unchanged behaviour.
    const { argv, stdout, marker } = run({
      entries: { discord: { enabled: true } },
      enableKilled: { discord: 124 },
      inspectJson: `{"diagnostics":[{"level":"warn","pluginId":"discord","message":"${CONSENT_DIAGNOSTIC("discord")}"}]}`,
    });
    expect(argv).toContain('config set plugins.entries["discord"].enabled false --strict-json');
    expect(stdout).toContain("booting without it");
    expect(marker.discord?.stage).toBe("consent");
  });

  it("keeps the existing behaviour when the core cannot be asked at all", () => {
    // NEVER leaves an unresolved plugin enabled: a gateway that refuses
    // readiness burns StartLimitBurst=20 inside an hour and the unit is then
    // FAILED, not retried, and nothing running as clawbox clears a start limit.
    const { argv, stdout, marker } = run({
      entries: { discord: { enabled: true } },
      enableKilled: { discord: 137 },
    });
    expect(argv).toContain('config set plugins.entries["discord"].enabled false --strict-json');
    expect(stdout).toContain("booting without it");
    expect(marker.discord?.stage).toBe("consent");
  });

  it("reads the diagnostic PER ID, not as one verdict for the boot", () => {
    // The discriminating case: both verbs were killed and both plugins are
    // enabled, and the core names only one of them. Without this, "the core
    // said no" and "the core could not be asked" are indistinguishable, because
    // both end in a switch-off.
    const { argv, stdout } = run({
      entries: { discord: { enabled: true }, whatsapp: { enabled: true } },
      enableKilled: { discord: 124, whatsapp: 124 },
      inspectJson:
        '{"diagnostics":[{"level":"warn","pluginId":"whatsapp",'
        + '"message":"Plugin whatsapp requires capability consent; run openclaw plugins enable"}]}',
    });
    // whatsapp is named, so it is still unconsented and must go off.
    expect(argv).toContain('config set plugins.entries["whatsapp"].enabled false --strict-json');
    // discord is NOT named, so its consent landed inside the killed verb.
    expect(argv.some((line) => line.includes('entries["discord"].enabled false'))).toBe(false);
    expect(stdout).toContain("discord plugin capabilities accepted/current");
  });

  it("asks the core once per boot, not once per plugin", () => {
    // The CLI start is the dominant cost and this is a blocking ExecStartPre.
    const { argv } = run({
      entries: { discord: { enabled: true }, whatsapp: { enabled: true } },
      enableKilled: { discord: 124, whatsapp: 124 },
      inspectJson: '{"diagnostics":[]}',
    });
    expect(argv.filter((line) => line.startsWith("plugins inspect"))).toEqual([
      "plugins inspect --all --json",
    ]);
  });

  it("still switches the plugin off when the core actually refused", () => {
    // A refusal the core CHOSE to make never pays for the second question.
    const { argv, stdout, marker } = run({
      entries: { discord: { enabled: true } },
      enableFails: ["discord"],
    });
    expect(argv).toContain('config set plugins.entries["discord"].enabled false --strict-json');
    expect(stdout).toContain("booting without it");
    expect(marker.discord?.stage).toBe("consent");
    expect(argv.some((line) => line.startsWith("plugins inspect"))).toBe(false);
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
