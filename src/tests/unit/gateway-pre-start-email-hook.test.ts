import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// The gateway boot reconcile that installs ClawBox's outbound EMAIL:-directive
// plugin into the OpenClaw core, enables it, and proves it loaded.
//
// This runs the BLOCK OUT OF THE SHIPPED SCRIPT rather than a copy — the same
// approach the other gateway-pre-start suites take — so the test fails if the
// real script drifts away from it.
//
// The three failure shapes it pins:
//
//   probe-once    — a plugin installed once and assumed present for ever. The
//                   copy, the enable and the load check all run on EVERY
//                   gateway start, because ~/.openclaw does not survive a
//                   factory reset.
//   false success — `plugins.entries.<id>.enabled: true` in the config proves
//                   nothing about a module that throws on import. The readback
//                   is `plugins inspect --runtime`, and the hook names it looks
//                   at are the TOP-LEVEL `typedHooks[]` (`plugin.hookNames` is
//                   empty even when `hookCount` is not).
//   false failure — none of it may stop the gateway. This is an ExecStartPre
//                   under `set -euo pipefail`: a missing `openclaw`, a wedged
//                   CLI or an unreadable config must all leave exit 0.

const SCRIPT = path.resolve(process.cwd(), "scripts/gateway-pre-start.sh");
const REPO = path.resolve(process.cwd());
const PLUGIN_ID = "clawbox-email-directives";

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

/**
 * The shipped block, from its banner to the section that follows it.
 *
 * It starts at the shared INSTALLER now rather than at this plugin's own
 * banner: since TASK-605 two plugins are copied in by one function, and an
 * extract that began below it would run a call to a function that is not there.
 * So this block also carries the protected-path guard's install — which has its
 * own suite (gateway-pre-start-path-guard.test.ts) and is only along for the
 * ride here.
 */
function block(): string {
  const src = readFileSync(SCRIPT, "utf-8");
  const from = "# ── Installing a ClawBox hook plugin into ~/.openclaw/extensions ";
  const to = "# Seed CLAWBOX.md in the OpenClaw workspace";
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) throw new Error("the ClawBox hook-plugin block is not in gateway-pre-start.sh");
  return src.slice(start, end);
}

let dir: string;
let openclawHome: string;
let configPath: string;
let binDir: string;

/** An `openclaw` whose `plugins inspect` answers whatever the test staged. */
function stubOpenclaw(body: string) {
  const p = path.join(binDir, "openclaw");
  writeFileSync(p, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$OC_CALLS"\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

/**
 * The two hooks a healthy box registers: the outbound directive strip and the
 * inbound approval claim. Named once so a test cannot pass by asserting only
 * the hook it happens to care about — the pre-start check requires both, and a
 * box with one of them is a box where half this feature is silently off.
 */
const BOTH_HOOKS = ["reply_payload_sending", "before_dispatch"];

function loadedInspection(hookNames: string[]) {
  return `cat <<'JSON'\n${JSON.stringify({
    plugin: { id: PLUGIN_ID, status: "loaded", activated: true, hookCount: hookNames.length, hookNames: [] },
    typedHooks: hookNames.map((name) => ({ name })),
    diagnostics: [],
  })}\nJSON`;
}

/**
 * The shipped block with its ceiling turned down, so a test can drive a REAL
 * timeout in seconds instead of fifty. The substitution is ASSERTED: a renamed
 * or re-spelled constant fails loudly here rather than silently leaving the
 * test running the 45 s path and passing on a stub that answers instantly.
 */
function blockWithCeiling(seconds: number): string {
  const src = block();
  const swapped = src.replace("CLAWBOX_HOOK_CEILING=45", `CLAWBOX_HOOK_CEILING=${seconds}`);
  if (swapped === src) throw new Error("CLAWBOX_HOOK_CEILING=45 is no longer in the block");
  return swapped;
}

function runProgram(body: string, root: string, coreTarget: string, extraEnv: Record<string, string>) {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_HOME_DIR=${JSON.stringify(openclawHome)}`,
    `OPENCLAW_BIN=${JSON.stringify(path.join(binDir, "openclaw"))}`,
    `OPENCLAW_TARGET=${JSON.stringify(coreTarget)}`,
    body,
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({ PATH: `${binDir}:/usr/bin:/bin`, OC_CALLS: path.join(dir, "calls.log"), ...extraEnv }),
    timeout: 60_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function run(root = REPO, coreTarget = "2026.8.1", extraEnv: Record<string, string> = {}) {
  return runProgram(block(), root, coreTarget, extraEnv);
}

/** The gateway config as JSON. `entries` is indexed by plugin id in the tests. */
type OpenclawConfig = { plugins?: { entries?: Record<string, Record<string, unknown> | undefined> } };

function readConfig(): OpenclawConfig {
  return JSON.parse(readFileSync(configPath, "utf-8"));
}

/**
 * The stderr lines about the EMAIL: plugin, dropping the path guard's.
 *
 * `block()` extracts the shared installer and BOTH plugins it installs, so the
 * path guard's own lines ride along in every run here. They are another
 * suite's subject; an assertion about "did this block stay quiet" has to be
 * about this block.
 */
function emailHookLines(stderr: string): string {
  return stderr
    .split("\n")
    .filter((line) => !line.includes("clawbox-path-guard"))
    .join("\n");
}

function installed(): string[] {
  const target = path.join(openclawHome, "extensions", PLUGIN_ID);
  return existsSync(target) ? readdirSync(target).sort() : [];
}

function calls(): string {
  const p = path.join(dir, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf-8") : "";
}

/** The success stamp and the attempt stamp, which live BESIDE `extensions/`. */
const verifiedStamp = () => path.join(openclawHome, `.${PLUGIN_ID}-verified`);
const attemptStamp = () => path.join(openclawHome, `.${PLUGIN_ID}-attempted`);

/** Ages the attempt stamp past the retry window, as a day of uptime would. */
function ageAttempt(seconds: number) {
  const [stamp, , ...why] = readFileSync(attemptStamp(), "utf-8").trim().split(" ");
  const when = Math.floor(Date.now() / 1000) - seconds;
  writeFileSync(attemptStamp(), `${stamp} ${when} ${why.join(" ")}\n`);
}

d("gateway-pre-start.sh — the outbound EMAIL: directive hook plugin", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "oc-email-hook-"));
    openclawHome = path.join(dir, ".openclaw");
    binDir = path.join(dir, "bin");
    mkdirSync(openclawHome, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    configPath = path.join(openclawHome, "openclaw.json");
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: { deepseek: { enabled: true } } } }));
    stubOpenclaw(loadedInspection(BOTH_HOOKS));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("installs the shipped plugin and enables it", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(installed()).toEqual([
      "email-approvals.mjs",
      "email-directives.mjs",
      "index.mjs",
      "openclaw.plugin.json",
      "package.json",
    ]);
    expect(readConfig().plugins?.entries?.[PLUGIN_ID]).toEqual({ enabled: true });
    expect(r.stdout).toContain("reply_payload_sending and before_dispatch registered");
  });

  it("copies the real plugin, not a placeholder", () => {
    run();
    const shipped = readFileSync(path.join(REPO, "scripts/openclaw-plugins", PLUGIN_ID, "index.mjs"), "utf-8");
    const there = readFileSync(path.join(openclawHome, "extensions", PLUGIN_ID, "index.mjs"), "utf-8");
    expect(there).toBe(shipped);
  });

  it("leaves every other plugin entry alone", () => {
    run();
    expect(readConfig().plugins?.entries?.deepseek).toEqual({ enabled: true });
  });

  it("keeps a config that already carries our entry with extra keys", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ plugins: { entries: { [PLUGIN_ID]: { hooks: { timeoutMs: 5000 } } } } }),
    );
    run();
    expect(readConfig().plugins?.entries?.[PLUGIN_ID]).toEqual({ hooks: { timeoutMs: 5000 }, enabled: true });
  });

  it("does not rewrite the config on a second boot", () => {
    run();
    const before = readFileSync(configPath, "utf-8");
    const r = run();
    expect(r.stdout).toContain("already enabled");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("verifies the plugin LOADED the first time it is installed", () => {
    const r = run();
    expect(calls()).toContain(`plugins inspect ${PLUGIN_ID} --runtime --json`);
    expect(r.stdout).toContain("reply_payload_sending and before_dispatch registered");
  });

  it("does NOT pay for the runtime check on an ordinary gateway restart", () => {
    // This file exists to keep the gateway's ExecStartPre cheap — its header
    // records the ~70 s of "Reload gateway" that CLI calls here used to cost,
    // and a restart happens on a skill install, a Telegram reconfigure, a
    // provider change, a model switch and every crash. `inspect --runtime` is
    // heavier than any of the calls that were removed.
    run();
    writeFileSync(path.join(dir, "calls.log"), "");
    const r = run();
    expect(calls()).not.toContain("plugins inspect");
    expect(r.stdout).toContain("unchanged since it was last verified");
  });

  it("re-verifies when the pinned core moves under an unchanged plugin", () => {
    run();
    writeFileSync(path.join(dir, "calls.log"), "");
    run(REPO, "2026.9.9");
    expect(calls()).toContain(`plugins inspect ${PLUGIN_ID} --runtime --json`);
  });

  it("re-verifies when the plugin's own bytes change", () => {
    run();
    // A checkout whose plugin differs by one byte — what an update delivers.
    const alt = mkdtempSync(path.join(tmpdir(), "oc-alt-root-"));
    try {
      const dst = path.join(alt, "scripts", "openclaw-plugins", PLUGIN_ID);
      mkdirSync(dst, { recursive: true });
      const src = path.join(REPO, "scripts/openclaw-plugins", PLUGIN_ID);
      for (const f of readdirSync(src)) {
        writeFileSync(path.join(dst, f), readFileSync(path.join(src, f), "utf-8"));
      }
      writeFileSync(path.join(dst, "index.mjs"), `${readFileSync(path.join(dst, "index.mjs"), "utf-8")}\n// v2\n`);
      writeFileSync(path.join(dir, "calls.log"), "");
      run(alt);
      expect(calls()).toContain(`plugins inspect ${PLUGIN_ID} --runtime --json`);
    } finally {
      rmSync(alt, { recursive: true, force: true });
    }
  });

  it("still reports a broken box on every boot, without paying the CLI again", () => {
    // The success stamp is written only on success, so a box whose hook never
    // registered keeps asking rather than settling for "checked once". But it
    // asks at a BOUNDED rate: the states that never register are mostly
    // PERMANENT (a build with no `plugins inspect`, a plugin the CLI cannot
    // resolve, an Orin that cannot module-load 44 plugins inside 45 s), and
    // paying a 10-45 s CLI cold start on every skill install, provider change
    // and crash for ever is the delay this file's header exists to prevent.
    stubOpenclaw(loadedInspection(["gateway_start"]));
    const first = run();
    expect(first.stderr).toMatch(/WARNING.*did not register both of its hooks/);
    writeFileSync(path.join(dir, "calls.log"), "");
    const second = run();
    // Silent it is not — only cheap.
    expect(second.stderr).toMatch(/WARNING.*did not confirm its hook/);
    expect(second.stderr).toContain("gateway_start");
    expect(calls()).not.toContain("plugins inspect");
  });

  it("asks again once the retry window has passed", () => {
    stubOpenclaw(loadedInspection(["gateway_start"]));
    run();
    ageAttempt(86_401);
    writeFileSync(path.join(dir, "calls.log"), "");
    const r = run();
    expect(calls()).toContain("plugins inspect");
    expect(r.stderr).toMatch(/WARNING.*did not register both of its hooks/);
  });

  it("asks again inside the window when the plugin's own bytes change", () => {
    // The backoff is keyed on the SAME hash as the success stamp, so an update
    // that ships a fixed plugin is never made to wait out a day.
    stubOpenclaw(loadedInspection(["gateway_start"]));
    run();
    writeFileSync(path.join(dir, "calls.log"), "");
    run(REPO, "2026.9.9");
    expect(calls()).toContain("plugins inspect");
  });

  it("clears the attempt stamp once the hook finally registers", () => {
    stubOpenclaw(loadedInspection(["gateway_start"]));
    run();
    expect(existsSync(attemptStamp())).toBe(true);
    stubOpenclaw(loadedInspection(BOTH_HOOKS));
    ageAttempt(86_401);
    run();
    expect(existsSync(attemptStamp())).toBe(false);
    expect(existsSync(verifiedStamp())).toBe(true);
  });

  it("keeps its bookkeeping out of the core's own plugin root", () => {
    // `~/.openclaw/extensions/` is the directory the loader enumerates.
    // ClawBox state goes beside it, not in it.
    run();
    expect(existsSync(verifiedStamp())).toBe(true);
    // The plugins ClawBox ships and NOTHING else — no stamp, no marker file.
    // The path guard is here because the shared installer copies both.
    expect(readdirSync(path.join(openclawHome, "extensions")).sort())
      .toEqual([PLUGIN_ID, "clawbox-path-guard"].sort());
  });

  it("re-verifies after a factory reset empties ~/.openclaw", () => {
    // `removeDirectoryContents(OPENCLAW_DIR)` (setup/reset/route.ts) reads
    // the directory with `fs.readdir`, which lists dot-entries — so the stamp
    // beside `extensions/` goes with the plugin it describes, exactly as it did
    // when it lived inside `extensions/`. The route then writes a fresh
    // openclaw.json back (the openclaw.json seed), which is why this does too.
    run();
    for (const entry of readdirSync(openclawHome)) {
      rmSync(path.join(openclawHome, entry), { recursive: true, force: true });
    }
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: {} } }));
    writeFileSync(path.join(dir, "calls.log"), "");
    const r = run();
    expect(calls()).toContain("plugins inspect");
    expect(r.stdout).toContain("reply_payload_sending and before_dispatch registered");
  });

  it("repairs a lost extensions tree without paying for the check again", () => {
    // The narrower case: `extensions/` went but the stamp did not. The plugin
    // is copied back byte for byte against the same pinned core, so the answer
    // the check would give cannot have changed — and the stamp is keyed on
    // exactly those two things. Re-running the CLI here would buy nothing and
    // cost the boot 10-45 s.
    run();
    rmSync(path.join(openclawHome, "extensions"), { recursive: true, force: true });
    writeFileSync(path.join(dir, "calls.log"), "");
    const r = run();
    expect(installed()).toHaveLength(5);
    expect(calls()).not.toContain("plugins inspect");
    expect(r.stdout).toContain("unchanged since it was last verified");
  });

  it("warns when the plugin loaded but registered no outbound hook", () => {
    // The false success: the config says enabled, `plugins list` would agree,
    // and every channel reply still carries the directive.
    stubOpenclaw(loadedInspection(["gateway_start"]));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*did not register both of its hooks/);
    expect(r.stderr).toContain("gateway_start");
  });

  it("warns when only one of the two hooks registered, and names the missing one", () => {
    // The half-loaded box is the one a count would call healthy. A plugin that
    // registered the outbound strip and not the inbound claim leaves the owner
    // typing "send AB2CD" at an agent that will explain it cannot help — with
    // nothing in the log to say why.
    stubOpenclaw(loadedInspection(["reply_payload_sending"]));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*did not register both of its hooks/);
    expect(r.stderr).toContain("missing=before_dispatch");
  });

  it("carries the core's own diagnostic when the plugin did not load", () => {
    stubOpenclaw(
      `cat <<'JSON'\n${JSON.stringify({
        plugin: { id: PLUGIN_ID, status: "error" },
        typedHooks: [],
        diagnostics: ["plugin manifest requires id"],
      })}\nJSON`,
    );
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("plugin manifest requires id");
  });

  it("does not read hookNames, which the core leaves empty", () => {
    // `plugin.hookNames` is [] even when hookCount is 5; the names live in the
    // top-level typedHooks[]. Reading the wrong one would warn on a plugin that
    // is working perfectly.
    stubOpenclaw(
      `cat <<'JSON'\n${JSON.stringify({
        plugin: { id: PLUGIN_ID, status: "loaded", hookCount: 2, hookNames: [] },
        typedHooks: BOTH_HOOKS.map((name) => ({ name })),
        diagnostics: [],
      })}\nJSON`,
    );
    const r = run();
    expect(r.stdout).toContain("reply_payload_sending and before_dispatch registered");
  });

  it("survives an openclaw that is missing, and still exits 0", () => {
    // An ExecStartPre under `set -euo pipefail`: a failing command substitution
    // in an assignment aborts the script, and the gateway would never start —
    // over a diagnostic.
    rmSync(path.join(binDir, "openclaw"));
    const r = run();
    expect(r.status).toBe(0);
    expect(readConfig().plugins?.entries?.[PLUGIN_ID]).toEqual({ enabled: true });
    expect(r.stderr).toMatch(/NOTE: the openclaw CLI could not be run/);
  });

  it.skipIf(process.getuid?.() === 0)("does not fail the gateway when the config cannot be written", () => {
    // ExecStartPre with no leading `-`, under `set -euo pipefail`: an
    // unwritable ~/.openclaw would otherwise fail the unit and leave the box
    // with no agent at all — over an optional directive strip.
    // Install once so `extensions/<id>/` exists and stays writable, then take
    // write permission off the config's own directory: the copy still lands and
    // only the atomic config write (mkstemp beside openclaw.json) fails.
    run();
    writeFileSync(configPath, JSON.stringify({ plugins: { entries: { deepseek: { enabled: true } } } }));
    chmodSync(openclawHome, 0o555);
    try {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/WARNING: could not enable/);
    } finally {
      chmodSync(openclawHome, 0o755);
    }
  });

  // ── The two ways the check can fail to answer, told apart ─────────────────
  //
  // These used to print the SAME mild NOTE, and one of them is the shape an
  // undiscovered plugin makes: this plugin is `cp`'d into `extensions/` rather
  // than installed, which is the core's lowest discovery tier, and an `inspect`
  // that cannot resolve a bare untracked id exits non-zero. "The whole OpenClaw
  // half does nothing" and "the CLI was unavailable" must not read alike.
  it("calls a CLI that could not run at all an UNKNOWN, not a defect", () => {
    // Exit 127 is `command not found`; 126 not executable; 124 is `timeout`
    // killing it. In none of them did the CLI have an opinion about us.
    stubOpenclaw("exit 127");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/NOTE: the openclaw CLI could not be run/);
    expect(r.stderr).toContain("exit 127");
    // "directives will still reach channels", said every boot about a box where
    // the hook is registered and working, is a false failure — and one the
    // operator learns to scroll past.
    expect(r.stderr).not.toMatch(/WARNING/);
  });

  it("calls a CLI that RAN and refused a defect, and names discovery", () => {
    stubOpenclaw('echo "unknown plugin: clawbox-email-directives" >&2; exit 3');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*may not be discovered at all/);
    // The CLI's own words, so an operator can tell which refusal this was.
    expect(r.stderr).toContain("unknown plugin: clawbox-email-directives");
    // A definite refusal is not an "unknown" verdict — this block must not
    // ALSO print one of its two NOTE lines over it. Scoped to this plugin's own
    // lines: the extract now carries the path guard's install too (see
    // `block()`), and that one says NOTE when the test PATH has no node, which
    // is a fact about the harness rather than about this refusal.
    expect(emailHookLines(r.stderr)).not.toMatch(/NOTE/);
  });

  it("calls a CLI that answered with something that is not JSON a defect", () => {
    stubOpenclaw('echo "not json at all"');
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*may not be discovered at all/);
    expect(r.stderr).toContain("not JSON");
  });

  it("asks again on the very NEXT boot when the CLI could not be run at all", () => {
    // 126/127 come back in microseconds — a failed `execve` — and they are the
    // most transient states on the box: `openclaw` absent or not yet executable
    // during the first boot after an update, a moved binary, a mid-update
    // restart. Backing off for a day over one would print a daily warning about
    // a plugin that is almost certainly loaded and working. So neither stamp is
    // written and the next boot asks properly.
    stubOpenclaw("exit 127");
    const first = run();
    expect(first.stderr).toMatch(/NOTE: the openclaw CLI could not be run/);
    expect(existsSync(verifiedStamp())).toBe(false);
    expect(existsSync(attemptStamp())).toBe(false);
    writeFileSync(path.join(dir, "calls.log"), "");
    const second = run();
    expect(calls()).toContain("plugins inspect");
    expect(second.stderr).not.toMatch(/WARNING/);
  });

  it("bounds a CLI that IGNORES SIGTERM, and backs off the ceiling it burned", () => {
    // The case `-k 5` exists for, driven against the real block with its
    // ceiling turned down. Two defects in one input:
    //
    //   the BOUND — plain `timeout` sends SIGTERM only, and an `openclaw` that
    //   ignores it keeps this command substitution's pipe open, so bash blocks
    //   reading that pipe until the SURVIVOR dies, not until `timeout` returns.
    //   This block is an ExecStartPre with no leading `-`: that stall is the
    //   gateway's start time and then the unit's failure, over a diagnostic.
    //
    //   the CODE — `timeout` signals its whole process group and SIGKILL cannot
    //   be ignored, so it kills ITSELF too and the caller reads 128+9 = 137,
    //   never 124. A classifier that knows only 124 drops exactly this input
    //   into the `*)` arm: "did not register reply_payload_sending — EMAIL:
    //   directives will still reach channels", about a hook that is very
    //   probably registered and working.
    //
    // And this one IS stamped: it burned the whole ceiling, and a box that
    // cannot module-load its plugins in that time will usually not manage it on
    // the next restart either.
    stubOpenclaw("trap '' TERM\nexec sleep 30");
    const started = Date.now();
    const first = runProgram(blockWithCeiling(1), REPO, "2026.8.1", {});
    // 1 s ceiling + the 5 s grace — nowhere near the stub's 30 s, which is what
    // an unbounded run would cost.
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(first.status).toBe(0);
    expect(first.stderr).toMatch(/NOTE: the openclaw CLI could not be run/);
    expect(first.stderr).toContain("cli-unavailable exit 137");
    expect(first.stderr).not.toMatch(/WARNING/);
    expect(existsSync(attemptStamp())).toBe(true);
    writeFileSync(path.join(dir, "calls.log"), "");
    // The STATUS is asserted before the call log: a script that aborted before
    // reaching `plugins inspect` would satisfy `not.toContain` for the wrong
    // reason, which is the false success this whole file guards against.
    const second = run();
    expect(second.status).toBe(0);
    // ...and the BRANCH is asserted too: a run that skipped the CLI for any
    // other reason (unreadable plugin sources, say) also exits 0 without an
    // inspect, so only the backoff message proves the 24 h stamp did the work.
    expect(second.stderr).toMatch(
      /did not confirm its hook[\s\S]*not repeating the check this boot/,
    );
    expect(calls()).not.toContain("plugins inspect");
  }, 60_000);

  it.each([["124"], ["137"]])(
    "asks again next boot when the CLI ended early with %s, rather than backing off a day",
    (code) => {
      // The other way both codes arrive, with this script's `timeout` nowhere
      // near it: an OOM-killed `plugins inspect` (it loads the whole core) is
      // 137 in three seconds, and a CLI that chose 124 as its own exit code is
      // 124 immediately. Stamping either buys a day of "not repeating the check
      // this boot" — a day of warning noise AND a day in which a hook that
      // genuinely stopped registering goes unreported — over one transient
      // spike. The evidence that tells them apart is what the run COST, not the
      // exit code, so this is classified like 126/127: a NOTE, and no stamp.
      stubOpenclaw(`exit ${code}`);
      const first = run();
      expect(first.status).toBe(0);
      expect(first.stderr).toContain(`cli-killed exit ${code}`);
      expect(first.stderr).toMatch(/answered within 5s/);
      expect(first.stderr).not.toMatch(/WARNING/);
      expect(existsSync(attemptStamp())).toBe(false);
      writeFileSync(path.join(dir, "calls.log"), "");
      const second = run();
      expect(calls()).toContain("plugins inspect");
      expect(second.stderr).not.toMatch(/WARNING/);
    },
  );

  it("DOES stamp an EXPENSIVE kill, even though our ceiling never fired", () => {
    // The third case, and the one splitting on the ceiling got wrong. The stamp
    // exists to bound COST — that is the whole reason 126/127 go unstamped, a
    // failed `execve` costing microseconds. A kill that burned real seconds is
    // expensive whoever sent it: the OOM killer picking `plugins inspect` (it
    // module-loads every enabled plugin, 44 of them on a paired box) at ~30-40 s
    // on a memory-tight Orin answers 137 without this script's `timeout` coming
    // near it. Leaving THAT unstamped puts those seconds back on the
    // ExecStartPre of every gateway restart — a skill install, a Telegram
    // reconfigure, a provider change, every crash — for ever, with the desktop
    // showing "Reload gateway" through all of it. That is the regression this
    // file's header exists to prevent.
    stubOpenclaw("sleep 6\nexit 137");
    const first = run();
    expect(first.status).toBe(0);
    // Stamped, and the verdict says what it cost rather than what killed it.
    expect(first.stderr).toContain("cli-unavailable exit 137");
    expect(first.stderr).toMatch(/after \d+s/);
    expect(first.stderr).not.toContain("cli-killed");
    expect(existsSync(attemptStamp())).toBe(true);
    // ...and the next start does not pay those seconds again.
    writeFileSync(path.join(dir, "calls.log"), "");
    // The STATUS is asserted before the call log: a script that aborted before
    // reaching `plugins inspect` would satisfy `not.toContain` for the wrong
    // reason, which is the false success this whole file guards against.
    const second = run();
    expect(second.status).toBe(0);
    // ...and the BRANCH is asserted too: a run that skipped the CLI for any
    // other reason (unreadable plugin sources, say) also exits 0 without an
    // inspect, so only the backoff message proves the 24 h stamp did the work.
    expect(second.stderr).toMatch(
      /did not confirm its hook[\s\S]*not repeating the check this boot/,
    );
    expect(calls()).not.toContain("plugins inspect");
  }, 60_000);

  it.skipIf(process.getuid?.() === 0)("leaves the installed plugin ALONE when it is the sources that cannot be read", () => {
    // `cp` opens its source first and never touches the destination when that
    // open fails, so a source-side problem — a checkout still being written by
    // the updater, a permission slip — leaves the last good plugin exactly
    // where it was. Removing it there would turn "the box keeps stripping with
    // what it already had" into "no plugin, and a config that names one".
    run();
    expect(installed()).toHaveLength(5);
    const bare = mkdtempSync(path.join(tmpdir(), "oc-unreadable-src-"));
    try {
      const src = path.join(bare, "scripts", "openclaw-plugins", PLUGIN_ID);
      mkdirSync(src, { recursive: true });
      for (const f of ["openclaw.plugin.json", "package.json", "index.mjs", "email-directives.mjs", "email-approvals.mjs"]) {
        writeFileSync(path.join(src, f), "x");
        chmodSync(path.join(src, f), 0o000);
      }
      const r = run(bare);
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/WARNING: could not read .* plugin sources/);
      expect(r.stderr).toContain("leaving whatever is already installed in place");
      expect(installed()).toHaveLength(5);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("removes a partial copy rather than leaving the gateway to import it", () => {
    // The other side: the sources read fine and the WRITE failed part-way, so
    // the destination is now a mixture of new, truncated and stale files while
    // `plugins.entries.<id>.enabled` is still true from the boot before. One
    // state, and a line that names it, beats a module that may throw halfway
    // through parsing. Provoked by making the third of the four targets a
    // directory, which `cp -f` cannot overwrite.
    run();
    const third = path.join(openclawHome, "extensions", PLUGIN_ID, "index.mjs");
    rmSync(third);
    mkdirSync(third);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING: could not install/);
    expect(r.stderr).toContain("has been removed rather than left for the gateway to import");
    expect(installed()).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)("says so when it could NOT remove the partial copy", () => {
    // The other arm of that same line, and the reason it is a line and not a
    // claim: `cp` truncates through the modes of files that already exist,
    // while `rm` needs the directory's write bit — so a destination the box
    // cannot write leaves a package missing a file, with
    // `plugins.entries.<id>.enabled` still true. Reporting that as a completed
    // cleanup is the false success this step exists to avoid. The Hermes twin
    // pins the same arm (register-mcp-email-hook.test.ts, the 0o555 case).
    run();
    const dst = path.join(openclawHome, "extensions", PLUGIN_ID);
    rmSync(path.join(dst, "openclaw.plugin.json")); // so `cp` must CREATE, and fails
    chmodSync(dst, 0o555);
    try {
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("could not remove what is there");
      expect(r.stderr).not.toContain("has been removed rather than left");
      expect(existsSync(dst)).toBe(true);
    } finally {
      chmodSync(dst, 0o755);
    }
  });

  // ── A CORRUPT attempt stamp must never cost the box its gateway ───────────
  //
  // These write the file BY HAND rather than letting the script write it: every
  // other attempt-stamp test uses one this script produced, which only ever
  // proves the script can read its own output. The stamp is rewritten on any
  // boot the check does not confirm, so it is regularly half-written when a box
  // loses power — which these boxes do.
  it.each([
    ["a leading-zero timestamp, which bash arithmetic reads as invalid octal", "deadbeef 0899 unregistered"],
    ["a leading-zero timestamp that IS valid octal", "deadbeef 0755 unregistered"],
    ["a timestamp far too large for one", `deadbeef ${"9".repeat(24)} unregistered`],
    ["a timestamp that is not a number at all", "deadbeef not-a-time unregistered"],
    ["a single field", "deadbeef"],
    ["an empty file", ""],
    ["a line with no fields but spaces", "   "],
    ["binary", "\u0000\u0001\u0002 \u0003 \u0004"],
  ])("exits 0 on an attempt stamp with %s", (_name, contents) => {
    run();
    writeFileSync(attemptStamp(), contents);
    // The success stamp has to be gone, or the attempt file is never read.
    rmSync(verifiedStamp(), { force: true });
    const r = run();
    // An ExecStartPre with no leading `-` under `set -euo pipefail`: a non-zero
    // status here fails the unit, and with Restart=always the gateway burns its
    // start limit and sits failed for the hour — over a DIAGNOSTIC.
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("value too great for base");
  });

  it("does not read an EMPTY recorded verdict as a box that passed", () => {
    // The verdict is also the "did we back off" answer, and an attempt line
    // whose verdict came back empty used to fall through to "unchanged since it
    // was last verified" — a box that failed the check reported as one that
    // passed it.
    run();
    const stamp = readFileSync(verifiedStamp(), "utf-8").trim();
    rmSync(verifiedStamp());
    writeFileSync(attemptStamp(), `${stamp} ${Math.floor(Date.now() / 1000)} \n`);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("unchanged since it was last verified");
    expect(r.stderr).toMatch(/WARNING: the last runtime check .* did not confirm its hook/);
    expect(r.stderr).toContain("no verdict recorded");
  });

  it("still verifies honestly when no temp file can be made for the CLI's stderr", () => {
    // The stderr capture must not become a way to FAIL: a redirection that
    // cannot be opened fails the command before it runs, and that would be
    // reported as the CLI refusing — i.e. "the plugin may not be discovered" —
    // on a box whose only real problem is a full /tmp.
    const r = run(REPO, "2026.8.1", { TMPDIR: path.join(dir, "no-such-tmpdir") });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("reply_payload_sending and before_dispatch registered");
    expect(r.stderr).not.toMatch(/may not be discovered/);
  });

  it("re-verifies when the set of OTHER enabled plugins changes", () => {
    // `inspect --runtime` module-loads every enabled plugin, so the answer also
    // depends on the plugin set — and ClawBox changes it after a good
    // verification (the Discord configure route and openclaw-config.ts both
    // write `plugins.entries`, and the gateway restarts). Without this, a
    // plugin added later that breaks the loader would stop ours registering
    // while the boot log claimed "unchanged since it was last verified".
    run();
    writeFileSync(path.join(dir, "calls.log"), "");
    const cfg = readConfig();
    cfg.plugins!.entries!["some-new-channel"] = { enabled: true };
    writeFileSync(configPath, JSON.stringify(cfg));
    run();
    expect(calls()).toContain("plugins inspect");
  });

  it("does not enable a plugin whose files are not in the checkout", () => {
    const bare = mkdtempSync(path.join(tmpdir(), "oc-bare-root-"));
    try {
      const r = run(bare);
      expect(r.status).toBe(0);
      expect(installed()).toEqual([]);
      expect(readConfig().plugins?.entries?.[PLUGIN_ID]).toBeUndefined();
      expect(r.stderr).toContain("not a complete plugin");
      // And it never asked the CLI about a plugin it did not install.
      expect(calls()).not.toContain("plugins inspect");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("does not overwrite a config it cannot parse", () => {
    writeFileSync(configPath, "{ this is not json");
    const r = run();
    expect(r.status).toBe(0);
    expect(readFileSync(configPath, "utf-8")).toBe("{ this is not json");
  });
});
