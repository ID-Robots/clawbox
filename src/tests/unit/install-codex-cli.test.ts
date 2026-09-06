import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";

// Starts a real bash: vitest's 5 s test and 10 s hook defaults are not enough
// on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/**
 * How the OpenAI Codex CLI reaches a device (TASK-439).
 *
 * Every box in the field carries Codex as an npm global — `npm i -g
 * @openai/codex` into ~/.npm-global. The owner's ruling on TASK-378 was the
 * NATIVE installer for both coding CLIs, and the sibling coding CLI (TASK-378)
 * already ships that way; this file pins the Codex half so it cannot drift back
 * to npm, and pins the four things that half has to get right:
 *
 *   1. the vendor's own installer, at a PINNED release whose script is
 *      checksum-verified before anything executes it;
 *   2. exactly ONE codex on PATH — ~/.bashrc puts ~/.npm-global/bin BEFORE
 *      ~/.local/bin, so the native binary is shadowed until the npm one is gone;
 *   3. the npm copy removed only over a native install that actually verified,
 *      never over one that merely exited 0;
 *   4. delivered from step_post_update, not fresh-install-only — the failure
 *      mode that left the whole fleet without the sibling CLI for months.
 */

const REPO = path.resolve(__dirname, "../../..");
const INSTALL_SH_PATH = path.join(REPO, "install.sh");
const INSTALL_SH = fs.readFileSync(INSTALL_SH_PATH, "utf-8");
const INSTALL_X64 = fs.readFileSync(path.join(REPO, "install-x64.sh"), "utf-8");
const PIN_PATH = path.join(REPO, "config", "codex-target.txt");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function extractShellFunctionFrom(source: string, name: string): string {
  const start = source.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return `${source.slice(start, end)}\n}`;
}

function extractShellFunction(name: string): string {
  return extractShellFunctionFrom(INSTALL_SH, name);
}

/** A shell function's code with its comments stripped, so a comment mentioning
 *  `npm i -g` cannot satisfy — or break — an assertion about what it RUNS. */
function shellCode(fn: string): string {
  return fn
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
}

function bashArray(source: string, name: string): string[] {
  const start = source.indexOf(`${name}=(`);
  if (start < 0) throw new Error(`${name} not found`);
  const end = source.indexOf("\n)", start);
  return source
    .slice(start + `${name}=(`.length, end)
    .split("\n")
    .flatMap((l) => l.replace(/#.*$/, "").trim().split(/\s+/))
    .filter(Boolean);
}

/** The pin as config/codex-target.txt spells it: `<version> <sha256>`. */
function readPin(): { version: string; sha256: string } {
  const line = fs
    .readFileSync(PIN_PATH, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (!line) throw new Error("config/codex-target.txt carries no pin line");
  const [version, sha256] = line.split(/\s+/);
  return { version, sha256 };
}

describe("the Codex CLI is pinned, in one place both installers read", () => {
  it("config/codex-target.txt carries a version and the installer's sha256", () => {
    // One file, the way config/openclaw-target.txt pins the core: install.sh
    // and install-x64.sh both install Codex, and a version that can drift
    // between two shell files is a fleet running two builds.
    const { version, sha256 } = readPin();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("both installers read the pin file rather than carrying their own copy", () => {
    expect(INSTALL_SH).toContain("config/codex-target.txt");
    expect(INSTALL_X64).toContain("config/codex-target.txt");
  });

  it("neither installer installs Codex from npm any more", () => {
    // The whole card: `npm i -g @openai/codex` is what put an unpinned,
    // unverified Codex on every box.
    expect(shellCode(INSTALL_SH)).not.toContain("npm i -g @openai/codex");
    expect(shellCode(INSTALL_X64)).not.toContain("npm i -g @openai/codex");
  });
});

describe("Codex is installed the way OpenAI supports", () => {
  // Extracted per test, not once at collection: a missing function then fails
  // each assertion it breaks instead of taking the whole file down with it.
  const ensure = () => extractShellFunction("ensure_codex_cli");

  it("uses the vendor's own installer, from an immutable release asset", () => {
    // https://chatgpt.com/codex/install.sh is what OpenAI documents, and it is
    // byte-identical to the install.sh asset attached to each release tag. The
    // documented URL always serves `latest` and is not checksummable; the
    // release asset is immutable, so that is what the pin can name.
    const fn = ensure();
    expect(fn).toContain("https://github.com/openai/codex/releases/download/rust-v");
    expect(fn).toContain("install.sh");
  });

  it("verifies the installer's sha256 BEFORE running it", () => {
    const fn = ensure();
    const digest = fn.indexOf("sha256sum");
    const run = fn.indexOf("sh '$installer'");
    expect(digest).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(-1);
    expect(digest).toBeLessThan(run);
  });

  it("pins the release the installer resolves, so it cannot drift to latest", () => {
    // The installer's own knob (`--release` / CODEX_RELEASE, from its --help).
    const fn = ensure();
    expect(fn).toMatch(/CODEX_RELEASE=|--release/);
    expect(fn).toContain("CODEX_NON_INTERACTIVE=true");
  });

  it("hands the downloaded installer to the user that will execute it, after the download", () => {
    // The two hardware failures the sibling CLI (TASK-378) already paid for, in
    // order: mktemp makes the file root:root 0600 and it is executed AS the
    // clawbox user, so without the chown every run answers "Permission denied";
    // and with the chown moved before the curl, fs.protected_regular=2 stops
    // even root writing a file it does not own in sticky /tmp and curl exits 23.
    const fn = ensure();
    const chown = 'chown "$CLAWBOX_USER" "$installer"';
    expect(fn).toContain(chown);
    expect(fn.indexOf("curl")).toBeLessThan(fn.indexOf(chown));
    expect(fn.indexOf(chown)).toBeLessThan(fn.indexOf("sh '$installer'"));
  });

  it("probes with a login shell, never `sudo -u clawbox bash -c`", () => {
    // Non-login and non-interactive reads neither ~/.profile nor ~/.bashrc, so
    // it answers "missing" on a box where the tool works — the false negative
    // that made the sibling CLI's fast path dead for months.
    const fn = ensure();
    expect(shellCode(fn)).not.toContain("sudo -u");
    expect(fn).toContain("as_clawbox_login");
  });

  it("keeps the standalone package out of ~/.codex, which a factory reset wipes", () => {
    // The vendor installer unpacks under $CODEX_HOME/packages/standalone, and
    // ~/.codex is on the reset REMOVE-list (HOME_REMOVE_PATHS in
    // src/app/setup-api/setup/reset/route.ts). Left at the default, a factory
    // reset would delete the BINARY along with the credentials and leave
    // ~/.local/bin/codex dangling on a box that has just rebooted into AP mode
    // with no internet to re-download 117 MB.
    const fn = ensure();
    expect(INSTALL_SH).toContain('CODEX_PACKAGE_HOME="$CLAWBOX_HOME/.local/share/codex"');
    expect(fn).toContain("CODEX_HOME=");
    expect(fn).not.toContain('CODEX_HOME="$CLAWBOX_HOME/.codex"');
  });
});

describe("delivery to devices already in the field", () => {
  it("post_update installs it, so an in-app update is enough", () => {
    // Fresh-install-only delivery is this installer's default failure mode:
    // step_post_update never called step_ai_tools_install, which is why no
    // shipped box had the sibling CLI on it.
    expect(extractShellFunction("step_post_update")).toContain("step_codex_cli");
  });

  it("post_update cannot be aborted by it", () => {
    const line = extractShellFunction("step_post_update")
      .split("\n")
      .find((l) => l.includes("step_codex_cli"));
    expect(line).toMatch(/\|\|\s*echo/);
  });

  it("a fresh install ships it too", () => {
    expect(shellCode(extractShellFunction("step_ai_tools_install"))).toContain("ensure_codex_cli");
  });

  it("is dispatchable on its own, so a box can repair Codex without a reinstall", () => {
    expect(bashArray(INSTALL_SH, "DISPATCH_STEPS")).toContain("codex_cli");
  });

  it("exactly one function installs it, so the paths cannot drift", () => {
    const callers = INSTALL_SH.split("\n").filter(
      (l) => l.includes("ensure_codex_cli") && !l.trim().startsWith("#") && !l.includes("() {"),
    );
    expect(callers).toHaveLength(2); // step_ai_tools_install + step_codex_cli
  });
});

// ── Behaviour, against the shipped functions ────────────────────────────────

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-codex-cli-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

type Run = {
  status: number;
  output: string;
  calls: string[];
  nativeExists: boolean;
  npmExists: boolean;
};

/**
 * Drive the shipped `ensure_codex_cli` against a box modelled in $tmp.
 *
 * The stubs are the three seams the function actually crosses: `curl` (the
 * download), `chown` (the root->clawbox hand-off) and `as_clawbox_login`
 * (everything that runs as the owner). `as_clawbox_login` models the box's real
 * PATH order — ~/.npm-global/bin ahead of ~/.local/bin — so a test can tell a
 * shadowed native binary from a resolved one.
 */
function runEnsure(opts: {
  /** What the stub curl writes; "" means the download fails. */
  payload?: string;
  /** Version the installed native binary reports. Defaults to the pin. */
  installedVersion?: string;
  /** Does the vendor installer succeed at producing the binary? */
  installerWorks?: boolean;
  /** Does `npm uninstall` actually remove the npm copy? */
  npmUninstallWorks?: boolean;
  /** Is the native binary already there before the run? */
  preinstalledVersion?: string;
  /** Is the npm copy there before the run? */
  npmPresent?: boolean;
  /** Pin file contents; defaults to the repo's real pin. */
  pin?: string;
}): Run {
  const {
    payload = "",
    installerWorks = true,
    npmUninstallWorks = true,
    npmPresent = true,
  } = opts;
  const pinned = readPin();
  const home = path.join(tmp, "home");
  const npmPrefix = path.join(home, ".npm-global");
  const nativeBin = path.join(home, ".local", "bin", "codex");
  const calls = path.join(tmp, "calls");
  const payloadFile = path.join(tmp, "payload");
  const projectDir = path.join(tmp, "project");

  fs.mkdirSync(path.dirname(nativeBin), { recursive: true });
  fs.mkdirSync(path.join(npmPrefix, "bin"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, "config"), { recursive: true });
  fs.writeFileSync(calls, "");
  fs.writeFileSync(payloadFile, payload);
  fs.writeFileSync(
    path.join(projectDir, "config", "codex-target.txt"),
    opts.pin ?? `${pinned.version} ${pinned.sha256}\n`,
  );
  if (npmPresent) fs.writeFileSync(path.join(npmPrefix, "bin", "codex"), "#!/usr/bin/env node\n", { mode: 0o755 });
  if (opts.preinstalledVersion) fs.writeFileSync(nativeBin, "native\n", { mode: 0o755 });

  const installedVersion = opts.installedVersion ?? opts.preinstalledVersion ?? pinned.version;

  const script = [
    "set -euo pipefail",
    `CLAWBOX_HOME=${JSON.stringify(home)}`,
    'CLAWBOX_USER="$(id -un)"',
    `NPM_PREFIX=${JSON.stringify(npmPrefix)}`,
    `PROJECT_DIR=${JSON.stringify(projectDir)}`,
    `CODEX_NATIVE_BIN=${JSON.stringify(nativeBin)}`,
    'CODEX_PACKAGE_HOME="$CLAWBOX_HOME/.local/share/codex"',
    `CALLS=${JSON.stringify(calls)}`,
    `PAYLOAD=${JSON.stringify(payloadFile)}`,
    `INSTALLED_VERSION=${JSON.stringify(installedVersion)}`,
    `INSTALLER_WORKS=${installerWorks ? 1 : 0}`,
    `NPM_UNINSTALL_WORKS=${npmUninstallWorks ? 1 : 0}`,
    // The stub curl: writes $PAYLOAD to the -o path, or fails when it is empty.
    "curl() {",
    '  printf "curl %s\\n" "$*" >> "$CALLS"',
    '  local out=""; local prev=""',
    '  for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done',
    '  [ -s "$PAYLOAD" ] || return 22',
    '  cat "$PAYLOAD" > "$out"',
    "}",
    "chown() {",
    '  printf "chown %s\\n" "$*" >> "$CALLS"',
    "}",
    // The box, as the owner sees it.
    "as_clawbox_login() {",
    '  printf "login %s\\n" "$*" >> "$CALLS"',
    '  case "$*" in',
    '    *"sh \'"*)',
    '      [ "$INSTALLER_WORKS" = 1 ] || return 1',
    '      printf "#!/bin/sh\\n" > "$CODEX_NATIVE_BIN"; chmod 0755 "$CODEX_NATIVE_BIN"',
    "      return 0 ;;",
    '    *"npm uninstall"*)',
    '      [ "$NPM_UNINSTALL_WORKS" = 1 ] || return 1',
    '      rm -f "$NPM_PREFIX/bin/codex"; return 0 ;;',
    '    *"--version"*)',
    '      [ -x "$CODEX_NATIVE_BIN" ] || return 127',
    '      printf "codex-cli %s\\n" "$INSTALLED_VERSION"; return 0 ;;',
    '    *"command -v codex"*)',
    // The login shell's real PATH order: the npm copy wins while it exists.
    '      if [ -x "$NPM_PREFIX/bin/codex" ]; then printf "%s\\n" "$NPM_PREFIX/bin/codex"; return 0; fi',
    '      if [ -x "$CODEX_NATIVE_BIN" ]; then printf "%s\\n" "$CODEX_NATIVE_BIN"; return 0; fi',
    "      return 1 ;;",
    "  esac",
    "  return 0",
    "}",
    extractShellFunction("codex_pin_field"),
    extractShellFunction("npm_codex_present"),
    extractShellFunction("codex_native_is_current"),
    extractShellFunction("remove_npm_codex"),
    extractShellFunction("codex_left_as_is"),
    extractShellFunction("ensure_codex_cli"),
    'ensure_codex_cli || echo "rc=$?"',
  ].join("\n");

  const r = spawnSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: testEnv({ PATH: process.env.PATH ?? "" }),
  });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return {
    status: /rc=(\d+)/.exec(output) ? Number(/rc=(\d+)/.exec(output)![1]) : (r.status ?? -1),
    output,
    calls: fs.readFileSync(calls, "utf-8").split("\n").filter(Boolean),
    nativeExists: fs.existsSync(nativeBin),
    npmExists: fs.existsSync(path.join(npmPrefix, "bin", "codex")),
  };
}

d("a download that did not happen never deletes the working Codex", () => {
  it("keeps the npm copy when the installer cannot be downloaded", () => {
    const r = runEnsure({ payload: "" });
    expect(r.status).not.toBe(0);
    expect(r.npmExists).toBe(true);
    expect(r.calls.join("\n")).not.toContain("npm uninstall");
    expect(r.output).toMatch(/Keeping the npm-installed Codex/);
  });

  it("refuses an installer whose digest is not the pinned one, and runs nothing", () => {
    const r = runEnsure({ payload: "#!/bin/sh\necho not the pinned installer\n" });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/pinned sha256|does not match/i);
    // Nothing was executed: the only login calls are probes.
    expect(r.calls.filter((c) => c.includes("sh '"))).toHaveLength(0);
    expect(r.npmExists).toBe(true);
  });

  it("keeps the npm copy when the installer exits 0 without producing the pinned version", () => {
    const body = "#!/bin/sh\ntrue\n";
    const sha = createHash("sha256").update(body).digest("hex");
    const r = runEnsure({
      payload: body,
      pin: `${readPin().version} ${sha}\n`,
      installedVersion: "0.0.1",
    });
    expect(r.status).not.toBe(0);
    expect(r.npmExists).toBe(true);
    expect(r.output).toMatch(/does not report/i);
  });
});

d("a verified native install leaves exactly one codex on PATH", () => {
  it("installs the pinned release, then removes the npm copy", () => {
    const body = "#!/bin/sh\ntrue\n";
    const sha = createHash("sha256").update(body).digest("hex");
    const pin = readPin();
    const r = runEnsure({ payload: body, pin: `${pin.version} ${sha}\n` });
    expect(r.status).toBe(0);
    expect(r.nativeExists).toBe(true);
    expect(r.npmExists).toBe(false);
    const login = r.calls.filter((c) => c.startsWith("login ")).join("\n");
    expect(login).toContain(`CODEX_RELEASE='${pin.version}'`);
    expect(login).toContain("npm uninstall -g @openai/codex");
    // The removal comes after the install, never before: a box that loses the
    // download must not be left with no codex at all.
    expect(login.indexOf("sh '")).toBeLessThan(login.indexOf("npm uninstall"));
  });

  it("says so when the npm copy survives, because it still shadows the native binary", () => {
    const body = "#!/bin/sh\ntrue\n";
    const sha = createHash("sha256").update(body).digest("hex");
    const r = runEnsure({
      payload: body,
      pin: `${readPin().version} ${sha}\n`,
      npmUninstallWorks: false,
    });
    expect(r.status).not.toBe(0);
    expect(r.output).toMatch(/shadow/i);
  });

  it("re-tries the removal on a later run without downloading anything again", () => {
    // The convergence case: a previous run installed the binary and failed to
    // remove the npm copy. Nothing needs downloading — but the box still has
    // two codexes, and the step has to finish the job.
    const pin = readPin();
    const r = runEnsure({ preinstalledVersion: pin.version, payload: "" });
    expect(r.calls.filter((c) => c.startsWith("curl "))).toHaveLength(0);
    expect(r.npmExists).toBe(false);
    expect(r.status).toBe(0);
  });
});

d("the pin itself is what is trusted", () => {
  it("installs nothing when config/codex-target.txt is not a usable pin", () => {
    const r = runEnsure({ pin: "# no pin here\n", payload: "whatever" });
    expect(r.status).not.toBe(0);
    expect(r.calls.filter((c) => c.startsWith("curl "))).toHaveLength(0);
    expect(r.npmExists).toBe(true);
  });
});
