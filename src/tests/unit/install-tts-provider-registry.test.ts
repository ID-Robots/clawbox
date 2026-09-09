import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * step_openclaw_tts used to write `messages.tts.provider = tts-local-cli` and
 * stop there. That is not enough to make a box speak, and the way it fails is
 * silent.
 *
 * `tts-local-cli` is a bundled OpenClaw extension, but the gateway resolves
 * plugins through a PERSISTED registry instead of scanning dist/extensions,
 * and that registry goes stale whenever the extension set on disk changes
 * (`openclaw plugins registry` calls the reason `source-changed` — i.e. every
 * OpenClaw upgrade). A stale index does not contain the plugin, so the gateway
 * starts without it and every spoken reply fails with
 *
 *     TTS conversion failed: tts-local-cli: no provider registered
 *
 * while openclaw.json, this install step, and `capability tts status` all keep
 * insisting the box is configured. Found on the TASK-383 hardware proof
 * (2026-08-19, freshly flashed Orin): persisted 32/33 plugins against 49/67
 * current, gateway loading only memory-core and ollama, zero on-device speech
 * until the index was rebuilt.
 *
 * These tests EXECUTE the real step out of install.sh against a stub
 * `openclaw`, rather than grepping it, so they fail if the refresh or the
 * verification is dropped — and so they cannot pass against a rewrite that
 * merely keeps the words.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");

function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

let dir: string;
let projectDir: string;
let callsLog: string;

/**
 * A stub `openclaw` that logs every invocation and whose two interesting
 * subcommands are scripted per test:
 *   plugins registry --refresh  -> exit $REFRESH_EXIT
 *   plugins info tts-local-cli  -> exit $INFO_EXIT   (1 == "Plugin not found")
 */
function writeOpenclawStub(): string {
  const bin = path.join(dir, "openclaw");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$*" >> "${callsLog}"
case "$1 $2" in
  "plugins registry") exit \${REFRESH_EXIT:-0} ;;
  "plugins info")     exit \${INFO_EXIT:-0} ;;
esac
case "$1" in
  config)
    # \`config get messages.tts.provider\` decides whether the step takes its
    # "already configured — preserving" path. Empty by default.
    if [ "$2" = "get" ]; then
      [ "$3" = "messages.tts.provider" ] && printf '%s' "\${CURRENT_TTS_PROVIDER:-}"
      # The provider MAP, which tts_managed_cloud_provider parses to find the
      # entry carrying our own \`clawboxManaged\` stamp. Empty by default, so a
      # test that says nothing about it gets the on-device voice.
      [ "$3" = "messages.tts.providers" ] && printf '%s' "\${PROVIDERS_JSON:-}"
      exit 0
    fi
    # Lets a test make the SELECTION fail for one provider while every other
    # write still succeeds — the fallback path's only trigger.
    if [ "$2" = "set" ] && [ "$3" = "messages.tts.provider" ] \\
       && [ -n "\${SELECT_FAIL_FOR:-}" ] && [ "$4" = "\${SELECT_FAIL_FOR}" ]; then
      exit 1
    fi
    exit 0 ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  return bin;
}

/** Run the real step_openclaw_tts with install.sh's real oc_config_set. */
function runStep(env: Record<string, string> = {}) {
  const program = [
    "set -uo pipefail",
    `PROJECT_DIR="${projectDir}"`,
    'SRC_DIR="$PROJECT_DIR"',
    `OPENCLAW_BIN="${path.join(dir, "openclaw")}"`,
    "CLAWBOX_USER=clawbox",
    // Where install-voice.sh publishes its Kokoro verdict. This file's subject
    // is the plugin registry, so the path only has to exist as a variable —
    // but it does have to exist, because the step passes it down.
    `TTS_STATUS_FILE="${path.join(dir, "tts-status")}"`,
    // as_clawbox drops privileges on a device; here it just runs the command.
    "as_clawbox() { env \"$@\"; }",
    "is_hermes_edition() { return 1; }",
    // Recorded by the step when Kokoro was requested and did not install, so
    // the failure reaches the provisioning summary. A no-op here.
    "record_provision_failure() { :; }",
    extractShellFn(INSTALL_SH, "oc_config_set"),
    extractShellFn(INSTALL_SH, "tts_ensure_provider_registered"),
    extractShellFn(INSTALL_SH, "tts_write_local_provider_definition"),
    extractShellFn(INSTALL_SH, "tts_managed_cloud_provider"),
    extractShellFn(INSTALL_SH, "tts_config_readable"),
    extractShellFn(INSTALL_SH, "step_openclaw_tts"),
    "step_openclaw_tts",
  ].join("\n");

  return spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_OPENCLAW_HOME: `${dir}/openclaw-home`, ...env },
  });
}

const calls = () =>
  existsSync(callsLog) ? readFileSync(callsLog, "utf-8").trim().split("\n").filter(Boolean) : [];

describe.skipIf(!hasBash)("step_openclaw_tts registers the provider before selecting it", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tts-registry-"));
    projectDir = path.join(dir, "project");
    callsLog = path.join(dir, "calls.log");
    mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
    // The step refuses to configure TTS against a script that is not
    // executable, and asks that script for the provider timeout.
    writeFileSync(
      path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
      "#!/usr/bin/env bash\n[ \"${1:-}\" = \"--provider-timeout-ms\" ] && echo 100000\nexit 0\n",
      { mode: 0o755 },
    );
    // Piper install is exercised by its own tests; here it must not run.
    writeFileSync(path.join(projectDir, "scripts", "install-voice.sh"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
    writeOpenclawStub();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refreshes the plugin registry and selects the provider", () => {
    const res = runStep();
    expect(res.status).toBe(0);

    const log = calls();
    const refreshed = log.findIndex((c) => c.startsWith("plugins registry --refresh"));
    const selected = log.findIndex((c) => c === "config set messages.tts.provider tts-local-cli");

    expect(refreshed, "the registry is never rebuilt").toBeGreaterThanOrEqual(0);
    expect(selected, "the provider is never selected").toBeGreaterThanOrEqual(0);
    // Ordering is the point: refreshing after selection would leave the box
    // pointing at an unregistered provider until something restarted it.
    expect(refreshed).toBeLessThan(selected);
  });

  it("verifies the plugin actually registered, before selecting it", () => {
    const res = runStep();
    expect(res.status).toBe(0);

    const log = calls();
    const verified = log.findIndex((c) => c === "plugins info tts-local-cli");
    const selected = log.findIndex((c) => c === "config set messages.tts.provider tts-local-cli");

    expect(verified, "the plugin is never verified").toBeGreaterThanOrEqual(0);
    // Verifying after the selection would prove nothing: the box would already
    // be pointing at the provider by the time we found out it is missing.
    expect(verified).toBeLessThan(selected);
  });

  it("refuses to select a provider that is still not registered", () => {
    // The failure this whole change exists to stop: config written, provider
    // named, nothing able to answer.
    const res = runStep({ INFO_EXIT: "1" });

    expect(res.status, "an unregistered provider must fail the step").not.toBe(0);
    expect(calls()).not.toContain("config set messages.tts.provider tts-local-cli");
    expect(res.stderr).toMatch(/not registered/i);
  });

  it("still writes the provider definition when registration fails", () => {
    // Only the *selection* is gated. The definition is harmless on its own and
    // keeping it means a later refresh + re-run has nothing left to redo.
    runStep({ INFO_EXIT: "1" });
    expect(calls().some((c) => c.startsWith("config set messages.tts.providers.tts-local-cli"))).toBe(true);
  });

  it("treats a failed refresh as a warning, not a failure, when the plugin is there anyway", () => {
    // An older OpenClaw without `plugins registry` must not cost a box its
    // voice — what matters is whether the provider resolves, not how it got
    // there.
    const res = runStep({ REFRESH_EXIT: "1" });
    expect(res.status).toBe(0);
    expect(calls()).toContain("config set messages.tts.provider tts-local-cli");
    // Silently swallowing it would hide the one clue for the next person
    // debugging a box that went quiet.
    expect(res.stderr).toMatch(/could not refresh the plugin registry/i);
  });
});

/**
 * The boxes that need this most are the ones that already ran the old step:
 * they have `messages.tts.provider = tts-local-cli` saved, and the OpenClaw
 * upgrade they just took is exactly what invalidated the registry. The
 * seed-if-unset guard returns early for them, so the verification has to live
 * on that path too — otherwise the fix reaches only fresh installs, and
 * step_openclaw_tts is in step_post_update precisely for the others.
 */
describe.skipIf(!hasBash)("an already-configured box is re-verified, not just preserved", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tts-registry-upgrade-"));
    projectDir = path.join(dir, "project");
    callsLog = path.join(dir, "calls.log");
    mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
    writeFileSync(
      path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
      "#!/usr/bin/env bash\n[ \"${1:-}\" = \"--provider-timeout-ms\" ] && echo 100000\nexit 0\n",
      { mode: 0o755 },
    );
    writeFileSync(path.join(projectDir, "scripts", "install-voice.sh"), "#!/usr/bin/env bash\nexit 0\n", {
      mode: 0o755,
    });
    writeOpenclawStub();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("refreshes the registry when tts-local-cli is already selected", () => {
    const res = runStep({ CURRENT_TTS_PROVIDER: "tts-local-cli" });
    expect(res.status).toBe(0);
    expect(calls()).toContain("plugins registry --refresh");
    expect(calls()).toContain("plugins info tts-local-cli");
  });

  it("fails loudly when the already-selected provider still does not resolve", () => {
    const res = runStep({ CURRENT_TTS_PROVIDER: "tts-local-cli", INFO_EXIT: "1" });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/does not resolve/i);
  });

  it("leaves a different provider alone entirely", () => {
    // An owner on ElevenLabs must not have their choice touched, and must not
    // pay for a registry rebuild on every update either.
    const res = runStep({ CURRENT_TTS_PROVIDER: "elevenlabs" });
    expect(res.status).toBe(0);
    expect(calls()).not.toContain("plugins registry --refresh");
    expect(calls()).not.toContain("config set messages.tts.provider tts-local-cli");
    expect(res.stdout).toMatch(/preserving/i);
  });
});

/**
 * WHICH voice an unset box is pointed at.
 *
 * Executed, not asserted from the source: `tts_managed_cloud_provider` parses
 * the provider MAP, and a stub that answers only `…provider` leaves the map
 * empty — so every one of these runs would have taken the on-device branch and
 * the cloud default would have looked covered while never once running.
 */
const MANAGED_CLOUD = JSON.stringify({
  openai: { baseUrl: "https://clawbox.com/api/ai", model: "gpt-4o-mini-tts", clawboxManaged: true },
  "tts-local-cli": { command: "/x/clawbox-tts.sh" },
});

describe.skipIf(!hasBash)("step_openclaw_tts picks the first voice for an unset box", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clawbox-tts-registry-"));
    projectDir = path.join(dir, "project");
    callsLog = path.join(dir, "calls.log");
    mkdirSync(path.join(projectDir, "scripts", "openclaw"), { recursive: true });
    // Answers `--provider-timeout-ms`, which the sibling describe's stub never
    // has to: `tts_write_local_provider_definition` asks the script for the
    // timeout it will put in the provider entry, and refuses to write one
    // without it — so a silent stub fails the definition and the step returns
    // before it ever reaches the selection these tests are about.
    writeFileSync(
      path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh"),
      "#!/usr/bin/env bash\ncase \"${1:-}\" in --provider-timeout-ms) echo 100000; exit 0 ;; esac\nexit 0\n",
      { mode: 0o755 },
    );
    // A HEALTHY box, unlike the sibling describe above: these tests run the
    // step all the way to the end (the others return early on an
    // already-configured provider), so the engine has to report itself ready or
    // the step exits on the mute-box path and the selection is beside the point.
    writeFileSync(
      path.join(projectDir, "scripts", "install-voice.sh"),
      `#!/usr/bin/env bash\nprintf 'CLAWBOX_TTS_KOKORO=ready\\n' > "${path.join(dir, "tts-status")}"\nexit 0\n`,
      { mode: 0o755 },
    );
    writeOpenclawStub();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("selects the ClawBox AI cloud voice when the box has one", () => {
    const res = runStep({ PROVIDERS_JSON: MANAGED_CLOUD });
    expect(res.status).toBe(0);
    expect(calls()).toContain("config set messages.tts.provider openai");
    expect(calls()).not.toContain("config set messages.tts.provider tts-local-cli");
    // Kokoro is still INSTALLED and still defined — only the default changed.
    expect(calls().some((c) => c.startsWith("config set messages.tts.providers.tts-local-cli"))).toBe(true);
    expect(res.stdout).toMatch(/cloud voice selected/i);
  });

  it("selects the on-device voice when there is no managed cloud entry", () => {
    // An owner's OWN openai speech route carries no `clawboxManaged` stamp and
    // must never be mistaken for ours.
    const unstamped = JSON.stringify({ openai: { baseUrl: "https://api.openai.com/v1" } });
    const res = runStep({ PROVIDERS_JSON: unstamped });
    expect(res.status).toBe(0);
    expect(calls()).toContain("config set messages.tts.provider tts-local-cli");
    expect(calls()).not.toContain("config set messages.tts.provider openai");
  });

  it("falls back to the on-device voice when the cloud one cannot be selected", () => {
    // tts-local-cli was written and its plugin verified moments earlier, so it
    // is the one provider this step KNOWS can answer. A cloud entry that will
    // not select must not leave a working engine with no selection at all.
    const res = runStep({ PROVIDERS_JSON: MANAGED_CLOUD, SELECT_FAIL_FOR: "openai" });
    expect(res.status).toBe(0);
    expect(calls()).toContain("config set messages.tts.provider tts-local-cli");
    expect(res.stderr).toMatch(/fell back to the on-device voice/i);
  });
});
