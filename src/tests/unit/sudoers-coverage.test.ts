import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

// Every test here spawns the real checker over the real src/ and mcp/ trees,
// which takes ~5 s on a Jetson Orin Nano — right on the default 5 s test
// timeout, so the suite failed on the device it protects while passing in CI.
// The budget is per test; the checker's own OK line is still the assertion.
vi.setConfig({ testTimeout: 60_000 });
import { execFile, spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * TASK-445 — the guard that keeps the sudoers allow-list an allow-list.
 *
 * config/clawbox-sudoers replaced `clawbox ALL=(ALL) NOPASSWD: ALL` with an
 * explicit list of commands. Nothing stops that list from drifting back: a new
 * `sudo` call with no matching grant fails on a device with no console (a
 * password prompt nobody can answer), and the cheapest-looking fix is to widen
 * the list. scripts/check-sudoers-coverage.sh makes both directions of drift a
 * build failure instead.
 */

const REPO = path.resolve(__dirname, "../../..");
const CHECKER = path.join(REPO, "scripts/check-sudoers-coverage.sh");

const CAN_RUN =
  process.platform !== "win32"
  && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0
  && spawnSync("perl", ["-e", "1"], { stdio: "ignore" }).status === 0;
const d = CAN_RUN ? describe : describe.skip;

function run(root: string, args: string[] = []) {
  return spawnSync("bash", [CHECKER, ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAWBOX_REPO_ROOT: root },
  });
}

interface Checked {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** run(), off the worker thread, so that scans of the same tree can overlap. */
function runAsync(root: string, args: string[] = []): Promise<Checked> {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      [CHECKER, ...args],
      { encoding: "utf-8", env: { ...process.env, CLAWBOX_REPO_ROOT: root }, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // A non-zero exit is the checker's answer, not a failure to run it:
        // execFile reports it as an error whose `code` is the exit status.
        // Anything else (no bash, output over maxBuffer) has no such status
        // and IS a failure to run.
        const status = err ? (err as { code?: unknown }).code : 0;
        if (typeof status !== "number") {
          reject(err);
          return;
        }
        resolve({ status, stdout, stderr });
      },
    );
  });
}

/**
 * The tree as it ships, scanned once per file rather than once per test.
 *
 * Four tests read the checker's verdict on the REAL repo — the pass line, the
 * --list dump (twice) and the --json report. They differ only in how the same
 * scan is printed, and each was paying for the whole scan (~5 s on the box,
 * ~1.5 s in CI). Three modes, three scans, started side by side: the checker
 * is one single-threaded perl pass, so they overlap where a core is free.
 * Every test that mutates a fixture still scans its own fixture.
 */
let shipped: Promise<{ check: Checked; list: Checked; json: Checked }>;
beforeAll(() => {
  if (!CAN_RUN) return;
  shipped = Promise.all([runAsync(REPO), runAsync(REPO, ["--list"]), runAsync(REPO, ["--json"])]).then(
    ([check, list, json]) => ({ check, list, json }),
  );
  // A scan that could not run still fails the tests that await it; this only
  // keeps the rejection from surfacing as an unhandled one first.
  void shipped.catch(() => undefined);
}, 120_000);

let fixture: string;

/**
 * A repo root that shares the real src/ and mcp/ trees (so the call sites under
 * test are the real ones) but has its own config/ and scripts/, which the tests
 * mutate.
 */
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-sudoers-cov-"));
  fs.mkdirSync(path.join(fixture, "config"));
  for (const f of ["clawbox-sudoers", "sudoers-clawbox-ollama"]) {
    fs.copyFileSync(path.join(REPO, "config", f), path.join(fixture, "config", f));
  }
  fs.symlinkSync(path.join(REPO, "src"), path.join(fixture, "src"));
  fs.symlinkSync(path.join(REPO, "mcp"), path.join(fixture, "mcp"));
  fs.mkdirSync(path.join(fixture, "scripts"));
  for (const e of fs.readdirSync(path.join(REPO, "scripts"))) {
    fs.symlinkSync(path.join(REPO, "scripts", e), path.join(fixture, "scripts", e));
  }
});

afterEach(() => {
  fs.rmSync(fixture, { recursive: true, force: true });
});

const grants = () => path.join(fixture, "config/clawbox-sudoers");
/**
 * The fixture scanned before anything touched it. Two tests assert exactly
 * that it passes — that the fixture is not itself the thing under test, and
 * that the bare-unit twins the shipped list carries are accepted — and one
 * scan answers both; the second keeps the first's verdict. Any test that
 * changes its fixture uses run() and pays for its own.
 */
let pristine: ReturnType<typeof run> | null = null;
const runPristine = () => (pristine ??= run(fixture));
const appendGrant = (line: string) => fs.appendFileSync(grants(), `${line}\n`);
const dropGrant = (needle: string) =>
  fs.writeFileSync(
    grants(),
    fs.readFileSync(grants(), "utf-8").split("\n").filter((l) => !l.includes(needle)).join("\n"),
  );

d("check-sudoers-coverage", () => {
  it("passes on the repo as it ships", async () => {
    const r = (await shipped).check;
    expect(r.stderr + r.stdout).toMatch(/OK — \d+ grants, \d+ resolved sudo invocations, 0 gaps/);
    expect(r.status).toBe(0);
  });

  it("passes on the fixture, so the fixture itself is not the thing under test", () => {
    expect(runPristine().status).toBe(0);
  });

  it("fails when a sudo call has no grant", () => {
    fs.writeFileSync(
      path.join(fixture, "scripts/zz-probe.sh"),
      "#!/usr/bin/env bash\nsudo /usr/bin/systemctl restart some-other.service\n",
    );
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNCOVERED sudo invocations/);
    expect(r.stderr).toMatch(/systemctl restart some-other\.service/);
  });

  it("fails when a granted command loses its grant", () => {
    dropGrant("systemctl reboot");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNCOVERED sudo invocations/);
    expect(r.stderr).toMatch(/\/usr\/bin\/systemctl reboot/);
  });

  // The reverse direction. A grant nobody uses is privilege handed out for free,
  // and it is how the list creeps back towards ALL one line at a time.
  it("fails on a grant nothing invokes", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl restart cups.service");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNUSED grants/);
    expect(r.stderr).toMatch(/cups\.service/);
  });

  // The `.service` / bare-unit pairs in config/clawbox-sudoers exist because
  // sudoers matches arguments as exact strings; only one spelling is ever called.
  it("accepts the bare-unit twin of a grant that is used", () => {
    expect(fs.readFileSync(grants(), "utf-8")).toMatch(/systemctl restart clawbox-gateway$/m);
    expect(runPristine().status).toBe(0);
  });

  // Fail-closed: a sudo call the checker cannot read is never quietly a pass.
  it("fails on a sudo call whose arguments it cannot resolve", () => {
    fs.writeFileSync(
      path.join(fixture, "scripts/zz-probe.sh"),
      '#!/usr/bin/env bash\nsudo /usr/bin/systemctl restart "$UNIT"\n',
    );
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNRESOLVED sudo call sites/);
  });

  it("does not mistake a sudo command inside a message for an invocation", () => {
    fs.writeFileSync(
      path.join(fixture, "scripts/zz-probe.sh"),
      '#!/usr/bin/env bash\necho "Fix it with: sudo systemctl restart cups"\n',
    );
    expect(run(fixture).status).toBe(0);
  });

  it("refuses a blanket grant outright", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: ALL");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/grants a bare ALL/);
  });

  it("refuses a grant that runs as anything other than root", () => {
    appendGrant("clawbox ALL=(clawbox) NOPASSWD: /usr/bin/systemctl reboot");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/only \(root\) is allowed/);
  });

  it("refuses a line it cannot parse rather than skipping it", () => {
    appendGrant("clawbox ALL=(root) /usr/bin/systemctl reboot");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/is not a `clawbox ALL=\(root\) NOPASSWD: <cmd>` rule/);
  });

  // ── Shape invariants (TASK-445 audit, GAP 2 + GAP 3) ──────────────────────
  //
  // Coverage alone never made a grant safe. These two rules are what stop the
  // allow-list drifting back into the shapes the audit failed it for, and they
  // are asserted here so a regression fails CI rather than a device.

  it("refuses a wildcard in the command arguments", () => {
    // The real defect: sudoers matches arguments as one concatenated string, so
    // this rule also matched `... start --no-block clawbox-setup.service ssh.service`
    // and `systemctl start` takes a list of units.
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block clawbox-*");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uses a wildcard/);
  });

  it("refuses a wildcard in the command path", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/local/libexec/clawbox/*.sh");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uses a wildcard/);
  });

  it("refuses a `?` wildcard too, not just `*`", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl start clawbox-gatewa?.service");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uses a wildcard/);
  });

  it("refuses a grant pointing into the clawbox-writable project tree", () => {
    // GAP 2 in one line: install.sh is clawbox:clawbox 0755 inside a
    // clawbox-writable directory, so this grant is passwordless local root for
    // anything that can already run code as clawbox.
    appendGrant("clawbox ALL=(root) NOPASSWD: /home/clawbox/clawbox/install.sh --step build");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/outside every root-owned prefix/);
  });

  it("refuses a grant on any other clawbox-writable location", () => {
    for (const target of ["/tmp/helper.sh", "/home/clawbox/.local/bin/hermes", "/var/tmp/x"]) {
      fs.copyFileSync(path.join(REPO, "config", "clawbox-sudoers"), grants());
      appendGrant(`clawbox ALL=(root) NOPASSWD: ${target}`);
      const r = run(fixture);
      expect(r.status, `${target} was accepted`).toBe(1);
      expect(r.stderr).toMatch(/outside every root-owned prefix/);
    }
  });

  it("refuses a relative command, which sudo would resolve through secure_path", () => {
    appendGrant("clawbox ALL=(root) NOPASSWD: systemctl reboot");
    const r = run(fixture);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/relative command/);
  });

  it("still accepts a root-owned libexec helper", () => {
    // The escape hatch the invariant leaves open, and the pattern every new
    // privileged helper is supposed to follow. Granting a path nothing calls is
    // an unused grant, not a shape error — so assert on the message, not the code.
    appendGrant("clawbox ALL=(root) NOPASSWD: /usr/local/libexec/clawbox/clawbox-new-helper.sh --go");
    const r = run(fixture);
    expect(r.stderr).not.toMatch(/outside every root-owned prefix|uses a wildcard/);
    expect(r.stderr).toMatch(/UNUSED grants/);
  });

  // A direct assertion that the SHIPPED files contain no wildcard lives in
  // root-steps.test.ts, which reads both drop-ins; the tests above prove the
  // checker is what fails CI when one comes back.

  it("lists what it matched", async () => {
    const r = (await shipped).list;
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/GRANTS \(\d+\):/);
    expect(r.stdout).toContain("/usr/local/libexec/clawbox/optimize-ollama.sh");
    expect(r.stdout).toContain("/usr/bin/systemctl start clawbox-root-update@chpasswd.service");
    expect(r.stdout).toMatch(/RESOLVED CALL SITES:/);
  });

  it("reports machine-readably", async () => {
    const r = (await shipped).json;
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.uncovered).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.unused).toEqual([]);
    expect(report.grants).toBeGreaterThan(30);
    expect(report.calls).toBeGreaterThan(30);
  });

  it("rejects an unknown flag instead of silently checking", () => {
    expect(run(REPO, ["--nope"]).status).toBe(2);
  });
});

describe("the call sites the allow-list has to cover", () => {
  // Every path the task brief names, traced end to end. If one of these stops
  // being covered the device loses that feature to a password prompt.
  it.runIf(CAN_RUN)("covers the wizard, updater, power, wifi, desktop and factory-reset paths", async () => {
    const out = (await shipped).list.stdout;
    for (const expected of [
      // setup wizard: hostname + hotspot hand-off, and the chpasswd hand-off
      "sudo /usr/bin/systemctl start clawbox-root-update@set_hostname.service",
      "sudo /usr/bin/systemctl start clawbox-root-update@restart_ap.service",
      "sudo /usr/bin/systemctl start clawbox-root-update@chpasswd.service",
      // power menu
      "sudo /usr/bin/systemctl reboot",
      "sudo /usr/bin/systemctl poweroff",
      // factory reset: mask, stop, unmask, reset password, reboot
      "sudo /usr/bin/systemctl --runtime mask clawbox-gateway.service",
      "sudo /usr/bin/systemctl --runtime unmask clawbox-gateway.service",
      "sudo /usr/bin/systemctl stop clawbox-gateway.service",
      // desktop / power-profile toggles, through the root-owned copies
      "sudo /usr/local/libexec/clawbox/clawbox-desktop-mode.sh --enable",
      "sudo /usr/local/libexec/clawbox/clawbox-desktop-mode.sh --disable",
      "sudo /usr/local/libexec/clawbox/clawbox-power-mode.sh --balanced",
      "sudo /usr/local/libexec/clawbox/clawbox-power-mode.sh --performance",
      // local models
      "sudo /usr/bin/systemctl enable --now ollama.service",
      "sudo /usr/bin/systemctl disable --now ollama.service",
      "sudo /usr/local/libexec/clawbox/optimize-ollama.sh",
      // remote control
      "sudo /usr/bin/systemctl restart clawbox-tunnel.service",
      "sudo /usr/bin/systemctl enable clawbox-tunnel.service",
    ]) {
      expect(out, `${expected} is no longer a resolved call site`).toContain(expected);
    }
  });
});

// ── A declaration is checked against the code, not believed ─────────────────
//
// DECLARED_ARGV is how a sudo call whose argv is not a literal array gets past
// the fail-closed resolver: someone writes down what the call can produce and
// that list is used instead. Writing it down is a review. Nothing kept the
// review honest afterwards.
//
// The shipped defect, exactly: the ClawKeep restore route's call read
// `["/usr/bin/systemctl", "restart", svc]` before and after a Hermes branch was
// added to the helper feeding `svc`. The call's source text — the only thing
// the declaration was keyed on — never changed, so the declaration went on
// claiming the site restarts clawbox-gateway.service while the code had grown a
// second unit with no grant at all. This check said "0 gaps"; a real Hermes box
// restored every file and then could not restart its own agent.
//
// So `resolve` now names the symbol the values come from, the checker
// re-resolves it on every run, and a declaration that has stopped matching the
// code is a build failure that names the drift.
let patchSeq = 0;

function runPatched(root: string, patch: (src: string) => string, args: string[] = []) {
  // Written OUTSIDE the fixture: a checker copy inside scripts/ would be
  // scanned as if it were product code.
  const file = path.join(os.tmpdir(), `clawbox-sudoers-checker-${process.pid}-${patchSeq++}.sh`);
  const patched = patch(fs.readFileSync(CHECKER, "utf-8"));
  fs.writeFileSync(file, patched);
  try {
    return spawnSync("bash", [file, ...args], {
      encoding: "utf-8",
      env: { ...process.env, CLAWBOX_REPO_ROOT: root },
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const declaring = (perl: string) => (src: string) => {
  const anchor = "my %DECLARED_ARGV = (";
  if (!src.includes(anchor)) throw new Error("DECLARED_ARGV anchor not found");
  return src.replace(anchor, `${anchor}\n${perl}`);
};
const exempting = (perl: string) => (src: string) => {
  const anchor = "my %EXEMPT_CALLS = (";
  if (!src.includes(anchor)) throw new Error("EXEMPT_CALLS anchor not found");
  return src.replace(anchor, `${anchor}\n${perl}`);
};

/**
 * A sudo call whose unit comes out of a helper — the shape that slipped
 * through. The CALL text is fixed; only the helper decides which units exist.
 */
function writeUnitProbe(hermes: string, openclaw: string, extraBody = "", returnLine = "") {
  fs.writeFileSync(
    path.join(fixture, "scripts/zz-probe.ts"),
    [
      'import { execFile } from "node:child_process";',
      "",
      "function zzUnits(edition: string): string[] {",
      ...(extraBody ? [extraBody] : []),
      returnLine
        || `  return edition === "hermes" ? ["${hermes}"] : ["${openclaw}"];`,
      "}",
      "",
      "export function zzRestart(edition: string) {",
      "  for (const svc of zzUnits(edition)) {",
      '    execFile("sudo", ["/usr/bin/systemctl", "restart", svc]);',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
}

const ZZ_KEY = `'scripts/zz-probe.ts :: "/usr/bin/systemctl", "restart", svc'`;
const zzDeclaration = (units: string[], extra = "resolve => { svc => 'zzUnits' },") =>
  `  ${ZZ_KEY} => {\n`
  + `    argv => [${units.map((u) => `['/usr/bin/systemctl', 'restart', '${u}']`).join(", ")}],\n`
  + `    ${extra}\n  },`;
const grantRestart = (unit: string) =>
  appendGrant(`clawbox ALL=(root) NOPASSWD: /usr/bin/systemctl restart ${unit}`);

d("a declaration is verified against its producer", () => {
  // THE REGRESSION. Reproduced in miniature: the helper grows a unit, the call
  // does not change, and the declaration is now a lie.
  it("fails when the helper grows a unit the declaration does not list", () => {
    writeUnitProbe("zz-hermes.service", "zz-openclaw.service");
    grantRestart("zz-openclaw.service");
    const r = runPatched(fixture, declaring(zzDeclaration(["zz-openclaw.service"])));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no longer describes the code/);
    expect(r.stderr).toMatch(/zz-hermes\.service/);
  });

  it("fails when the declaration lists a unit the code no longer produces", () => {
    writeUnitProbe("zz-hermes.service", "zz-openclaw.service");
    for (const u of ["zz-openclaw.service", "zz-hermes.service", "zz-ghost.service"]) grantRestart(u);
    const r = runPatched(
      fixture,
      declaring(zzDeclaration(["zz-openclaw.service", "zz-hermes.service", "zz-ghost.service"])),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no longer produced by the code/);
    expect(r.stderr).toMatch(/zz-ghost\.service/);
  });

  // The point of catching the drift: the NEW value is a new privileged command,
  // and it is the allow-list that has to have kept up.
  it("reports the newly resolved unit as uncovered when nothing grants it", () => {
    writeUnitProbe("zz-hermes.service", "zz-openclaw.service");
    grantRestart("zz-openclaw.service");
    const r = runPatched(
      fixture,
      declaring(zzDeclaration(["zz-openclaw.service", "zz-hermes.service"])),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNCOVERED sudo invocations/);
    expect(r.stderr).toMatch(/systemctl restart zz-hermes\.service/);
  });

  it("passes once the declaration and the allow-list have both caught up", () => {
    writeUnitProbe("zz-hermes.service", "zz-openclaw.service");
    grantRestart("zz-openclaw.service");
    grantRestart("zz-hermes.service");
    const r = runPatched(
      fixture,
      declaring(zzDeclaration(["zz-openclaw.service", "zz-hermes.service"])),
    );
    expect(r.stderr + r.stdout).toMatch(/0 gaps/);
    expect(r.status).toBe(0);
  });

  // Only the RETURN expressions of a helper are harvested. An unrelated array in
  // its body — a validation list, a message built from a template literal — is
  // not a set of privileged arguments, and demanding grants for it would push
  // the next author into widening the allow-list to silence this check.
  it("ignores an array literal that is not part of a return expression", () => {
    writeUnitProbe(
      "zz-hermes.service",
      "zz-openclaw.service",
      '  const known = ["not-a-unit", "also-not-a-unit"];\n  void known;',
    );
    grantRestart("zz-openclaw.service");
    grantRestart("zz-hermes.service");
    const r = runPatched(
      fixture,
      declaring(zzDeclaration(["zz-openclaw.service", "zz-hermes.service"])),
    );
    expect(r.stderr).not.toMatch(/not-a-unit/);
    expect(r.status).toBe(0);
  });

  // Comments are stripped before any symbol is looked up, so a commented-out
  // return contributes nothing. Pinned here rather than left implicit: the
  // stripping happens in verify_declaration and is passed DOWN into the
  // resolver, so resolving against the raw source instead would silently bring
  // this back — as a phantom unit reported uncovered, which is the direction
  // that pressures the next author into adding a grant.
  it("does not read units out of commented-out code", () => {
    writeUnitProbe(
      "zz-hermes.service",
      "zz-openclaw.service",
      '  // return ["cr-line-comment.service"];\n'
      + '  /* return ["cr-block-comment.service"]; */',
    );
    grantRestart("zz-openclaw.service");
    grantRestart("zz-hermes.service");
    const r = runPatched(
      fixture,
      declaring(zzDeclaration(["zz-openclaw.service", "zz-hermes.service"])),
    );
    expect(r.stderr).not.toMatch(/cr-line-comment|cr-block-comment/);
    expect(r.status).toBe(0);
  });

  it("does not read units out of a comment inside the return expression", () => {
    writeUnitProbe(
      "zz-hermes.service",
      "zz-openclaw.service",
      "",
      '  return edition === "hermes"\n'
      + '    ? ["zz-hermes.service"] // ["cr-trailing.service"]\n'
      + '    : /* ["cr-inline.service"] */ ["zz-openclaw.service"];',
    );
    grantRestart("zz-openclaw.service");
    grantRestart("zz-hermes.service");
    const r = runPatched(
      fixture,
      declaring(zzDeclaration(["zz-openclaw.service", "zz-hermes.service"])),
    );
    expect(r.stderr).not.toMatch(/cr-trailing|cr-inline/);
    expect(r.status).toBe(0);
  });

  // Fail-closed for anything new: a dynamic argument nobody described is how a
  // privileged command reaches a device without ever being reviewed.
  it("refuses a declaration that says nothing about its dynamic argument", () => {
    writeUnitProbe("zz-hermes.service", "zz-openclaw.service");
    grantRestart("zz-openclaw.service");
    const r = runPatched(fixture, declaring(zzDeclaration(["zz-openclaw.service"], "")));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/says nothing about the dynamic argument `svc`/);
  });

  it("accepts `unverified` only with a reason", () => {
    writeUnitProbe("zz-hermes.service", "zz-openclaw.service");
    grantRestart("zz-openclaw.service");
    const empty = runPatched(
      fixture,
      declaring(zzDeclaration(["zz-openclaw.service"], "unverified => { svc => '' },")),
    );
    expect(empty.status).toBe(1);
    expect(empty.stderr).toMatch(/needs a reason/);
  });

  it("refuses a `resolve` pointed at a symbol that does not exist", () => {
    writeUnitProbe("zz-hermes.service", "zz-openclaw.service");
    grantRestart("zz-openclaw.service");
    const r = runPatched(
      fixture,
      declaring(zzDeclaration(["zz-openclaw.service"], "resolve => { svc => 'zzNoSuchThing' },")),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/does not define as a const array, Set, object/);
  });

  // The other direction: a reviewed decision must not outlive its call site.
  it("refuses a declaration whose call site no longer exists", () => {
    const r = runPatched(
      fixture,
      declaring("  'src/gone.ts :: a, b' => { argv => [['sudo', '/usr/bin/systemctl', 'reboot']],"
        + " unverified => { a => 'gone', b => 'gone' } },"),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/matches no sudo call site in the tree/);
  });

  it("refuses an exemption nothing uses", () => {
    const r = runPatched(fixture, exempting("  'src/gone.ts :: bin, argv' => 'no longer real',"));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/matches no unresolved sudo call site/);
  });

  // Proof that the declarations the repo really ships are being verified rather
  // than skipped: break one of them and the real tree fails.
  it("verifies the declarations the repo itself ships", () => {
    const r = runPatched(REPO, (src) => {
      const before = "      ['/usr/bin/systemctl', 'poweroff'],\n      ['/usr/bin/systemctl', 'reboot'],";
      if (!src.includes(before)) throw new Error("power-route declaration not found");
      return src.replace(before, "      ['/usr/bin/systemctl', 'poweroff'],");
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no longer describes the code/);
    expect(r.stderr).toMatch(/reboot/);
  });
});
