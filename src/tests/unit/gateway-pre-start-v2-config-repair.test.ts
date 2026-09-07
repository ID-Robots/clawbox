import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import { testEnv } from "@/tests/helpers/env";
import { sliceScript } from "@/tests/helpers/gateway-pre-start";

// Starts a real process (bash / python3): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

// TASK-737. A customer box was dark for 25 hours after the 2026.7.1 → 2026.8.1
// core upgrade: OpenClaw 2026.8 does not migrate a 2026.7 config on load, it
// REFUSES it (`Unrecognized keys`, gateway exit 78), and the migrations it
// names are performed only by `openclaw doctor --fix`. Nothing on the boot path
// ran doctor for that reason.
//
// And the repair had a blocker of its own, measured against 2026.8.1 on
// 2026-09-06: with an EMPTY legacy `exec-approvals.json` in the state
// directory, `doctor --fix --yes --non-interactive` exits 1 having migrated
// NOTHING and asks the operator to run the command that just ran. Move that one
// empty file aside and the same command exits 0 and migrates everything. The
// stub below models exactly that, so these cases fail if either half regresses.
//
// The three failure shapes pinned:
//   false success — a boot that "started the gateway" on a config the core will
//                   not load. The config has to be provably ACCEPTED by the
//                   core afterwards, not merely doctored at.
//   false failure — an approvals file with content is the owner's data; it is
//                   never moved, and its presence is reported rather than
//                   silently repaired.
//   probe-once    — the stamp records the core version whose config was
//                   accepted, and is written ONLY on success, so a failed
//                   repair is retried on the next boot rather than remembered
//                   as done.

const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const d = hasPython3 && hasBash ? describe : describe.skip;

/** The shipped block, run verbatim — a drift in the script fails here. */
function block(): string {
  return sliceScript(
    "# ── First boot on a NEW OpenClaw core: make the config loadable again ",
    "# Resolve configured mDNS hostname",
  );
}

let dir: string;
let root: string;
let binDir: string;
let stateDir: string;
let configPath: string;
let stampPath: string;
let coreDistDir: string;
let tmpDir: string;

/**
 * An `openclaw` that behaves like 2026.8.1 on a 2026.7 config.
 *
 * `config validate` refuses until the migration has run; `doctor --fix`
 * performs it — unless a legacy exec-approvals.json is still present, in which
 * case it exits 1 having done nothing, which is the measured behaviour this
 * whole block exists to get past.
 */
function stubOpenclaw() {
  const p = path.join(binDir, "openclaw");
  writeFileSync(
    p,
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OC_CALLS"
if [ "$1" = "config" ] && [ "$2" = "validate" ]; then
  if [ -n "\${OC_VALIDATE_RC:-}" ] && [ "\${OC_VALIDATE_RC}" != "0" ] && [ "\${OC_VALIDATE_RC}" != "1" ]; then
    exit "\$OC_VALIDATE_RC"
  fi
  if [ -f "$OC_STATE/migrated" ]; then
    echo '{"valid":true,"path":"'"$OPENCLAW_CONFIG"'","warnings":[]}'
    exit 0
  fi
  cat <<'JSON'
{"error":{"type":"cli_error","message":"OpenClaw config is invalid"},
 "valid":false,
 "issues":[{"path":"agents.defaults","message":"Unrecognized keys: \\"memorySearch\\", \\"imageGenerationModel\\""},
           {"path":"messages","message":"Unrecognized key: \\"tts\\""}]}
JSON
  exit 1
fi
if [ "$1" = "doctor" ]; then
  # The core's gate throws on the PRESENCE of either name, contents irrelevant.
  for f in "$OC_STATE/exec-approvals.json" "$OC_STATE/exec-approvals.json.doctor-importing"; do
    if [ -e "\$f" ]; then
      echo "Legacy exec approvals exist at \$f. Run \\\`openclaw doctor --fix\\\` before using exec approvals."
      exit 1
    fi
  done
  touch "$OC_STATE/migrated"
  exit 0
fi
exit 0
`,
  );
  chmodSync(p, 0o755);
}

function run(version = "2026.8.1", extraEnv: Record<string, string> = {}) {
  const program = [
    "set -euo pipefail",
    `CLAWBOX_ROOT=${JSON.stringify(root)}`,
    `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
    `OPENCLAW_STATE_DIR=${JSON.stringify(stateDir)}`,
    `OPENCLAW_BIN=${JSON.stringify(path.join(binDir, "openclaw"))}`,
    "CLAWBOX_OPENCLAW_V2=1",
    `CLAWBOX_OPENCLAW_EFFECTIVE=${JSON.stringify(version)}`,
    block(),
  ].join("\n");
  const r = spawnSync("bash", ["-c", program], {
    encoding: "utf-8",
    env: testEnv({
      PATH: `${binDir}:/usr/bin:/bin`,
      OPENCLAW_CONFIG: configPath,
      OC_CALLS: path.join(dir, "calls.log"),
      OC_STATE: stateDir,
      OC_CORE_PY: path.join(binDir, "core.py"),
      // The block builds its migration preview under TMPDIR, so the "nothing is
      // left behind" checks have to look where it actually writes. Per test, so
      // one case cannot see another's leftovers or the machine's.
      TMPDIR: tmpDir,
      ...extraEnv,
    }),
    timeout: 30_000,
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** What the block will record once the core has accepted the config on disk. */
function currentFingerprint(version = "2026.8.1"): string {
  const st = statSync(configPath);
  return `${version} ${st.size} ${Math.floor(st.mtimeMs / 1000)}`;
}

function calls(): string[] {
  const p = path.join(dir, "calls.log");
  return existsSync(p) ? readFileSync(p, "utf-8").split("\n").filter(Boolean) : [];
}

function approvalsFiles(): string[] {
  return spawnSync("bash", ["-c", `ls ${JSON.stringify(stateDir)}`], { encoding: "utf-8" })
    .stdout.split("\n")
    .filter((n) => n.startsWith("exec-approvals"));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawbox-v2-config-repair-"));
  root = path.join(dir, "clawbox");
  binDir = path.join(dir, "bin");
  stateDir = path.join(dir, "openclaw");
  // The block builds its migration preview under TMPDIR; per test, so one case
  // cannot see another's leftovers or the machine's.
  tmpDir = path.join(dir, "tmp");
  mkdirSync(tmpDir, { recursive: true });
  mkdirSync(path.join(root, "data"), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  configPath = path.join(stateDir, "openclaw.json");
  stampPath = path.join(root, "data", "openclaw-config-validated");
  writeFileSync(configPath, JSON.stringify({ agents: { defaults: { memorySearch: {} } } }, null, 2));
  stubOpenclaw();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

d("gateway pre-start: making a bumped core's config loadable", () => {
  it("moves an EMPTY legacy exec-approvals.json aside so the core's own migration can run", () => {
    writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, socket: {}, defaults: {}, agents: {} }),
    );

    const r = run();

    expect(r.status).toBe(0);
    // The empty file is gone from its blocking name and kept under another.
    expect(existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
    expect(approvalsFiles().some((n) => n.startsWith("exec-approvals.json.legacy-"))).toBe(true);
    // …and with it out of the way the core migrated and now ACCEPTS the config.
    expect(calls().some((c) => c.startsWith("doctor --fix"))).toBe(true);
    expect(existsSync(path.join(stateDir, "migrated"))).toBe(true);
    expect(readFileSync(stampPath, "utf-8").trim()).toMatch(/^2026\.8\.1 \d+ \d+$/);
  });

  it("never moves an approvals file that holds approvals, and says why", () => {
    writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, socket: {}, defaults: { "rm -rf": "deny" }, agents: {} }),
    );

    const r = run();

    expect(existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(true);
    expect(approvalsFiles()).toEqual(["exec-approvals.json"]);
    expect(r.stderr).toContain("holds exec approvals");
    // …and tells the owner what to actually do, rather than promising a
    // repair by a core whose only importer is the command that is blocked.
    expect(r.stderr).toContain("move it aside by hand");
    // The repair still fails — that is the honest outcome — and it is REPORTED
    // with the keys the core named, not swallowed.
    expect(r.stderr).toContain("the core still refuses this config");
    expect(r.stderr).toContain('agents.defaults: Unrecognized keys: "memorySearch", "imageGenerationModel"');
    // A failed repair is NOT remembered as done.
    expect(existsSync(stampPath)).toBe(false);
  });

  it("runs the core's own migration when the core refuses the config, and re-asks the core", () => {
    const r = run();

    expect(r.status).toBe(0);
    const seen = calls();
    expect(seen[0]).toBe("config validate --json");
    expect(seen.some((c) => c.startsWith("doctor --fix"))).toBe(true);
    // Asked AGAIN afterwards: doctor exiting 0 is not evidence that the core
    // will load the file, and taking it as such is the false success that left
    // a box dark for a day.
    expect(seen.filter((c) => c === "config validate --json")).toHaveLength(2);
    expect(seen.indexOf("doctor --fix --non-interactive")).toBeGreaterThan(0);
    expect(readFileSync(stampPath, "utf-8").trim()).toMatch(/^2026\.8\.1 \d+ \d+$/);
    // A backup of the pre-migration file is kept next to it, named for the
    // core and taken once — not one per boot on a box that keeps failing.
    expect(existsSync(path.join(stateDir, "openclaw.json.pre-2026.8.1-migration"))).toBe(true);
  });

  it("keeps the FIRST pre-migration backup when the repair fails and the next boot retries", () => {
    writeFileSync(path.join(stateDir, "openclaw.json.pre-2026.8.1-migration"), '{"first":true}');
    writeFileSync(configPath, JSON.stringify({ agents: { defaults: { memorySearch: { second: true } } } }));
    writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, defaults: { "rm -rf": "deny" } }),
    );

    run();

    expect(readFileSync(path.join(stateDir, "openclaw.json.pre-2026.8.1-migration"), "utf-8"))
      .toBe('{"first":true}');
    expect(
      spawnSync("bash", ["-c", `ls ${JSON.stringify(stateDir)}`], { encoding: "utf-8" })
        .stdout.split("\n")
        .filter((n) => n.includes("pre-") && n.includes("-migration")),
    ).toHaveLength(1);
  });

  it("moves aside the shape a real box actually carries: a core-generated socket block", () => {
    // THE case this whole block exists for, and the one a fixture with
    // `socket: {}` silently missed. The core fills socket.path and a fresh
    // socket.token into every exec-approvals.json it persists, with no owner
    // involvement, and regenerates both on its next write — so a file whose
    // only content is that block holds no decision of anyone's, and reading it
    // as an approval would make this repair decline to fire on every real box.
    writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      JSON.stringify({
        version: 1,
        socket: { path: "/run/user/1000/openclaw/exec-approvals.sock", token: "6f2c…" },
        defaults: {},
        agents: {},
      }),
    );

    const r = run();

    expect(r.status).toBe(0);
    expect(existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
    expect(existsSync(path.join(stateDir, "migrated"))).toBe(true);
    expect(readFileSync(stampPath, "utf-8").trim()).toMatch(/^2026\.8\.1 \d+ \d+$/);
  });

  it("moves aside a zero-byte approvals file — the shape a power cut leaves", () => {
    // It parses as nothing, so it cannot be read for approvals; but the core's
    // gate throws on its PRESENCE, so leaving it alone blocks every future
    // doctor for good.
    writeFileSync(path.join(stateDir, "exec-approvals.json"), "");

    const r = run();

    expect(r.status).toBe(0);
    expect(existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
    expect(existsSync(path.join(stateDir, "migrated"))).toBe(true);
  });

  it("clears the .doctor-importing claim a killed import leaves behind", () => {
    // doctor renames the file to this for the duration of an import, and its
    // gate refuses on either name — so a doctor killed mid-import leaves a
    // blocker that no amount of re-running doctor can clear by itself.
    writeFileSync(
      path.join(stateDir, "exec-approvals.json.doctor-importing"),
      JSON.stringify({ version: 1, socket: {}, defaults: {}, agents: {} }),
    );

    const r = run();

    expect(r.status).toBe(0);
    expect(existsSync(path.join(stateDir, "exec-approvals.json.doctor-importing"))).toBe(false);
    expect(existsSync(path.join(stateDir, "migrated"))).toBe(true);
  });

  it("does not read a validator that could not run as a refusal", () => {
    // 124 (the bound fired), 127 (nothing to run) and a crash say nothing
    // about the config. Reading one as "the core refuses this" would put every
    // single gateway start of a HEALTHY box through a 180 s doctor run, for
    // good, because the stamp is never written either.
    const r = run("2026.8.1", { OC_VALIDATE_RC: "124" });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not ask the installed core");
    expect(r.stderr).not.toContain("refuses this config");
    expect(calls().some((c) => c.startsWith("doctor"))).toBe(false);
    expect(existsSync(stampPath)).toBe(false);
  });

  it("says so when the stamp cannot be recorded, instead of silently re-validating forever", () => {
    // A root-owned or read-only data dir would otherwise add a CLI round trip
    // to every gateway start with nothing in the log to explain it.
    rmSync(path.join(root, "data"), { recursive: true, force: true });
    writeFileSync(path.join(root, "data"), "not a directory");

    const r = run();

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("will be repeated on every gateway start");
  });

  it("costs a steady box nothing: the stamp already names the installed core", () => {
    // The stamp records the core AND a fingerprint of the file it accepted.
    mkdirSync(path.dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, `${currentFingerprint()}\n`);

    const r = run();

    expect(r.status).toBe(0);
    expect(calls()).toEqual([]);
  });

  it("treats an unreadable stamp as no stamp rather than as agreement", () => {
    // A stamp is a RECORD, and anything that is not this core's version is
    // not a record of this core. Reading garbage as "already validated" would
    // leave a box that cannot boot never asking why.
    mkdirSync(path.dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, "\u0000\u0000not-a-version\n");

    run("2026.8.1");

    expect(calls()[0]).toBe("config validate --json");
    expect(readFileSync(stampPath, "utf-8").trim()).toMatch(/^2026\.8\.1 \d+ \d+$/);
  });

  it("creates the stamp directory when the data dir is not there yet", () => {
    rmSync(path.join(root, "data"), { recursive: true, force: true });

    const r = run();

    expect(r.status).toBe(0);
    expect(readFileSync(stampPath, "utf-8").trim()).toMatch(/^2026\.8\.1 \d+ \d+$/);
  });

  it("re-asks after a core bump even though the previous core was accepted", () => {
    mkdirSync(path.dirname(stampPath), { recursive: true });
    writeFileSync(stampPath, `${currentFingerprint("2026.7.1")}\n`);

    run("2026.8.1");

    expect(calls()[0]).toBe("config validate --json");
    expect(readFileSync(stampPath, "utf-8").trim()).toMatch(/^2026\.8\.1 \d+ \d+$/);
  });
});

/**
 * The sibling the same discovery makes dangerous.
 *
 * The auth-profile repair 2 100 lines below runs the SAME `doctor --fix`, and
 * treated every non-zero exit as a failed migration with `exit 1` — which
 * fails a blocking ExecStartPre. That is strictly worse than the exit-78 state
 * this card is about: exit 78 is covered by `RestartPreventExitStatus`
 * (config/clawbox-gateway.service:78) so the unit stops trying, while a failed
 * pre-start burns `StartLimitBurst=20` and leaves the box with no gateway.
 */
d("gateway pre-start: the auth-profile repair meets the same blocker", () => {
  function authBlock(): string {
    return sliceScript(
      "# OpenClaw 2 refuses to start while any legacy auth-profiles.json remains",
      "# Patch the installed openclaw deepseek plugin JSON",
    );
  }

  function runAuth() {
    const program = [
      "set -euo pipefail",
      `OPENCLAW_CONFIG=${JSON.stringify(configPath)}`,
      `OPENCLAW_BIN=${JSON.stringify(path.join(binDir, "openclaw"))}`,
      "CLAWBOX_OPENCLAW_V2=1",
      authBlock(),
    ].join("\n");
    const r = spawnSync("bash", ["-c", program], {
      encoding: "utf-8",
      env: testEnv({
        PATH: `${binDir}:/usr/bin:/bin`,
        OPENCLAW_CONFIG: configPath,
        OC_CALLS: path.join(dir, "calls.log"),
        OC_STATE: stateDir,
      }),
      timeout: 30_000,
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  beforeEach(() => {
    // The sentinel this block is gated on.
    mkdirSync(path.join(stateDir, "agents", "main", "agent"), { recursive: true });
    writeFileSync(path.join(stateDir, "agents", "main", "agent", "auth-profiles.json"), "{}");
  });

  it("does not fail the boot when doctor is blocked by a legacy exec approvals file", () => {
    writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, socket: {}, defaults: {}, agents: {} }),
    );

    const r = runAuth();

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("blocked by a legacy exec approvals file");
    expect(r.stderr).not.toContain("auth-profile migration failed");
  });

  it("still fails the boot when doctor fails for any other reason", () => {
    // The invariant the change must not remove: a genuinely failed auth-profile
    // migration leaves a store OpenClaw 2 refuses to start on, and that is
    // worth stopping for.
    writeFileSync(
      path.join(binDir, "openclaw"),
      "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$OC_CALLS\"\necho 'doctor exploded' >&2\nexit 1\n",
    );
    chmodSync(path.join(binDir, "openclaw"), 0o755);

    const r = runAuth();

    expect(r.status).toBe(1);
    expect(r.stderr).toContain("auth-profile migration failed");
  });
});

/**
 * TASK-741 — the three follow-ups from #746's review that live in this block.
 *
 * All three are LATENT on the pinned core rather than live, and each is the
 * kind of latency this repo has been bitten by: a verdict that reads an exit
 * code and then second-guesses it, a bound whose comment promises a grace the
 * code does not have, and a destination two writes can share.
 */
d("gateway pre-start: the config-repair block's own edges", () => {
  it("takes exit 0 as the core's acceptance, whatever it printed", () => {
    // ALIGNED WITH `getOpenclawConfigRefusal` (src/lib/updater.ts), which has
    // treated exit 0 as acceptance without parsing since TASK-737. Requiring
    // stdout to parse as JSON on top of the exit code answered `unknown` for a
    // core that exits 0 with a banner, an empty line or a progress frame — and
    // `unknown` skips the stamp, so EVERY gateway start of a healthy box would
    // pay for a `config validate` and print a WARN, for ever.
    writeFileSync(
      path.join(binDir, "openclaw"),
      "#!/usr/bin/env bash\n"
      + "printf '%s\\n' \"$*\" >> \"$OC_CALLS\"\n"
      + "if [ \"$1\" = \"config\" ]; then echo 'OpenClaw 2026.8.1 — All your chats, one OpenClaw.'; exit 0; fi\n"
      + "exit 0\n",
    );
    chmodSync(path.join(binDir, "openclaw"), 0o755);

    const r = run();

    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("could not ask the installed core");
    // Accepted means stamped, which is what stops the next boot re-asking.
    expect(readFileSync(stampPath, "utf-8").trim()).toBe(currentFingerprint());
    // …and no doctor: there is nothing to repair.
    expect(calls().some((c) => c.startsWith("doctor"))).toBe(false);
  });

  it("gives the validator bound a SIGKILL grace, like every other CLI bound here", () => {
    // The BUDGET comment above the block claims `65 + 180 + 65` on the strength
    // of a 5 s `-k` grace the two validate bounds did not have. Plain `timeout`
    // sends SIGTERM only: a validator that ignored it would hold this blocking
    // ExecStartPre for the unit's entire start budget. The doctor bound stays
    // SIGTERM-only on purpose — a SIGKILL mid-import is what leaves the
    // `.doctor-importing` claim file this same block has to clear.
    const src = block();
    expect(src).toContain('timeout -k 5 60 "$OPENCLAW_BIN" config validate --json');
    expect(src).toContain('timeout 180 "$OPENCLAW_BIN" doctor --fix --non-interactive');
    expect(src).not.toContain('timeout -k 5 180 "$OPENCLAW_BIN" doctor');
  });

  it("clears the approvals blocker on a box whose config is already stamped", () => {
    // The blocker is an AUTH/STATE fact and the stamp is a record about the
    // CONFIG, and the two were gated on one another: the whole clearing loop
    // sat inside the config-fingerprint guard, so a box that had booted once
    // since its core bump kept its blocker for ever, silently — and every later
    // `doctor --fix` on that box (the auth-profile migration in this same
    // script, install.sh's, the updater's, the AI-models configure route's)
    // exited 1 having migrated nothing.
    writeFileSync(stampPath, `${currentFingerprint()}\n`);
    writeFileSync(
      path.join(stateDir, "exec-approvals.json"),
      JSON.stringify({ version: 1, socket: {}, defaults: {}, agents: {} }),
    );

    const r = run();

    expect(r.status).toBe(0);
    expect(existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
    expect(approvalsFiles().some((n) => n.startsWith("exec-approvals.json.legacy-"))).toBe(true);
    // …and the config half is still gated on the stamp, so a steady box pays
    // for the two `[ -e ]` tests above and nothing else.
    expect(calls()).toEqual([]);
  });

  it("refuses a config the core calls invalid, whatever it exited with", () => {
    // The other half of "exit 0 is the answer". The stamp is DURABLE, so a core
    // exiting 0 while printing `{"valid": false}` would be recorded as accepted
    // and never asked again — a false success that outlives the boot and leaves
    // the gateway exiting 78 with nothing in the log.
    writeFileSync(
      path.join(binDir, "openclaw"),
      "#!/usr/bin/env bash\n"
      + "printf '%s\\n' \"$*\" >> \"$OC_CALLS\"\n"
      + "if [ \"$1\" = \"config\" ]; then\n"
      + "  if [ -f \"$OC_STATE/migrated\" ]; then echo '{\"valid\":true,\"warnings\":[]}'; exit 0; fi\n"
      + "  echo '{\"valid\":false,\"issues\":[{\"path\":\"a\",\"message\":\"bad\"}]}'; exit 0\n"
      + "fi\n"
      + "if [ \"$1\" = \"doctor\" ]; then touch \"$OC_STATE/migrated\"; exit 0; fi\n"
      + "exit 0\n",
    );
    chmodSync(path.join(binDir, "openclaw"), 0o755);

    const r = run();

    expect(r.status).toBe(0);
    // The core's own reason reached the boot log, and its own repair ran.
    expect(r.stderr).toContain("refused: a: bad");
    expect(calls().some((c) => c.startsWith("doctor --fix"))).toBe(true);
    // …and the config it then ACCEPTED is the one that gets stamped.
    expect(readFileSync(stampPath, "utf-8").trim()).toBe(currentFingerprint());
  });

  it("never overwrites an earlier moved-aside approvals file", () => {
    // The stamp is second-resolution and `mv` was unguarded, so two boots
    // inside one second would silently overwrite the first copy. `date` is
    // stubbed to one fixed answer here so the collision is the case under
    // test rather than a race the clock usually wins.
    writeFileSync(
      path.join(binDir, "date"),
      "#!/usr/bin/env bash\nprintf '%s\\n' 20260906-181500\n",
    );
    chmodSync(path.join(binDir, "date"), 0o755);
    const approvals = { version: 1, socket: {}, defaults: {}, agents: {} };

    writeFileSync(path.join(stateDir, "exec-approvals.json"), JSON.stringify(approvals));
    expect(run().status).toBe(0);

    // A second boot in the same second, over a config the core refuses again.
    rmSync(path.join(stateDir, "migrated"), { force: true });
    writeFileSync(configPath, JSON.stringify({ agents: { defaults: { memorySearch: {}, x: 1 } } }, null, 2));
    writeFileSync(path.join(stateDir, "exec-approvals.json"), JSON.stringify(approvals));
    expect(run().status).toBe(0);

    // BOTH copies are still there. Neither holds a decision of the owner's, so
    // nothing of his could have been lost — but a move-aside that overwrites is
    // a write reported as a move, and this file is the only record that the
    // repair ever fired.
    expect(approvalsFiles().filter((n) => n.includes(".legacy-"))).toHaveLength(2);
    expect(existsSync(path.join(stateDir, "exec-approvals.json"))).toBe(false);
  });
});

/**
 * TASK-754 — the 25-hour outage was a DIAGNOSIS problem, not a missing repair.
 *
 * Measured against the pinned 2026.8.1 core, in throwaway homes, with a legacy
 * `exec-approvals.json` holding a real approval present throughout:
 *
 *   * a 2026.7 config whose migrated form VALIDATES — `openclaw gateway run`
 *     migrates it ITSELF and reaches `ready`. The core's own automatic startup
 *     config repair does it, and the approvals file does not stop it, because
 *     it is not doctor.
 *   * a 2026.7 config whose migrated form does NOT validate — exit 78, config
 *     untouched, with or without the approvals file.
 *
 * So there is nothing for ClawBox to carry across: where that would help the
 * core has already done it, and where it would not, running the same table
 * produces the same refusal. What nothing on the box does is say WHICH key is
 * in the way. The gateway names the pre-migration keys — every one of which the
 * core would have handled — while the key that really blocks it exists only
 * after those migrations have run. `tts.voiceId` is the incident's own: the
 * `messages.tts → tts` move is verbatim, `voiceId` is renamed only inside
 * provider scopes, and `doctor --fix` gets past it in a LATER step that DELETES
 * it (`stripUnknownConfigKeys`) — a step this block does not perform, because
 * naming a key of the owner's and deleting it are different decisions.
 */
d("gateway pre-start: naming what the core still refuses after its own migrations", () => {
  /** The shape #746 refuses to move: a decision of the owner's. */
  const realApproval = JSON.stringify({
    version: 1,
    socket: { path: "/run/user/1000/openclaw/exec-approvals.sock", token: "6f2c" },
    defaults: { deny: ["rm -rf /"] },
    agents: {},
  });

  /** The incident's own 2026.7 layout: four legacy keys, one of them fatal. */
  function incidentConfig(): Record<string, unknown> {
    return {
      agents: {
        defaults: {
          memorySearch: { enabled: true },
          imageGenerationModel: { primary: "openai/gpt-image-1" },
        },
      },
      messages: { tts: { enabled: true, voiceId: "nova" } },
    };
  }

  /**
   * The 2026.7 → 2026.8 rename table and the v2 schema, as a stand-in core.
   *
   * `issues` is what `config validate --json` reports about a FILE — so a
   * preview built by anything other than doctor is judged on its content the
   * way the real core judges it — and `migrate` is what `doctor --fix` does,
   * which includes the strip step the block under test deliberately does not.
   * Both halves model behaviour measured on 2026.8.1.
   */
  function stubCorePython() {
    writeFileSync(
      path.join(binDir, "core.py"),
      `import json, sys

MODE, CFG = sys.argv[1], sys.argv[2]
doc = json.load(open(CFG))
defaults = (doc.get("agents") or {}).get("defaults") or {}
legacy = [k for k in ("memorySearch", "imageGenerationModel") if k in defaults]

if MODE == "issues":
    out = []
    if legacy:
        keys = ", ".join('QQ%sQQ' % k for k in legacy)
        out.append('{"path":"agents.defaults","message":"Unrecognized keys: %s"}' % keys)
    if "tts" in (doc.get("messages") or {}):
        out.append('{"path":"messages","message":"Unrecognized key: QQttsQQ"}')
    # The key the whole card is about: the move is verbatim and voiceId is
    # renamed only inside provider scopes, so it reaches a .strict() schema.
    if "voiceId" in (doc.get("tts") or {}):
        out.append('{"path":"tts","message":"Unrecognized key: QQvoiceIdQQ"}')
    sys.stdout.write(",".join(out).replace("QQ", chr(92) + chr(34)))
    sys.exit(0)

if "imageGenerationModel" in defaults:
    defaults.setdefault("mediaModels", {}).setdefault("image", defaults.pop("imageGenerationModel"))
if "memorySearch" in defaults:
    doc.setdefault("memory", {}).setdefault("search", defaults.pop("memorySearch"))
if "tts" in (doc.get("messages") or {}):
    moved = doc["messages"].pop("tts")
    if moved.pop("enabled", None):
        moved["auto"] = "always"
    doc.setdefault("tts", moved)
# doctor's LATER step, stripUnknownConfigKeys, which the block does not perform.
(doc.get("tts") or {}).pop("voiceId", None)
json.dump(doc, open(CFG, "w"), indent=2)
`,
    );
  }

  /**
   * The core's own migration, where the block looks for it.
   *
   * Found by its DECLARATION text and picked out by function NAME, because a
   * bundle renames the export binding (`applyLegacyDoctorMigrations as A`) and
   * not the declaration — both indirections are reproduced here, so a discovery
   * that only worked on a matching export name fails. It performs the moves and
   * NOT the strip, exactly as the real one does.
   */
  function stubCoreMigrationChunk() {
    mkdirSync(coreDistDir, { recursive: true });
    writeFileSync(
      path.join(coreDistDir, "legacy-pGW3ZP3t.js"),
      `function applyLegacyDoctorMigrations(raw, context, options) {
  if (!raw || typeof raw !== "object") return { next: null, changes: [] };
  const next = structuredClone(raw);
  const changes = [];
  const defaults = next.agents && next.agents.defaults;
  if (defaults && Object.hasOwn(defaults, "imageGenerationModel")) {
    const mediaModels = defaults.mediaModels || {};
    if (mediaModels.image === undefined) mediaModels.image = defaults.imageGenerationModel;
    defaults.mediaModels = mediaModels;
    delete defaults.imageGenerationModel;
    changes.push("Moved agents.defaults.imageGenerationModel -> agents.defaults.mediaModels.image.");
  }
  if (defaults && Object.hasOwn(defaults, "memorySearch")) {
    next.memory = next.memory || {};
    if (next.memory.search === undefined) next.memory.search = defaults.memorySearch;
    delete defaults.memorySearch;
    changes.push("Moved agents.defaults.memorySearch -> memory.search.");
  }
  if (next.messages && Object.hasOwn(next.messages, "tts")) {
    if (next.tts === undefined) {
      const moved = next.messages.tts;
      if (moved && moved.enabled) { delete moved.enabled; moved.auto = "always"; }
      next.tts = moved;
    }
    delete next.messages.tts;
    changes.push("Moved messages.tts -> tts.");
  }
  if (changes.length === 0) return { next: null, changes: [] };
  return { next, changes };
}
export { applyLegacyDoctorMigrations as A };
`,
    );
  }

  /** An `openclaw` that judges the FILE it is pointed at, like the real one. */
  function stubContentAwareOpenclaw() {
    const p = path.join(binDir, "openclaw");
    writeFileSync(
      p,
      `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OC_CALLS"
CFG="\${OPENCLAW_CONFIG_PATH:-\${OPENCLAW_CONFIG}}"
if [ "$1" = "config" ] && [ "$2" = "validate" ]; then
  if [ -n "\${OC_VALIDATE_RC:-}" ] && [ "\${OC_VALIDATE_RC}" != "0" ] && [ "\${OC_VALIDATE_RC}" != "1" ]; then
    exit "\$OC_VALIDATE_RC"
  fi
  ISSUES="\$(python3 "$OC_CORE_PY" issues "\$CFG")" || ISSUES='{"path":"config","message":"unreadable"}'
  if [ -z "\$ISSUES" ]; then
    printf '{"valid":true,"path":"%s","warnings":[]}\\n' "\$CFG"
    exit 0
  fi
  printf '{"valid":false,"issues":[%s]}\\n' "\$ISSUES"
  exit 1
fi
if [ "$1" = "doctor" ]; then
  for f in "$OC_STATE/exec-approvals.json" "$OC_STATE/exec-approvals.json.doctor-importing"; do
    if [ -e "\$f" ]; then
      echo "Legacy exec approvals exist at \$f. Run \\\`openclaw doctor --fix\\\` before using exec approvals."
      exit 1
    fi
  done
  python3 "$OC_CORE_PY" migrate "\$CFG"
  touch "$OC_STATE/migrated"
  exit 0
fi
exit 0
`,
    );
    chmodSync(p, 0o755);
  }

  function withRealApproval() {
    writeFileSync(path.join(stateDir, "exec-approvals.json"), realApproval);
  }

  /**
   * Everything the block's migration preview could have left behind.
   *
   * BOTH places, because the preview moved: it used to sit beside openclaw.json
   * in the state directory and now lives in its own directory under TMPDIR. A
   * helper that looked only at the old place, under the old name, made every
   * "nothing is left behind" assertion unfailable — verified by mutation: with
   * the three `rm -rf "$preview_dir"` lines removed from the block, the
   * migrated config (secrets and all) is left as `openclaw.json` inside a
   * `clawbox-config-preview-` directory, and the old helper still answered
   * with an empty list.
   */
  function previewFiles(): string[] {
    const listing = (at: string) =>
      spawnSync("bash", ["-c", `ls -A ${JSON.stringify(at)} 2>/dev/null || true`], { encoding: "utf-8" })
        .stdout.split("\n").filter(Boolean);
    return [
      ...listing(stateDir).filter((n) => n.includes("preview")),
      ...listing(tmpDir).filter((n) => n.includes("preview")),
    ];
  }

  /**
   * The node the block runs the core's own migration with.
   *
   * Placed BESIDE the openclaw bin, which is the nvm and npm-global layout —
   * `node` and `openclaw` in one bin directory — and the layout the block looks
   * at first, for the same reason it looks for the bundle there: this unit sets
   * no `Environment=PATH`, so an nvm node is not on the one systemd hands it.
   * Measured 2026-09-07: this repo's CI runner is bun-only and has no
   * `/usr/bin/node`, so a PATH-only lookup made the whole arm a silent no-op
   * there while it worked on the box.
   */
  function installNodeBesideTheCore() {
    symlinkSync(process.execPath, path.join(binDir, "node"));
  }

  beforeEach(() => {
    coreDistDir = path.join(dir, "lib", "node_modules", "openclaw", "dist");
    writeFileSync(configPath, JSON.stringify(incidentConfig(), null, 2));
    stubCorePython();
    stubCoreMigrationChunk();
    stubContentAwareOpenclaw();
    installNodeBesideTheCore();
  });

  it("names the key that is actually in the way, not the ones the core would have handled", () => {
    withRealApproval();
    const before = readFileSync(configPath, "utf-8");

    const r = run();

    expect(r.status).toBe(0);
    // The keys the gateway itself reports — all four of which the core migrates.
    expect(r.stderr).toContain('agents.defaults: Unrecognized keys: "memorySearch", "imageGenerationModel"');
    // …and the one that is left once it has, which is the one to fix. This
    // sentence is what the incident's manual repair had to derive by hand.
    expect(r.stderr).toContain("after the core's own migrations these remain");
    expect(r.stderr).toContain('tts: Unrecognized key: "voiceId"');
    expect(r.stderr).not.toContain("these remain, and they are what to fix: agents.defaults");
    // NOTHING was written: not the config, not a preview, not a stamp.
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(previewFiles()).toEqual([]);
    expect(existsSync(stampPath)).toBe(false);
    // …and the owner's approval is byte-identical, under its own name.
    expect(readFileSync(path.join(stateDir, "exec-approvals.json"), "utf-8")).toBe(realApproval);
    expect(approvalsFiles()).toEqual(["exec-approvals.json"]);
  });

  it("names the file that blocks the repair as the one manual step", () => {
    withRealApproval();

    const r = run();

    expect(r.stderr).toContain("refuses to start while");
    expect(r.stderr).toContain(path.join(stateDir, "exec-approvals.json"));
    expect(r.stderr).toContain("move it aside by hand");
  });

  it("says the core will repair this one itself, instead of predicting exit 78 over it", () => {
    // THE BOX THAT WAS NEVER BROKEN. Measured on 2026.8.1 with a real approval
    // present throughout: `openclaw gateway run` migrates this config ITSELF
    // and reaches `ready`, because the approvals gate is doctor's and the
    // startup repair is not doctor. Telling that owner his gateway will exit 78
    // and asking him to move a file holding his own deny rules aside would be
    // wrong on the first box that reads this block — and the answer is already
    // in hand two frames down, so throwing it away is the defect.
    const carryable = incidentConfig() as { messages: { tts: Record<string, unknown> } };
    delete carryable.messages.tts.voiceId;
    writeFileSync(configPath, JSON.stringify(carryable, null, 2));
    withRealApproval();

    const r = run();

    expect(r.stdout).toContain("it applies them itself when the gateway starts");
    expect(r.stderr).not.toContain("the core still refuses this config");
    expect(r.stderr).not.toContain("after the core's own migrations these remain");
    // …and this PR's own manual step is not asked for over a box that is about
    // to come up. (The approvals clearing loop's own NOTE above is beta's and
    // is about the file, not about the gateway's fate.)
    expect(r.stderr).not.toContain("refuses to start while");
    expect(previewFiles()).toEqual([]);
  });

  it("says nothing about a remainder, and asks for nothing, when the validator could not run", () => {
    // The rule this block's own `*)` arm states one screen down: a validator
    // that could not be run says nothing about the config. A 124 there must not
    // become a sentence about the owner's exec approvals.
    withRealApproval();

    const r = run("2026.8.1", { OC_VALIDATE_RC: "124" });

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("could not ask the installed core");
    expect(r.stderr).not.toContain("after the core's own migrations these remain");
    expect(r.stderr).not.toContain("refuses to start while");
    expect(previewFiles()).toEqual([]);
  });

  it("asks the core once per config, and still says it on every boot", () => {
    // 125 s on a box with no gateway is worth paying once; on a `Restart=always`
    // unit it is not worth paying every five seconds. The ANSWER is remembered
    // against the same fingerprint the acceptance stamp uses — the sentence is
    // not, so the owner reads it whenever he looks.
    withRealApproval();

    const first = run();
    const afterFirst = calls().length;
    const second = run();

    expect(first.stderr).toContain('tts: Unrecognized key: "voiceId"');
    expect(second.stderr).toContain('tts: Unrecognized key: "voiceId"');
    // Boot one spends three `config validate` (the verdict, the preview, the
    // re-ask after doctor) and one doctor; boot two spends the same MINUS the
    // preview's, because that answer is remembered. Asserted exactly, because
    // an inequality would also hold for a boot that skipped the arm entirely.
    expect(calls().filter((c) => c === "config validate --json")).toHaveLength(5);
    expect(calls().length - afterFirst).toBe(afterFirst - 1);
    // …and it asks again the moment the file changes, so this is not a verdict
    // remembered for ever.
    const fixed = incidentConfig() as { messages: { tts: Record<string, unknown> } };
    delete fixed.messages.tts.voiceId;
    writeFileSync(configPath, JSON.stringify(fixed, null, 2));
    expect(run().stderr).not.toContain("after the core's own migrations these remain");
  });

  it("says nothing about a remainder when the core's own table cannot be read", () => {
    // "Read the table from the installed bundle" is the whole of the harness
    // claim here. A bundle that is not there is not a licence to guess the
    // moves from a copy in this file, and a diagnosis nobody can stand behind
    // is worse than none.
    rmSync(coreDistDir, { recursive: true, force: true });
    withRealApproval();

    const r = run();

    expect(r.stderr).toContain("the core still refuses this config");
    expect(r.stderr).not.toContain("after the core's own migrations these remain");
    expect(previewFiles()).toEqual([]);
  });

  it("finds the interpreter beside the core when it is not on PATH at all", () => {
    // The failure this replaced: the bundle was located relative to
    // `$OPENCLAW_BIN` and the interpreter was looked up on PATH only, so on any
    // box (or CI runner) whose node is not on the unit's PATH the whole arm
    // returned 1 and said one NOTE. PATH here carries no node at all.
    withRealApproval();

    const r = run("2026.8.1", { PATH: "/usr/bin:/bin" });

    expect(r.stderr).toContain('tts: Unrecognized key: "voiceId"');
    expect(r.stderr).not.toContain("could not be worked out here");
  });

  /**
   * A PATH carrying every tool this block uses and NO node.
   *
   * Built rather than assumed: this dev PC has `/usr/bin/node` and the CI
   * runner does not, so a case that just names `/usr/bin:/bin` would be
   * measuring the machine instead of the code.
   */
  function pathWithoutNode(): string {
    const toolsDir = path.join(dir, "tools-without-node");
    mkdirSync(toolsDir, { recursive: true });
    for (const tool of [
      "bash", "sh", "head", "grep", "dirname", "cp", "rm", "mv", "mktemp",
      "timeout", "date", "stat", "sed", "tr", "cut", "ls", "python3", "readlink",
    ]) {
      const found = spawnSync("bash", ["-c", `command -v ${tool} || true`], { encoding: "utf-8" })
        .stdout.trim();
      if (found) symlinkSync(found, path.join(toolsDir, tool));
    }
    return `${binDir}:${toolsDir}`;
  }

  it("fails closed, and says so, when there is no node anywhere", () => {
    rmSync(path.join(binDir, "node"), { force: true });
    withRealApproval();
    const before = readFileSync(configPath, "utf-8");

    const r = run("2026.8.1", { PATH: pathWithoutNode() });

    // Nothing invented, nothing written, and the honest refusal still printed.
    expect(r.stderr).toContain("could not be worked out here");
    expect(r.stderr).toContain("the core still refuses this config");
    expect(r.stderr).not.toContain("after the core's own migrations these remain");
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(previewFiles()).toEqual([]);
  });

  it("stands down on a $include spelled the way JSON also allows", () => {
    // `"\u0024include"` decodes to `$include`, so the core's own
    // `containsConfigIncludeDirective` sees it and no grep over the raw bytes
    // can. The authoritative test is therefore made on the decoded document.
    writeFileSync(
      configPath,
      `{"\\u0024include":"./extra.json",${JSON.stringify(incidentConfig()).slice(1)}`,
    );
    withRealApproval();

    const r = run();

    // The arm WAS reached — the core refuses this config — and stood down.
    expect(r.stderr).toContain("the core still refuses this config");
    expect(r.stderr).not.toContain("after the core's own migrations these remain");
    expect(previewFiles()).toEqual([]);
  });

  it("stands down on a config that carries a $include", () => {
    // The core's own startup repair refuses an include for the same reason: the
    // file on disk is not the whole config, so a preview built from it alone
    // would name keys an included file may already answer for.
    writeFileSync(
      configPath,
      JSON.stringify({ ...incidentConfig(), $include: "./extra.json" }, null, 2),
    );
    withRealApproval();

    const r = run();

    expect(r.stderr).toContain("the core still refuses this config");
    expect(r.stderr).not.toContain("after the core's own migrations these remain");
    expect(previewFiles()).toEqual([]);
  });
});
