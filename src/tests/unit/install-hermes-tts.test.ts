import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The Hermes SKU shipped without a voice of its own.
 *
 * `step_openclaw_tts` opened with
 *
 *     is_hermes_edition && { echo "  [hermes edition] skipping on-device TTS"; return 0; }
 *
 * so a Hermes box never ran scripts/install-voice.sh at all: no Kokoro, no
 * kokoro-server unit, and nothing for the health probe to verify — which is
 * why the probe carried a matching `if ! is_hermes_edition` and the
 * probe-count arithmetic branched on the edition. The owner's decision is that
 * Hermes runs the SAME on-device engine as OpenClaw, so all three go.
 *
 * Registering it is a different job on each harness. OpenClaw takes a JSON
 * provider under `messages.tts.providers` whose args carry the text inline;
 * Hermes has its own native `tts:` block in ~/.hermes/config.yaml with
 * `tts.providers.<name>` entries of `type: command`, and it hands the text to
 * that command as a FILE (`{input_path}`), not as an argument. So the script
 * grew `--text-file`: routing the file through `"$(cat …)"` inside a
 * shell-interpreted provider command would re-expand a model-controlled string
 * in a shell AND blow ARG_MAX on a long reply.
 *
 * These tests EXECUTE the shipped artifacts — the real `step_openclaw_tts` and
 * the real scripts/openclaw/clawbox-tts.sh — against stubs for the two
 * harness CLIs, rather than grepping their text.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const TTS_SCRIPT = path.join(REPO, "scripts", "openclaw", "clawbox-tts.sh");

const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;

/** The provider name install.sh registers with Hermes. */
const HERMES_PROVIDER = "clawbox-local";

function extractShellFn(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return source.slice(start, end + 2);
}

/**
 * The one-line edition predicates, read out of install.sh rather than
 * re-typed here: this file is about which of them gates what, so a test that
 * carried its own copy could pass against a definition the installer no
 * longer has.
 */
function extractShellOneLiner(name: string): string {
  const m = new RegExp(`^${name}\\(\\) \\{.*\\}$`, "m").exec(INSTALL_SH);
  if (!m) throw new Error(`${name} is not a one-line function in install.sh`);
  return m[0];
}

function writeExec(file: string, body: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "hermes-tts-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ── The step_openclaw_tts harness ───────────────────────────────────────────

interface StepOpts {
  /** Exit status of the stub scripts/install-voice.sh. */
  voiceExit?: number;
  /** What `hermes config get tts.provider` answers ("" = the key is unset). */
  hermesProvider?: string;
  /** What `openclaw config get <tts home>.provider` answers. */
  openclawProvider?: string;
  /** A `hermes config set` key prefix that must fail, to test the write gate. */
  hermesFailKey?: string;
  /** Leave ~/.local/bin/hermes out, to test the "no CLI to write to" guard. */
  omitHermesCli?: boolean;
  /**
   * Make `hermes config get tts.provider` FAIL rather than answer "unset".
   * The two exit the same way and mean opposite things.
   */
  hermesReadFails?: boolean;
  /** Publish this to $TTS_STATUS_FILE. */
  ttsStatus?: string | null;
  /** Deploy clawbox-tts.sh without the execute bit. */
  ttsScriptExecutable?: boolean;
}

/**
 * Run the real step_openclaw_tts for one edition, against stub `openclaw` and
 * `hermes` CLIs and a stub install-voice.sh whose exit code the test picks.
 */
function runStep(edition: string, opts: StepOpts = {}) {
  const {
    voiceExit = 0,
    hermesProvider = "",
    openclawProvider = "",
    hermesFailKey = "",
    omitHermesCli = false,
    hermesReadFails = false,
    ttsStatus = "KOKORO=ready\n",
    ttsScriptExecutable = true,
  } = opts;

  const projectDir = path.join(root, "project");
  const clawboxHome = path.join(root, "home");
  const voiceArgs = path.join(root, "voice-args.log");
  const openclawLog = path.join(root, "openclaw.log");
  const hermesLog = path.join(root, "hermes.log");
  const hermesHomeLog = path.join(root, "hermes-home.log");
  const provisionLog = path.join(root, "provision-failures.log");

  const deployedTts = path.join(projectDir, "scripts", "openclaw", "clawbox-tts.sh");
  mkdirSync(path.dirname(deployedTts), { recursive: true });
  writeFileSync(
    deployedTts,
    '#!/usr/bin/env bash\n[ "${1:-}" = "--provider-timeout-ms" ] && echo 100000\nexit 0\n',
    { mode: ttsScriptExecutable ? 0o755 : 0o644 },
  );
  writeExec(
    path.join(projectDir, "scripts", "install-voice.sh"),
    [`printf '%s\\n' "$*" >> "${voiceArgs}"`, `exit ${voiceExit}`].join("\n"),
  );

  const openclaw = path.join(root, "openclaw");
  writeExec(
    openclaw,
    [
      `printf '%s\\n' "$*" >> "${openclawLog}"`,
      'if [ "$1" = "config" ] && [ "$2" = "get" ]; then',
      `  case "$3" in *.provider) printf '%s' "${openclawProvider}" ;; esac`,
      "  exit 0",
      "fi",
      "exit 0",
    ].join("\n"),
  );

  const hermesBin = path.join(clawboxHome, ".local", "bin", "hermes");
  if (!omitHermesCli) {
    writeExec(
      hermesBin,
      [
        `printf '%s\\n' "$*" >> "${hermesLog}"`,
        // HOME as the CLI actually sees it, so the test can prove the step
        // does not rest on sudoers' always_set_home.
        `printf '%s\\n' "\${HOME:-}" >> "${hermesHomeLog}"`,
        'if [ "$1" = "config" ] && [ "$2" = "get" ]; then',
        // Hermes answers an unset key with exit 1 and `Config key not set` on
        // stderr — verified on the live box, see src/lib/hermes-config-cache.ts.
        // A read that FAILED — a timeout, an OOM-killed Python start — as
        // opposed to a key that is simply unset. The two exit the same way and
        // say different things, which is the whole point of the arm below.
        ...(hermesReadFails
          ? [`  if [ "$3" = "tts.provider" ]; then echo "hermes: timed out" >&2; exit 1; fi`]
          : []),
        `  if [ "$3" = "tts.provider" ] && [ -n "${hermesProvider}" ]; then printf '%s\\n' "${hermesProvider}"; exit 0; fi`,
        '  echo "Config key not set: $3" >&2',
        "  exit 1",
        "fi",
        'if [ "$1" = "config" ] && [ "$2" = "set" ]; then',
        ...(hermesFailKey ? [`  case "$3" in ${hermesFailKey}*) exit 1 ;; esac`] : []),
        "  exit 0",
        "fi",
        "exit 0",
      ].join("\n"),
    );
  }

  const ttsStatusFile = path.join(root, "tts-status");
  if (ttsStatus !== null) writeFileSync(ttsStatusFile, ttsStatus);

  const program = [
    "set -uo pipefail",
    `PROJECT_DIR="${projectDir}"`,
    `CLAWBOX_HOME="${clawboxHome}"`,
    `OPENCLAW_BIN="${openclaw}"`,
    `CLAWBOX_EDITION="${edition}"`,
    "CLAWBOX_USER=clawbox",
    'as_clawbox() { env "$@"; }',
    // The REAL predicates, so this file pins which one gates which arm: the
    // dual SKU runs both harnesses and has to be registered with both.
    extractShellOneLiner("is_hermes_edition"),
    extractShellOneLiner("has_hermes_harness"),
    extractShellOneLiner("has_openclaw_harness"),
    // OpenClaw 1 vs 2 decides messages.tts vs tts; pinned to v1 here so the
    // OpenClaw assertions in this file read the same key on every run. Which
    // home is correct is install-kokoro-tts.test.ts's subject, not this one's.
    "openclaw_is_v2() { return 1; }",
    `record_provision_failure() { printf '%s\\n' "$1" >> "${provisionLog}"; }`,
    extractShellFn(INSTALL_SH, "oc_config_set"),
    extractShellFn(INSTALL_SH, "tts_ensure_provider_registered"),
    extractShellFn(INSTALL_SH, "tts_write_local_provider_definition"),
    extractShellFn(INSTALL_SH, "harness_has_no_gpu"),
    extractShellFn(INSTALL_SH, "step_openclaw_tts"),
    "step_openclaw_tts",
    'echo "STEP_RC=$?"',
  ].join("\n");

  const res = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, TTS_STATUS_FILE: ttsStatusFile },
  });
  const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").filter(Boolean) : []);
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return {
    out,
    stepRc: /STEP_RC=(\d+)/.exec(out)?.[1] ?? "",
    voiceArgs: lines(voiceArgs),
    openclawCalls: lines(openclawLog),
    hermesCalls: lines(hermesLog),
    hermesEnvHomes: lines(hermesHomeLog),
    clawboxHome,
    provisionFailures: lines(provisionLog),
  };
}

describe.skipIf(!hasBash)("the Hermes SKU installs the same on-device engine as OpenClaw", () => {
  it("runs the voice install on a Hermes box instead of returning early", () => {
    // The whole defect in one assertion: the step used to answer
    // "[hermes edition] skipping on-device TTS" and return 0, so no Hermes box
    // ever had scripts/install-voice.sh run on it.
    const res = runStep("hermes");
    expect(res.voiceArgs, `install-voice.sh never ran on a Hermes box:\n${res.out}`).toContain("--tts-only");
    expect(res.out).not.toMatch(/skipping on-device TTS/);
  });

  it("runs it on the dual SKU too", () => {
    const res = runStep("dual");
    expect(res.voiceArgs, `install-voice.sh never ran on a dual box:\n${res.out}`).toContain("--tts-only");
  });

  it("still runs it on the openclaw SKU, unchanged", () => {
    const res = runStep("openclaw");
    expect(res.voiceArgs).toContain("--tts-only");
    expect(res.hermesCalls, `an openclaw box was written to through the Hermes CLI:\n${res.out}`).toEqual([]);
  });
});

describe.skipIf(!hasBash)("the on-device voice is registered with Hermes natively", () => {
  it("defines a type: command provider whose command carries Hermes' own placeholders", () => {
    const res = runStep("hermes");
    const calls = res.hermesCalls.join("\n");
    // `type: command` is what makes tts_tool.py treat the entry as a command
    // provider at all — a provider whose type is set to anything else is
    // rejected outright.
    expect(calls, `no type was written:\n${res.out}`).toContain(
      `config set tts.providers.${HERMES_PROVIDER}.type command`,
    );
    // {input_path} is a FILE holding the text, so the script is handed
    // --text-file rather than the text itself; {output_path} is the single
    // remaining positional.
    expect(calls, `the provider command is not Hermes-shaped:\n${res.out}`).toContain(
      `config set tts.providers.${HERMES_PROVIDER}.command ` +
        `${path.join(root, "project", "scripts", "openclaw", "clawbox-tts.sh")} ` +
        "--text-file={input_path} -- {output_path}",
    );
  });

  it("pins HOME on every Hermes CLI call, so the writes land where the dashboard reads", () => {
    // `as_clawbox` is `sudo -u`, and whether that resets HOME or preserves
    // root's depends on sudoers. With root's HOME preserved the CLI would read
    // and write /root/.hermes/config.yaml while the dashboard serves
    // /home/clawbox/.hermes/config.yaml — every write "succeeds" and the box
    // never speaks.
    const res = runStep("hermes");
    expect(res.hermesEnvHomes.length, `no Hermes CLI call was made:\n${res.out}`).toBeGreaterThan(0);
    for (const home of res.hermesEnvHomes) {
      expect(home, `a Hermes call ran with the wrong HOME:\n${res.out}`).toBe(res.clawboxHome);
    }
  });

  // TASK-699. The card asked for the selection to be WITHHELD on a box with no
  // engine. It must not be: measured read-only on the pinned Hermes 0.20.5
  // package on the Hermes box, `tools/tts_tool.py:211` sets
  // `DEFAULT_PROVIDER = "edge"` and `:661` resolves
  // `(tts_config.get("provider") or DEFAULT_PROVIDER)`, so an unset
  // `tts.provider` IS Microsoft's Edge cloud and the harness offers no "off"
  // value at all. Withholding or clearing the selection would move an
  // engineless box from honestly mute to speaking through a third party the
  // customer never chose. What was missing was saying so.
  describe("keeps an engineless box off a cloud it never chose", () => {
    it("still selects the on-device provider when there is no engine", () => {
      // 13 is "this board declines Kokoro" — the verdict shape the dev box
      // publishes when there is no CUDA build for it.
      const res = runStep("hermes", { voiceExit: 13, ttsStatus: "KOKORO=skipped:no-cuda\n" });
      const calls = res.hermesCalls.join("\n");

      expect(calls).toContain(`config set tts.providers.${HERMES_PROVIDER}.type command`);
      expect(calls, `an engineless box was left to resolve Hermes' Edge default:\n${res.out}`)
        .toContain(`config set tts.provider ${HERMES_PROVIDER}`);
    });

    it("never clears the selection, whatever the engine did", () => {
      // The one write this arm must never make. `config unset tts.provider`
      // does not mute the box, it hands it to Microsoft.
      for (const opts of [
        { voiceExit: 13, ttsStatus: "KOKORO=skipped:no-cuda\n" },
        { voiceExit: 13, ttsStatus: "KOKORO=skipped:no-cuda\n", hermesProvider: HERMES_PROVIDER },
        { voiceExit: 0, ttsStatus: "KOKORO=failed:build\n", hermesProvider: "edge" },
      ]) {
        const res = runStep("hermes", opts);
        expect(res.hermesCalls.join("\n"), `the selection was cleared:\n${res.out}`)
          .not.toContain("config unset tts.provider");
      }
    });

    it("replaces Hermes' factory Edge even on a box that cannot speak for itself", () => {
      // The arm admits `edge`, and an engineless box is exactly where a "leave
      // it alone" branch would strand the owner on Microsoft's cloud.
      const res = runStep("hermes", {
        voiceExit: 13,
        ttsStatus: "KOKORO=skipped:no-cuda\n",
        hermesProvider: "edge",
      });

      expect(res.hermesCalls.join("\n"), `the box was left on Hermes' Edge cloud:\n${res.out}`)
        .toContain(`config set tts.provider ${HERMES_PROVIDER}`);
      expect(res.out).toMatch(/replacing Hermes' factory 'edge' cloud default/);
    });

    it("says the box has no voice yet, and why the selection is kept anyway", () => {
      const res = runStep("hermes", { voiceExit: 13, ttsStatus: "KOKORO=skipped:no-cuda\n" });

      // The three facts that make the line actionable, each asserted rather
      // than implied — the 13 arm's own banner already names the verdict and
      // the link, so those two alone would pass unchanged against beta.
      // The REASON in the operator's words, not the raw verdict — the line is
      // for whoever reads the install log, and "no engine" alone is not
      // actionable. Non-empty and specific, so a `($KOKORO_REASON)` that
      // stopped being set fails here.
      expect(res.out).toMatch(/no on-device engine \(this board declines Kokoro[^)]*\)/);
      expect(res.out).toMatch(/stays SILENT until ClawBox AI is linked/);
      expect(res.out).toMatch(/would hand the box to Hermes' factory Edge cloud/);
    });

    it("says nothing of the sort when the engine is there", () => {
      const res = runStep("hermes", { voiceExit: 0, ttsStatus: "KOKORO=ready\n" });

      expect(res.hermesCalls.join("\n"), `the engine was installed and not selected:\n${res.out}`)
        .toContain(`config set tts.provider ${HERMES_PROVIDER}`);
      expect(res.out).not.toMatch(/no on-device engine/);
    });

    it("reads the published verdict, not the exit code", () => {
      // VOICE_RC=1 with `KOKORO=ready` on file is a working engine — the
      // OpenClaw arm of this same step says so in as many words — and a box
      // that CAN speak must not be told it stays silent.
      const working = runStep("hermes", { voiceExit: 1, ttsStatus: "KOKORO=ready\n" });
      expect(working.out, `a working engine was reported as missing:\n${working.out}`)
        .not.toMatch(/no on-device engine/);

      // The other direction: "the file says the engine is not there" beats
      // "the status code implied it was".
      const missing = runStep("hermes", { voiceExit: 0, ttsStatus: "KOKORO=failed:build\n" });
      expect(missing.out, `a missing engine was passed over in silence:\n${missing.out}`)
        .toMatch(/no on-device engine \(.+\)/);
    });

    it("says what an engineless box is left with even when the selection could not be read", () => {
      // The one arm of this step that can leave `tts.provider` UNSET on a
      // first install — and this PR is the one that established that an unset
      // key is Hermes' Edge cloud, not silence. Its warning says the selection
      // is "left alone", which reads as "no change" when on an unset key it
      // means Microsoft. The engine verdict is already in hand here; saying it
      // costs nothing and is the only thing this step can still tell the
      // operator on this path.
      const res = runStep("hermes", {
        hermesReadFails: true,
        voiceExit: 13,
        ttsStatus: "KOKORO=skipped:no-cuda\n",
      });

      expect(res.out).toMatch(/could not read tts.provider/);
      expect(res.out, `the missing engine was never mentioned:\n${res.out}`)
        .toMatch(/no on-device engine \(this board declines Kokoro[^)]*\)/);
      // What an unread selection can be hiding, and the one command that
      // settles it.
      expect(res.out).toMatch(/--step openclaw_tts/);
    });

    it("says nothing about a missing engine on that path when the engine is there", () => {
      const res = runStep("hermes", { hermesReadFails: true, voiceExit: 0, ttsStatus: "KOKORO=ready\n" });

      expect(res.out).toMatch(/could not read tts.provider/);
      expect(res.out).not.toMatch(/no on-device engine/);
    });

    it("still leaves an owner's own provider alone when there is no engine", () => {
      const res = runStep("hermes", {
        voiceExit: 13,
        ttsStatus: "KOKORO=skipped:no-cuda\n",
        hermesProvider: "elevenlabs",
      });

      // The trailing space matters: `config set tts.providers.…` starts with
      // the same characters, and an assertion that matched it would pass over
      // the very definition this block is supposed to keep writing.
      expect(res.hermesCalls.join("\n")).not.toContain("config set tts.provider ");
    });
  });

  it("does not promise the OpenClaw arm a cloud voice the plan may not include", () => {
    // The Hermes Note says "on a plan that includes cloud speech" because
    // gateway-pre-start.sh gates the OpenClaw cloud voice on exactly that
    // device tier (CLAWBOX_SPEECH_DEVICE_TIER) and refuses to write it below
    // one. The OpenClaw line beside it promised the voice on the link alone —
    // two harnesses, one box, two answers, in the same install log.
    const res = runStep("openclaw", { voiceExit: 13, ttsStatus: "KOKORO=skipped:no-cuda\n" });

    expect(res.out).toMatch(/NO working on-device TTS engine/);
    expect(res.out, `the cloud voice was promised unconditionally:\n${res.out}`)
      .toMatch(/on a plan that includes cloud speech/);
  });

  it("pins the output format to wav, so no utterance needs ffmpeg", () => {
    // VERIFIED ON THE BOX: tts_tool.py's _get_command_tts_output_format reads
    // `format` or `output_format` and otherwise falls back to
    // DEFAULT_COMMAND_TTS_OUTPUT_FORMAT = "mp3". Leave the key unset and
    // Hermes hands clawbox-tts.sh an .mp3 path on EVERY utterance; the script
    // then needs `ffmpeg -codec:a libmp3lame` and REFUSES the whole run
    // without it — and install.sh never installs ffmpeg in the main flow, so
    // on an image that does not happen to ship it the box's own voice fails
    // every time. The OpenClaw arm writes `outputFormat: "wav"` for the same
    // script and the same reason; the two harnesses must not disagree.
    const res = runStep("hermes");
    expect(res.hermesCalls.join("\n"), `no output_format was pinned:\n${res.out}`).toContain(
      `config set tts.providers.${HERMES_PROVIDER}.output_format wav`,
    );
  });

  it("writes the format BEFORE the type, so a half-written provider is never runnable", () => {
    // `type: command` is what makes Hermes treat the entry as a command
    // provider at all, so it stays last: a provider that became runnable
    // before its format landed would speak .mp3 exactly once.
    const res = runStep("hermes");
    const calls = res.hermesCalls.join("\n");
    const fmt = calls.indexOf(`${HERMES_PROVIDER}.output_format`);
    const type = calls.indexOf(`${HERMES_PROVIDER}.type`);
    expect(fmt, `output_format was not written:\n${res.out}`).toBeGreaterThan(-1);
    expect(fmt, `type landed before the format:\n${res.out}`).toBeLessThan(type);
  });

  it("does not pass --voice, so the Voice tab's own pick is what speaks", () => {
    // clawbox-tts.sh's resolve_voice gives --voice precedence over the saved
    // voice file, and an UNKNOWN --voice falls back to the script default
    // rather than to that file. Hermes substitutes its own per-provider voice
    // for {voice} and ClawBox writes no voice key for this provider, so
    // passing it would make the Voice tab's voice dropdown a no-op: the owner
    // picks af_bella, gets a 200 and a panel showing af_bella, and the box
    // keeps speaking af_heart. The OpenClaw provider passes no --voice for the
    // same reason; both harnesses read $CLAWBOX_TTS_VOICE_FILE instead.
    const res = runStep("hermes");
    const command = res.hermesCalls.find((c) => c.includes(`${HERMES_PROVIDER}.command`)) ?? "";
    expect(command, `the provider command was not written:\n${res.out}`).not.toBe("");
    expect(command, `--voice would override the saved voice:\n${res.out}`).not.toContain("--voice");
    // And the `=` spelling, because the placeholders are interpolated UNQUOTED
    // into a shell-interpreted string: an empty {input_path} in the separated
    // form collapses to `--text-file -- /out.wav`, and the script would take
    // `--` as the flag's value and go on to speak a file path aloud.
    expect(command, `a separated flag can swallow the next token:\n${res.out}`)
      .toContain("--text-file={input_path}");
  });

  it("registers with BOTH harnesses on the dual SKU", () => {
    // has_hermes_harness, not is_hermes_edition: a dual box that keyed this off
    // the hermes SKU alone would speak on one harness and be silent on the
    // other.
    const res = runStep("dual");
    expect(res.hermesCalls.join("\n"), `the dual SKU got no Hermes provider:\n${res.out}`).toContain(
      `config set tts.providers.${HERMES_PROVIDER}.type command`,
    );
    expect(res.openclawCalls.join("\n"), `the dual SKU lost its OpenClaw provider:\n${res.out}`).toContain(
      "config set messages.tts.providers.tts-local-cli",
    );
  });

  it("still configures OpenClaw on a dual box when the Hermes read fails", () => {
    // The failed-read arm used to `return` — out of the whole function, from
    // inside the Hermes block — so one transient `hermes config get` hiccup on
    // a DUAL box left its OpenClaw harness without tts-local-cli. The two
    // harnesses are configured independently; a failure in one is not a reason
    // to abandon the other.
    const res = runStep("dual", { hermesReadFails: true });
    expect(res.openclawCalls.join("\n"), `the dual SKU lost its OpenClaw provider:\n${res.out}`)
      .toContain("config set messages.tts.providers.tts-local-cli");
    // And the selection it could not read is left alone, not overwritten.
    expect(res.hermesCalls.join("\n"), `an unreadable selection was overwritten:\n${res.out}`)
      .not.toContain("config set tts.provider ");
  });

  it("leaves an owner's provider alone when the read failed rather than was unset", () => {
    // `hermes config get` exits non-zero for both a failed read and an unset
    // key. Treating them alike would replace a deliberate ElevenLabs pick with
    // ours on any update that hit a timeout — every update another chance.
    const res = runStep("hermes", { hermesReadFails: true });
    expect(res.hermesCalls.join("\n"), `a failed read was treated as unset:\n${res.out}`)
      .not.toContain("config set tts.provider ");
    expect(res.out).toMatch(/could not read tts\.provider/i);
  });

  it("writes the definition BEFORE selecting the provider", () => {
    const res = runStep("hermes");
    const calls = res.hermesCalls.join("\n");
    const define = calls.indexOf(`tts.providers.${HERMES_PROVIDER}.command`);
    const select = calls.indexOf(`config set tts.provider ${HERMES_PROVIDER}`);
    expect(define, `the provider was never defined:\n${res.out}`).toBeGreaterThanOrEqual(0);
    expect(select, `the provider was never selected:\n${res.out}`).toBeGreaterThanOrEqual(0);
    expect(define).toBeLessThan(select);
  });

  it("does NOT select the provider when the definition write fails", () => {
    // Pointing the harness at a provider that does not exist is strictly worse
    // than leaving tts.provider alone: every spoken reply then fails, and the
    // box looks configured.
    const res = runStep("hermes", { hermesFailKey: "tts.providers." });
    expect(
      res.hermesCalls.some((c) => c.includes(`config set tts.provider ${HERMES_PROVIDER}`)),
      `a provider that could not be defined was selected anyway:\n${res.out}`,
    ).toBe(false);
    expect(res.provisionFailures, `a failed registration was recorded nowhere:\n${res.out}`).toContain("openclaw_tts");
  });

  it("refuses to register a clawbox-tts.sh that is not executable", () => {
    // The same rule the OpenClaw arm already enforces: never point a harness
    // at a command that is not there. It looks like a working install right up
    // until someone asks the box to speak.
    const res = runStep("hermes", { ttsScriptExecutable: false });
    expect(
      res.hermesCalls.some((c) => c.includes("config set tts.providers")),
      `the harness was pointed at a command that cannot run:\n${res.out}`,
    ).toBe(false);
    expect(res.provisionFailures, `a refused registration was recorded nowhere:\n${res.out}`).toContain(
      "openclaw_tts",
    );
  });
});

describe.skipIf(!hasBash)("the Hermes TTS selection is seeded, never overwritten", () => {
  it("replaces Hermes' factory `edge` default", () => {
    // Hermes ships tts.provider: edge — Microsoft's cloud voice. A ClawBox
    // must not default to shipping its owner's speech to a cloud service, so
    // `edge` counts as the factory setting it is and is replaced.
    const res = runStep("hermes", { hermesProvider: "edge" });
    expect(
      res.hermesCalls.some((c) => c.includes(`config set tts.provider ${HERMES_PROVIDER}`)),
      `a ClawBox was left speaking through Edge:\n${res.out}`,
    ).toBe(true);
  });

  it("seeds when tts.provider is unset", () => {
    const res = runStep("hermes", { hermesProvider: "" });
    expect(res.hermesCalls.some((c) => c.includes(`config set tts.provider ${HERMES_PROVIDER}`)), res.out).toBe(true);
  });

  it("preserves an owner's own choice", () => {
    // Anything that is not the factory default is the owner's pick, and every
    // update re-runs this step.
    const res = runStep("hermes", { hermesProvider: "elevenlabs" });
    expect(
      res.hermesCalls.some((c) => c.includes("config set tts.provider ")),
      `the owner's TTS provider was overwritten:\n${res.out}`,
    ).toBe(false);
    expect(res.out).toMatch(/elevenlabs/);
  });

  it("still defines the provider when the owner's own selection is preserved", () => {
    // Preserving the selection is not a reason to leave the definition stale:
    // the owner has to be able to switch to the on-device voice from the
    // dashboard without re-running the installer.
    const res = runStep("hermes", { hermesProvider: "elevenlabs" });
    expect(res.hermesCalls.join("\n")).toContain(`config set tts.providers.${HERMES_PROVIDER}.type command`);
  });
});

// ── clawbox-tts.sh --text-file ──────────────────────────────────────────────

/**
 * Run the REAL scripts/openclaw/clawbox-tts.sh against a stub `kokoro` that
 * writes a plausible WAV and records the text it was handed.
 */
function runTts(args: string[], extraEnv: Record<string, string> = {}) {
  const home = path.join(root, "tts-home");
  const kokoroLog = path.join(root, "kokoro-text.log");
  const kokoro = path.join(root, "bin", "kokoro");
  writeExec(
    kokoro,
    [
      'out=""; text=""',
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    -t) text="$2"; shift 2 ;;',
      '    -o) out="$2"; shift 2 ;;',
      "    *) shift ;;",
      "  esac",
      "done",
      `printf '%s' "$text" > "${kokoroLog}"`,
      'head -c 2048 /dev/zero > "$out"',
    ].join("\n"),
  );
  const meminfo = path.join(root, "meminfo");
  writeFileSync(meminfo, "MemTotal:       8000000 kB\nMemAvailable:   8000000 kB\n");

  mkdirSync(home, { recursive: true });
  const r = spawnSync("bash", [TTS_SCRIPT, ...args], {
    encoding: "utf-8",
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: home,
      KOKORO_BIN: kokoro,
      KOKORO_SOCKET: path.join(root, "no-such.sock"),
      KOKORO_LD_PATH: "",
      CLAWBOX_TTS_MEMINFO: meminfo,
      CLAWBOX_TTS_VOICE_FILE: path.join(home, "voice"),
      ...extraEnv,
    },
  });
  return {
    status: r.status,
    out: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    spoken: existsSync(kokoroLog) ? readFileSync(kokoroLog, "utf-8") : null,
  };
}

describe.skipIf(!hasBash)("clawbox-tts.sh --text-file", () => {
  it("speaks the contents of the file, not the flag or the path", () => {
    // Hermes hands the text as a FILE. Routing it back through "$(cat …)" in
    // the provider command string would re-expand a model-controlled string
    // inside a shell and blow ARG_MAX on a long reply, so the script reads it.
    const textFile = path.join(root, "say.txt");
    writeFileSync(textFile, "the box speaks for itself\n");
    const outWav = path.join(root, "out.wav");
    const res = runTts(["--voice", "af_heart", "--text-file", textFile, "--", outWav]);
    expect(res.status, `the run failed:\n${res.out}`).toBe(0);
    expect(res.spoken, `nothing reached the engine:\n${res.out}`).toBe("the box speaks for itself");
    expect(existsSync(outWav), `no audio was written:\n${res.out}`).toBe(true);
  });

  it("accepts the --text-file=<path> spelling too", () => {
    const textFile = path.join(root, "say2.txt");
    writeFileSync(textFile, "equals form");
    const outWav = path.join(root, "out2.wav");
    const res = runTts([`--text-file=${textFile}`, "--", outWav]);
    expect(res.status, res.out).toBe(0);
    expect(res.spoken).toBe("equals form");
  });

  it("refuses a --text-file that is not readable, non-zero and by name", () => {
    // Never silently speak an empty string: a caller that gets exit 0 and no
    // audio cannot tell a working TTS from a broken one.
    const missing = path.join(root, "gone.txt");
    const res = runTts(["--text-file", missing, "--", path.join(root, "out3.wav")]);
    expect(res.status, `a missing text file was not refused:\n${res.out}`).not.toBe(0);
    expect(res.out, `the reason does not name the file:\n${res.out}`).toContain(missing);
    expect(res.spoken, "the engine was called with no text").toBeNull();
  });

  it("refuses an empty --text-file rather than speaking nothing", () => {
    const empty = path.join(root, "empty.txt");
    writeFileSync(empty, "");
    const res = runTts(["--text-file", empty, "--", path.join(root, "out4.wav")]);
    expect(res.status, `an empty text file was accepted:\n${res.out}`).not.toBe(0);
    expect(res.spoken).toBeNull();
  });

  it("refuses --text-file given together with positional text, with a stated reason", () => {
    const textFile = path.join(root, "say3.txt");
    writeFileSync(textFile, "from the file");
    const res = runTts(["--text-file", textFile, "--", "from the argument", path.join(root, "out5.wav")]);
    expect(res.status, `an ambiguous invocation was accepted:\n${res.out}`).not.toBe(0);
    expect(res.out).toMatch(/--text-file/);
    expect(res.spoken, "an ambiguous invocation still reached the engine").toBeNull();
  });

  it("refuses --text-file with no value rather than spinning on it", () => {
    // The same guard --voice carries: `shift 2` with one argument left does
    // not shift, and swallowing that spins the option loop on a core.
    const res = runTts(["--text-file"]);
    expect(res.status).not.toBe(0);
    expect(res.out).toMatch(/--text-file requires a value/);
  });

  it("leaves the positional form working byte-for-byte", () => {
    // The OpenClaw edition's provider passes the text as ARGS[0].
    const outWav = path.join(root, "out6.wav");
    const res = runTts(["--voice", "af_heart", "--", "positional text", outWav]);
    expect(res.status, res.out).toBe(0);
    expect(res.spoken).toBe("positional text");
    expect(existsSync(outWav)).toBe(true);
  });

  /**
   * WHY install.sh pins `output_format: wav` on the Hermes provider.
   *
   * With that key unset the harness defaults a command provider's format to
   * `mp3` (tts_tool.py: `config.get("format") or config.get("output_format")
   * or DEFAULT_COMMAND_TTS_OUTPUT_FORMAT`, and that constant is "mp3"), so it
   * hands this script an .mp3 path on every utterance. These two cases are
   * what that costs: the same synthesis succeeds into .wav and refuses into
   * .mp3 on a box without ffmpeg — which install.sh never installs.
   */
  it("refuses an .mp3 output when ffmpeg is absent, rather than writing broken audio", () => {
    const textFile = path.join(root, "fmt.txt");
    writeFileSync(textFile, "format matters");
    const outMp3 = path.join(root, "out-fmt.mp3");
    const res = runTts([`--text-file=${textFile}`, "--", outMp3], {
      FFMPEG_BIN: path.join(root, "no-such-ffmpeg"),
    });
    expect(res.status, `an .mp3 without ffmpeg was not refused:\n${res.out}`).not.toBe(0);
    expect(res.out).toMatch(/ffmpeg not available/i);
    expect(existsSync(outMp3), "a broken .mp3 was left behind").toBe(false);
  });

  it("writes a .wav with no ffmpeg anywhere, which is why the provider pins wav", () => {
    const textFile = path.join(root, "fmt2.txt");
    writeFileSync(textFile, "format matters");
    const outWav = path.join(root, "out-fmt.wav");
    const res = runTts([`--text-file=${textFile}`, "--", outWav], {
      FFMPEG_BIN: path.join(root, "no-such-ffmpeg"),
    });
    expect(res.status, `the wav path needed ffmpeg after all:\n${res.out}`).toBe(0);
    expect(existsSync(outWav), `no audio was written:\n${res.out}`).toBe(true);
  });

  it("advertises --text-file in its usage", () => {
    const res = runTts(["--help"]);
    expect(res.out).toMatch(/--text-file/);
  });
});

// ── The health probe and its arithmetic ─────────────────────────────────────

/**
 * Run the real step_validate_services for one edition with everything except
 * the TTS verdict stubbed healthy.
 */
function runValidator(edition: string, ttsStatusContents: string | null) {
  const ttsStatusFile = path.join(root, "validator-tts-status");
  if (ttsStatusContents !== null) writeFileSync(ttsStatusFile, ttsStatusContents);
  const clock = path.join(root, "clock");
  writeFileSync(clock, "1000\n");
  const projectDir = path.join(root, "validator-project");
  // The dashboard-auth probe (hermes + dual) runs the auth script's own
  // classifier. Stub it healthy: which invariant it checks is
  // install-hermes-edition-step.test.ts's subject, not this one's.
  writeExec(path.join(projectDir, "scripts", "setup-hermes-dashboard-auth.sh"), "exit 0");

  const program = [
    "set -uo pipefail",
    `CLAWBOX_EDITION="${edition}"`,
    "CLAWBOX_TEST_MODE=1",
    `PROJECT_DIR="${projectDir}"`,
    `CLAWBOX_HOME="${path.join(root, "validator-home")}"`,
    'IFACE_ENV="/nonexistent/network.env"',
    "EXPECTED_ACTIVE_SERVICES=()",
    "EXPECTED_INSTALLED_SERVICES=()",
    "FOREIGN_EDITION_UNITS=()",
    'is_test_mode() { [ "$CLAWBOX_TEST_MODE" = "1" ]; }',
    extractShellOneLiner("is_hermes_edition"),
    extractShellOneLiner("has_hermes_harness"),
    extractShellFn(INSTALL_SH, "harness_has_no_gpu"),
    "gateway_port_listening() { return 1; }",
    "systemctl() { return 0; }",
    "curl() { printf '200'; }",
    `_CLOCK="${clock}"`,
    'date() { local n; n=$(( $(cat "$_CLOCK") + 100 )); echo "$n" > "$_CLOCK"; printf %s "$n"; }',
    "sleep() { :; }",
    extractShellFn(INSTALL_SH, "step_validate_services"),
    "step_validate_services",
  ].join("\n");

  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env, TTS_STATUS_FILE: ttsStatusFile },
  });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe.skipIf(!hasBash)("the health check verifies the Hermes box's voice too", () => {
  it("fails a Hermes box whose engine did not install", () => {
    // The probe used to be gated behind `if ! is_hermes_edition`, with the
    // comment "Hermes has no on-device TTS step at all, so it has nothing to
    // verify." It has one now.
    const res = runValidator("hermes", "KOKORO=failed:model\n");
    expect(res.status, `a Hermes box with no voice was graded healthy:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/requested and did NOT install/);
  });

  it("fails a Hermes box that left no verdict at all", () => {
    const res = runValidator("hermes", null);
    expect(res.status, `an absent verdict scored as a pass on Hermes:\n${res.out}`).toBe(1);
    expect(res.out).toMatch(/no on-device TTS verdict/);
  });

  it("counts the TTS verdict in the total on every edition", () => {
    // The count branched on the edition — Hermes got three gateway probes
    // INSTEAD of the TTS verdict. Now that Hermes has both, an either/or makes
    // the installer's own summary lie.
    const healthy = (edition: string) => {
      const r = runValidator(edition, "KOKORO=ready\n");
      expect(r.status, `${edition} did not validate clean:\n${r.out}`).toBe(0);
      const m = /All (\d+) checks healthy/.exec(r.out);
      expect(m, `no healthy line for ${edition}:\n${r.out}`).not.toBeNull();
      return Number(m![1]);
    };
    // In test mode: 1 (web dashboard) + 1 (TTS verdict) = 2 on openclaw.
    expect(healthy("openclaw")).toBe(2);
    // dual adds the dashboard-auth probe: 2 + 1 = 3.
    expect(healthy("dual")).toBe(3);
    // hermes adds the three gateway probes as well: 3 + 3 = 6.
    expect(healthy("hermes")).toBe(6);
  });
});
