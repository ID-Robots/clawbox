import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The local embedding model (qwen3-embedding:0.6b) was fresh-install-only.
 *
 * `step_ollama_install` pulls it when a box is first built, and
 * `gateway-pre-start.sh` re-checks it detached on every gateway start — but no
 * update path ran it, and the boot check only helps if it happens to find
 * ollama awake. Two ways a box lost semantic memory for good:
 *
 *  - it was offline when it was flashed; or
 *  - the helper's single 5-second curl landed while ollama was still binding
 *    its port in the seconds after `systemctl restart ollama`. That branch is a
 *    silent no-op — no state written, no retry, no provisioning failure — so
 *    the box kept lexical FTS and looked healthy doing it.
 *
 * `ensure_local_embeddings` closes both, and `ollama_wait_ready` is the part
 * that must not overreach: it may wake a daemon the idle standby stopped, and
 * must NEVER start one the owner switched off.
 */
const REPO = process.cwd();
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = readFileSync(INSTALL_SH_PATH, "utf-8");
const NL = String.fromCharCode(10);

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf(`${NL}}`, start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

function shellCode(fn: string): string {
  return fn
    .split(NL)
    .filter((l) => !l.trim().startsWith("#"))
    .join(NL)
    .replace(new RegExp("\\\\" + NL + "\\s*", "g"), " ");
}

describe("the embedding model is repaired on an update, not only on a fresh install", () => {
  const POST_UPDATE = shellCode(extractShellFunction("step_post_update"));

  it("post_update calls it", () => {
    expect(POST_UPDATE).toMatch(/^\s*ensure_local_embeddings\b/m);
  });

  it("and cannot be failed by it", () => {
    // errexit is live and step bodies are called bare, so a missing embedding
    // model must never be the reason an update stops.
    const line = POST_UPDATE.split(NL).find((l) => l.trim().startsWith("ensure_local_embeddings"));
    expect(line).toBeDefined();
    expect(line).toContain("|| echo");
  });

  it("runs before the model step it sits beside, inside the same fixups", () => {
    expect(POST_UPDATE.indexOf("ensure_local_embeddings")).toBeLessThan(
      POST_UPDATE.indexOf("step_llamacpp_model"),
    );
  });

  it("leaves step_ollama_install's if/elif chain intact and waits before the helper", () => {
    // That region is ONE if/elif/elif/else/fi. An edit that removed a branch
    // header would leave the rest dangling, so the readiness wait goes INSIDE
    // the existing arm, ahead of the call it protects.
    const OLLAMA = shellCode(extractShellFunction("step_ollama_install"));
    expect(OLLAMA).toContain('if ! has_openclaw_harness; then');
    expect(OLLAMA).toContain('elif [ -x "$ENSURE_EMBEDDINGS" ]; then');
    expect(OLLAMA.indexOf("ollama_wait_ready")).toBeLessThan(
      OLLAMA.indexOf('as_clawbox_login "$ENSURE_EMBEDDINGS"'),
    );
  });

  it("probes the URL the helper itself probes", () => {
    // `localhost` and `127.0.0.1` are not the same address on a box whose
    // resolver answers ::1 first — two spellings would let this certify a
    // daemon the helper then cannot reach, and the wait would buy nothing.
    const WAIT = shellCode(extractShellFunction("ollama_wait_ready"));
    expect(WAIT).toContain("OLLAMA_TAGS_URL");
    const helper = readFileSync(path.join(REPO, "scripts/ensure-local-embeddings.sh"), "utf-8");
    const dflt = helper.match(/OLLAMA_TAGS_URL="\$\{OLLAMA_TAGS_URL:-([^}"]+)\}"/);
    expect(dflt, "helper must declare a default this can share").not.toBeNull();
    expect(WAIT).toContain(dflt![1]);
  });
});

/**
 * The behaviour that matters most cannot be read out of a regex: whether this
 * respects the owner. Drive the real functions against stub systemctl/curl.
 */
describe("ollama_wait_ready — behaviour, driven against stubs", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embed-ready-"));
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /**
   * @param enabled what `systemctl is-enabled` answers — "enabled" is a box the
   *   owner left on, "disabled" is one they switched off in Local AI.
   * @param active  whether the unit is already up.
   * @param answers whether the API answers at all.
   */
  function run({ enabled = "enabled", active = false, answers = true, exists = true } = {}) {
    const log = path.join(tmp, "systemctl.log");
    fs.writeFileSync(log, "");
    fs.writeFileSync(
      path.join(tmp, "bin", "systemctl"),
      [
        "#!/bin/sh",
        'printf "%s\\n" "$*" >> "$LOG"',
        'case "$1" in',
        '  cat) [ "$EXISTS" = "1" ] && exit 0 || exit 1 ;;',
        '  is-enabled) [ "$ENABLED" = "enabled" ] && exit 0 || exit 1 ;;',
        '  is-active) [ "$ACTIVE" = "1" ] && exit 0 || exit 1 ;;',
        "esac",
        "exit 0",
        "",
      ].join(NL),
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(tmp, "bin", "curl"),
      `#!/bin/sh${NL}[ "$ANSWERS" = "1" ] && exit 0 || exit 1${NL}`,
      { mode: 0o755 },
    );
    // A real `sleep` would make the not-answering case take the full budget.
    fs.writeFileSync(path.join(tmp, "bin", "sleep"), `#!/bin/sh${NL}exit 0${NL}`, { mode: 0o755 });

    const script = [
      "set -euo pipefail",
      `export PATH="${tmp}/bin:$PATH"`,
      `sed -n '/^ollama_wait_ready() {/,/^}/p' "$1" > "${tmp}/fn.sh"`,
      `. "${tmp}/fn.sh"`,
      "rc=0; ollama_wait_ready 4 || rc=$?; echo \"RC=$rc\"; [ $rc -eq 0 ] && echo READY || echo NOTREADY",
    ].join(NL);
    let out: string;
    let code = 0;
    try {
      out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          LOG: log,
          ENABLED: enabled,
          ACTIVE: active ? "1" : "0",
          ANSWERS: answers ? "1" : "0",
          EXISTS: exists ? "1" : "0",
        },
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return { out, code, calls: fs.readFileSync(log, "utf8").split(NL).filter(Boolean) };
  }

  it("wakes a daemon the idle standby merely stopped", () => {
    // The runtime's standby is `stop`, never `disable` — an enabled-but-inactive
    // unit is asleep, and waking it is exactly what this is for.
    const r = run({ enabled: "enabled", active: false, answers: true });
    expect(r.out).toContain("READY");
    expect(r.calls.some((c) => c.startsWith("start ollama.service"))).toBe(true);
  });

  it("reports a switched-off engine apart from an unreachable one", () => {
    // Both are "not ready", but only one is a connectivity problem. Sharing a
    // code made the callers print "Ollama is not reachable" directly under
    // "Ollama is switched off on this box", contradicting it. Reported by
    // CodeRabbit on #648.
    expect(run({ enabled: "disabled" }).out).toContain("RC=2");
    expect(run({ enabled: "enabled", active: true, answers: false }).out).toContain("RC=1");
  });

  it("NEVER starts a daemon the owner switched off", () => {
    // Local AI's off switch is `systemctl disable --now`. `is-active` cannot
    // tell that apart from the idle standby; `is-enabled` is the only thing
    // that can. Starting here would reverse the owner's own decision.
    const r = run({ enabled: "disabled", active: false, answers: true });
    expect(r.out).toContain("NOTREADY");
    expect(r.calls.some((c) => c.startsWith("start ollama.service"))).toBe(false);
  });

  it("does not re-start a daemon that is already up", () => {
    const r = run({ enabled: "enabled", active: true, answers: true });
    expect(r.out).toContain("READY");
    expect(r.calls.some((c) => c.startsWith("start ollama.service"))).toBe(false);
  });

  it("gives up rather than hanging when the API never answers", () => {
    const r = run({ enabled: "enabled", active: true, answers: false });
    expect(r.out).toContain("NOTREADY");
    expect(r.code).toBe(0);
  });

  it("says no on a box with no ollama unit at all", () => {
    const r = run({ exists: false });
    expect(r.out).toContain("NOTREADY");
  });
});

describe("ensure_local_embeddings never fails the update", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "embed-ensure-"));
    fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "bin", "sleep"), `#!/bin/sh${NL}exit 0${NL}`, { mode: 0o755 });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /** @param hermes edition without a core; @param helper whether the script is there */
  function run({ hermes = false, helper = true, testMode = false, ready = true } = {}) {
    const project = path.join(tmp, "project");
    fs.mkdirSync(path.join(project, "scripts"), { recursive: true });
    if (helper) {
      fs.writeFileSync(
        path.join(project, "scripts", "ensure-local-embeddings.sh"),
        `#!/bin/sh${NL}echo HELPER_RAN${NL}`,
        { mode: 0o755 },
      );
    }
    const script = [
      "set -euo pipefail",
      `export PATH="${tmp}/bin:$PATH"`,
      `PROJECT_DIR="${project}"`,
      `is_test_mode() { ${testMode ? "return 0" : "return 1"}; }`,
      `has_openclaw_harness() { ${hermes ? "return 1" : "return 0"}; }`,
      `ollama_wait_ready() { ${ready ? "return 0" : "return 1"}; }`,
      // as_clawbox_login runs a command string as the clawbox user; here, us.
      'as_clawbox_login() { eval "$*"; }',
      `sed -n '/^ensure_local_embeddings() {/,/^}/p' "$1" > "${tmp}/fn.sh"`,
      `. "${tmp}/fn.sh"`,
      "ensure_local_embeddings; echo RC=$?",
    ].join(NL);
    let out: string;
    let code = 0;
    try {
      out = execFileSync("bash", ["-c", script, "bash", INSTALL_SH_PATH], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      code = err.status ?? 1;
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
    }
    return { out, code };
  }

  it("runs the helper on a healthy OpenClaw box", () => {
    const r = run();
    expect(r.out).toContain("HELPER_RAN");
    expect(r.out).toContain("RC=0");
  });

  it("bounds the pull so it cannot hold a quiesced gateway open for ever", () => {
    // post_update carries a 900s budget and stops the gateway while it runs; a
    // first-time ~639 MB pull needs a ceiling of its own.
    expect(shellCode(extractShellFunction("ensure_local_embeddings"))).toMatch(/timeout -k \d+ \d+/);
  });

  for (const [name, opts] of [
    ["a hermes box with no core to point at the model", { hermes: true }],
    ["a checkout whose helper is missing", { helper: false }],
    ["the e2e container", { testMode: true }],
    ["a box whose ollama never answers", { ready: false }],
  ] as const) {
    it(`returns 0 on ${name}`, () => {
      const r = run(opts);
      expect(r.out).toContain("RC=0");
      expect(r.code).toBe(0);
      if ((opts as { helper?: boolean }).helper === false || (opts as { hermes?: boolean }).hermes
        || (opts as { testMode?: boolean }).testMode || (opts as { ready?: boolean }).ready === false) {
        expect(r.out).not.toContain("HELPER_RAN");
      }
    });
  }
});
