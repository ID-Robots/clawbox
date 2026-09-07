import { describe, it, expect, vi } from "vitest";
import fs, { readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

// The staging cases below start a real bash: vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** These cases start a real bash; skip where there is none. */
let hasBash = true;
try {
  execFileSync("/bin/bash", ["-c", "true"], { stdio: "ignore" });
} catch {
  hasBash = false;
}

// These pin the install-time invariants of the single-harness edition lock.
// Every one of them describes a bug that shipped: a drift guard that hard-exit
// 1'd on both SKUs, a Hermes appliance that kept an unauthenticated OpenClaw
// gateway on 0.0.0.0:18789, an "edition lock" that a customer could override
// from a file they own, and step functions that called a `log` helper defined
// hundreds of lines below the dispatch block that invokes them.

const REPO = process.cwd();
const INSTALL_SH = readFileSync(path.join(REPO, "install.sh"), "utf-8");
const SETUP_UNIT = readFileSync(path.join(REPO, "config/clawbox-setup.service"), "utf-8");
const UPDATE_UNIT = readFileSync(path.join(REPO, "config/clawbox-root-update@.service"), "utf-8");
const HERMES_EDITION_SH = readFileSync(path.join(REPO, "scripts/setup-hermes-edition.sh"), "utf-8");

/** Contents of a bash array literal `NAME=( … )`, as trimmed entries. */
function bashArray(name: string): string[] {
  const start = INSTALL_SH.indexOf(`${name}=(`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n)", start);
  if (end < 0) throw new Error(`${name} has no closing paren`);
  return INSTALL_SH.slice(start + `${name}=(`.length, end)
    .split("\n")
    .map((l) => l.replace(/#.*$/, "").trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

function extractShellFunction(name: string): string {
  const start = INSTALL_SH.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`${name} not found in install.sh`);
  const end = INSTALL_SH.indexOf("\n}", start);
  if (end < 0) throw new Error(`${name} has no closing brace`);
  return INSTALL_SH.slice(start, end);
}

describe("service drift guard is edition-aware (C2)", () => {
  const shippedUnits = readdirSync(path.join(REPO, "config"))
    .filter((f) => f.endsWith(".service") || f.endsWith(".timer"));

  it("every unit shipped in config/ is registered somewhere", () => {
    const registered = new Set([
      ...bashArray("EXPECTED_ACTIVE_SERVICES"),
      ...bashArray("EXPECTED_INSTALLED_SERVICES"),
      ...bashArray("EDITION_SCOPED_UNITS"),
    ]);
    // The guard's whole job: a new config/*.service that nobody wired up must
    // be an error, not a silent no-op on fresh devices.
    for (const unit of shippedUnits) expect(registered.has(unit)).toBe(true);
  });

  it("the guard checks the edition-aware registry, not the install list", () => {
    // Checking ALL_SERVICES made install.sh `exit 1` on EVERY edition: openclaw
    // has no Hermes units in its lists, hermes has no gateway in its lists.
    // Both paths run from step_system_config on a fresh install AND from
    // post_update on the in-app updater.
    const fn = extractShellFunction("step_systemd_services");
    expect(fn).toContain('for svc in "${KNOWN_UNITS[@]}"');
    expect(fn).toContain('KNOWN_UNITS=("${ALL_SERVICES[@]}" "${EDITION_SCOPED_UNITS[@]}")');
  });

  it("edition-scoped units stay OUT of the cp/enable lists", () => {
    // step_systemd_services cp's and `systemctl enable`s every entry of
    // ALL_SERVICES. Registering the Hermes units there to satisfy the guard
    // would crash-loop them on every OpenClaw box in the field (Restart=always
    // against a hermes binary that isn't installed), and registering the
    // gateway there would re-enable it on Hermes.
    const installed = new Set(bashArray("EXPECTED_INSTALLED_SERVICES"));
    for (const unit of bashArray("EDITION_SCOPED_UNITS")) {
      expect(installed.has(unit)).toBe(false);
    }
  });
});

describe("Hermes SKU removes the OpenClaw gateway (H1)", () => {
  it("stops, disables AND masks it — disable alone is defeatable", () => {
    // config/clawbox-sudoers grants the clawbox user NOPASSWD
    // `systemctl start clawbox-gateway`, reachable from the in-UI terminal,
    // SSH and the agent's run_command. Only a mask blocks that.
    const fn = extractShellFunction("step_edition_gateway_state");
    expect(fn).toMatch(/systemctl stop "\$unit"/);
    expect(fn).toMatch(/systemctl disable "\$unit"/);
    expect(fn).toMatch(/systemctl mask "\$unit"/);
    // `mask` refuses while a real unit file exists in /etc/systemd/system.
    expect(fn).toMatch(/rm -f "\/etc\/systemd\/system\/\$unit"/);
    // Non-hermes re-install must clear the mask, or the later cp would write
    // the unit straight into /dev/null.
    expect(fn).toMatch(/systemctl unmask "\$unit"/);
  });

  it("is re-asserted by the standalone provisioning script too", () => {
    expect(HERMES_EDITION_SH).toContain("systemctl mask clawbox-gateway.service");
  });

  it("install-time validation asserts the gateway is gone", () => {
    // The only automated guard that H1 stays fixed.
    const fn = extractShellFunction("step_validate_services");
    expect(fn).toContain("clawbox-gateway.service is ACTIVE");
  });
});

describe("edition persistence (H7 / H9)", () => {
  it("is written to a root-owned file, for all three editions", () => {
    const fn = extractShellFunction("step_edition_lock");
    expect(fn).toContain('install -d -o root -g root -m 0755 /etc/clawbox');
    // Root ownership and the mode now come from `install_root_file` — the same
    // atomic writer every other root-owned file goes through — rather than a
    // chown after a truncating redirect.
    expect(fn).toContain('install_root_file "$_edition_tmp" "$CLAWBOX_EDITION_FILE" 0644');
    // No `case … dual) return 0`: dual used to bake nothing at all, so the
    // premium SKU silently ran as openclaw and could not be provisioned.
    expect(fn).not.toMatch(/case "\$CLAWBOX_EDITION"/);
  });

  it("is never observable half-written, in either record", () => {
    // `> file` is open(O_TRUNC) + write + close, and this step runs on EVERY
    // in-app update while the middleware, `openclawIsAbsent()`, the updater's
    // own `hasHermesHarness()` and the MCP server are reading the lock: a
    // reader that lands inside the write gets a zero-length file, which
    // `readEditionSource()` answers as `{edition: "openclaw", defaulted: true}`
    // — a Hermes box briefly reporting itself as the flagship SKU. A rename
    // within a directory cannot be observed half-done, and the repo already
    // ships that writer (TASK-584).
    const fn = extractShellFunction("step_edition_lock");
    expect(fn).not.toMatch(/>\s*"\$CLAWBOX_EDITION_FILE"/);
    expect(fn).not.toMatch(/>\s*"\$LEGACY_EDITION_DROPIN"/);
    expect(fn).toContain('install_root_file "$_dropin_tmp" "$LEGACY_EDITION_DROPIN" 0644');
    // And the writer it uses really is the atomic one.
    const writer = extractShellFunction("install_root_file");
    expect(writer).toContain('mv -f "$dst.new" "$dst"');
  });

  it("a write that did not land fails the step, on the path that swallows it", () => {
    // `install_root_file` answers 1 when the copy or the rename failed, and the
    // update path calls this step from an OR-list — for the whole body of which
    // bash switches errexit OFF. Dropped, the failed write was followed by
    // successful commands, the step returned the LAST one's status, the
    // non-fatal warning never printed and the update reported success over a
    // lock still naming the previous SKU.
    const fn = extractShellFunction("step_edition_lock");
    expect(fn).toMatch(/if ! install_root_file "\$_edition_tmp" "\$CLAWBOX_EDITION_FILE" 0644; then/);
    expect(fn).toMatch(/if ! install_root_file "\$_dropin_tmp" "\$LEGACY_EDITION_DROPIN" 0644; then/);
  });

  /**
   * The staging writes, run for real.
   *
   * `install_root_file` copies whatever is in the temp and answers 0 for a copy
   * that worked, so a `printf` that failed after writing a prefix — a full
   * /tmp is the ordinary way — would be published ATOMICALLY as a truncated
   * lock, which `readEditionSource()` reads as `{edition: "openclaw",
   * defaulted: true}`. Errexit is off for this whole function on the update
   * path, so nothing else catches it.
   */
  describe.skipIf(!hasBash)("a staging write that fails", () => {
    /**
     * Run the real step with every side effect stubbed and ONE staging step
     * poisoned: the lock's temp, the drop-in's temp, or the drop-in's own
     * directory.
     */
    function runStep(poison: "lock" | "dropin" | "dropin-dir"): { out: string; rc: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-edition-stage-"));
      try {
        const bad = path.join(dir, "no-such-directory", "tmp");
        const good = path.join(dir, "ok.tmp");
        const program = [
          // No `set -e`: post_update calls this step from an OR-list, for whose
          // whole function body bash switches errexit OFF. That is the path
          // this case is about.
          `CLAWBOX_EDITION=hermes`,
          `CLAWBOX_EDITION_FILE=${JSON.stringify(path.join(dir, "edition.env"))}`,
          `LEGACY_EDITION_DROPIN=${JSON.stringify(path.join(dir, "edition.conf"))}`,
          "install() { :; }",
          `mkdir() { ${poison === "dropin-dir" ? "return 1" : ":"}; }`,
          "systemctl() { :; }",
          "step_edition_gateway_state() { echo GATEWAY_STATE; }",
          "step_edition_foreign_teardown() { echo TEARDOWN; }",
          'install_root_file() { echo "INSTALL_ROOT_FILE $2"; return 0; }',
          // The counter lives in a FILE: `$(mktemp)` runs in a subshell, so a
          // shell variable incremented inside it never reaches the caller and
          // every call would look like the first.
          `_c=${JSON.stringify(path.join(dir, "calls"))}`,
          'printf 0 > "$_c"',
          `mktemp() { local n; n=$(( $(cat "$_c") + 1 )); printf '%s' "$n" > "$_c"; if [ "$n" = ${poison === "lock" ? "1" : "2"} ]; then echo ${JSON.stringify(bad)}; else echo ${JSON.stringify(good)}; fi; }`,
          extractShellFunction("step_edition_lock") + "\n}",
          "if step_edition_lock; then echo RC=0; else echo RC=$?; fi",
        ].join("\n");
        const script = path.join(dir, "run.sh");
        fs.writeFileSync(script, program);
        const r = spawnSync("/bin/bash", [script], { encoding: "utf-8", timeout: 20_000 });
        const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
        return { out, rc: /RC=(\d+)/.exec(out)?.[1] ?? "" };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }

    it("never publishes the lock, and fails the step", () => {
      const { out, rc } = runStep("lock");
      expect(rc, out).not.toBe("0");
      expect(out).toMatch(/could not stage the edition lock/);
      // The whole point: nothing reached the atomic writer, so no truncated
      // record was published.
      expect(out).not.toContain("INSTALL_ROOT_FILE");
      // And the step stopped: the gateway state must not run over a lock the
      // box does not have.
      expect(out).not.toContain("GATEWAY_STATE");
    });

    it("publishes NEITHER record when the drop-in's own directory cannot be made", () => {
      // `mkdir -p` is part of staging the second record: made AFTER the lock
      // was committed, a failure here would leave exactly the split the
      // ordering above exists to prevent.
      const { out, rc } = runStep("dropin-dir");
      expect(rc, out).not.toBe("0");
      expect(out).toMatch(/could not create the drop-in directory/);
      expect(out).not.toContain("INSTALL_ROOT_FILE");
      expect(out).not.toContain("GATEWAY_STATE");
    });

    it("publishes NEITHER record when the drop-in cannot be staged", () => {
      // Both records are staged before either is committed, so a staging
      // failure on the second leaves the box with its previous edition in BOTH
      // places rather than a new lock beside a stale systemd drop-in — readers
      // of the two disagreeing about the SKU is the state this step exists to
      // prevent, and staging is where the ordinary failure lives (a full /tmp).
      const { out, rc } = runStep("dropin");
      expect(rc, out).not.toBe("0");
      expect(out).toMatch(/could not stage the edition drop-in/);
      expect(out, "nothing may be committed once either staging write failed").not.toContain(
        "INSTALL_ROOT_FILE",
      );
      expect(out).not.toContain("GATEWAY_STATE");
    });
  });

  it("the OTHER writer of the same two records is atomic too", () => {
    // `setup-hermes-edition.sh` writes THE SAME lock and THE SAME drop-in, and
    // install.sh dispatches it (`step_hermes_edition`, on WEB_ROOT_STEPS) on
    // every in-app update of a hermes or dual box. A truncating redirect there
    // leaves the window the step above closed wide open on the two SKUs where
    // answering "openclaw" is the damaging answer.
    expect(HERMES_EDITION_SH).not.toMatch(/>\s*"\$EDITION_FILE"/);
    expect(HERMES_EDITION_SH).not.toMatch(/>\s*"\$EDITION_DROPIN"/);
    expect(HERMES_EDITION_SH).toContain('write_root_file "$EDITION_FILE" 0644');
    expect(HERMES_EDITION_SH).toContain('write_root_file "$EDITION_DROPIN" 0644');
    // Its writer really renames rather than truncating in place…
    expect(HERMES_EDITION_SH).toMatch(/mv -f "\$tmp" "\$dst"/);
    // …and a write that did not land is recorded, so the script's own exit
    // code carries it back to the update.
    expect(HERMES_EDITION_SH).toMatch(/\|\| fail "could not write the edition lock/);
    expect(HERMES_EDITION_SH).toMatch(/\|\| fail "could not write the edition drop-in/);
  });

  it("clawbox-setup.service loads it AFTER the clawbox-writable .env", () => {
    const lines = SETUP_UNIT.split("\n").map((l) => l.trim());
    const userEnv = lines.indexOf("EnvironmentFile=-/home/clawbox/clawbox/.env");
    const rootEnv = lines.indexOf("EnvironmentFile=-/etc/clawbox/edition.env");
    expect(userEnv).toBeGreaterThan(-1);
    expect(rootEnv).toBeGreaterThan(-1);
    // systemd: later EnvironmentFile= wins, and EnvironmentFile= overrides
    // Environment=. Order the other way round and the "lock" is overridable by
    // anyone who can write .env — which is the clawbox user, i.e. the customer.
    expect(rootEnv).toBeGreaterThan(userEnv);
  });

  it("the updater unit loads it too", () => {
    // Without this (and without install.sh reading the file itself) every
    // updater-run step saw edition=openclaw, and UPDATE_STEPS includes
    // gateway_setup — so an update reinstalled OpenClaw on a Hermes box.
    expect(UPDATE_UNIT).toContain("EnvironmentFile=-/etc/clawbox/edition.env");
  });

  it("install.sh resolves the edition from the root-owned file, with a legacy fallback", () => {
    expect(INSTALL_SH).toContain('CLAWBOX_EDITION_FILE="/etc/clawbox/edition.env"');
    // Boxes provisioned before edition.env existed carry the SKU only in the
    // drop-in; without this fallback their first update runs edition-blind.
    expect(INSTALL_SH).toContain(
      'LEGACY_EDITION_DROPIN="/etc/systemd/system/clawbox-setup.service.d/edition.conf"',
    );
  });

  it("edition steps are dispatchable by the updater", () => {
    const dispatch = INSTALL_SH.slice(
      INSTALL_SH.indexOf("DISPATCH_STEPS=("),
      INSTALL_SH.indexOf("\n)", INSTALL_SH.indexOf("DISPATCH_STEPS=(")),
    );
    for (const step of ["edition_lock", "hermes_install", "hermes_edition"]) {
      expect(dispatch).toContain(step);
    }
  });
});

describe("dual SKU is actually provisionable (H8)", () => {
  it("installs the Hermes harness on hermes AND dual", () => {
    expect(extractShellFunction("step_hermes_install")).toContain("has_hermes_harness || return 0");
  });

  it("expects the Hermes dashboard units on hermes AND dual", () => {
    expect(INSTALL_SH).toContain("if has_hermes_harness; then\n  EXPECTED_ACTIVE_SERVICES+=(");
  });

  it("keeps the gateway on dual and drops it only on hermes", () => {
    expect(extractShellFunction("step_start_services")).toContain("if has_openclaw_harness; then");
    expect(INSTALL_SH).toContain('has_openclaw_harness() { [ "$CLAWBOX_EDITION" != "hermes" ]; }');
  });
});

describe("no step function calls log() before it is defined (M10)", () => {
  it("every `log` call sits after the log() definition", () => {
    // log() is defined at the very bottom, and the `--step` dispatch block
    // exits before reaching it — so `log` inside a step function is a 127 on
    // every updater-driven run, and under `set -e` an AND-list ending in one
    // takes the whole shell down.
    const definedAt = INSTALL_SH.indexOf("\nlog() {");
    expect(definedAt).toBeGreaterThan(0);
    const offenders: string[] = [];
    let offset = 0;
    for (const line of INSTALL_SH.split("\n")) {
      if (/^\s+log\s+"/.test(line) || /\{\s*log\s+"/.test(line)) {
        if (offset < definedAt) offenders.push(line.trim());
      }
      offset += line.length + 1;
    }
    expect(offenders).toEqual([]);
  });
});
