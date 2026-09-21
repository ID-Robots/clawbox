import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `scripts/gateway-pre-start.sh` runs under `set -euo pipefail` as the
 * gateway unit's `ExecStartPre`. Its generation probe was
 *
 *     CLAWBOX_OPENCLAW_EFFECTIVE="$("$OPENCLAW_BIN" --version 2>/dev/null \
 *       | grep -oE '20[0-9]{2}\.[0-9]+\.[0-9]+' | head -1)"
 *
 * and the comment beneath it assumed an empty result when the CLI cannot
 * answer. It did not get one. `grep -oE` exits 1 when it matches nothing,
 * `pipefail` carries that to the pipeline, and an assignment whose command
 * substitution failed aborts the script under `set -e`. A box whose `openclaw`
 * binary exists but cannot print its version — a crash, a node engine
 * mismatch, a banner the regex does not match — therefore got NO gateway and
 * no chat at all, with the only trace in the unit's ExecStartPre failure
 * (TASK-657). A missing binary is already handled: the script exits 0 a few
 * lines above.
 *
 * The generation now comes from the installed core's own `package.json` — the
 * file the binary IS — with a time-boxed `--version` behind it. That is the
 * source `scripts/ensure-local-embeddings.sh` and `src/lib/memory-shard.ts`
 * already use, in both cases with a written "never `openclaw --version`, it
 * costs ~10 s on a Jetson" rationale; measured on a shipped Orin, the CLI takes
 * 7.9 s and the manifest 53 ms, inside a BLOCKING ExecStartPre.
 *
 * And when the core cannot be identified at all, the script writes NOTHING and
 * boots on the config already on disk. The pin is deliberately not a fallback:
 * a partially failed update is exactly the state where the core cannot answer
 * AND the pin is ahead of it, so a pin fallback would fire precisely when it is
 * wrong — writing v2 keys a v1 gateway refuses and permanently deleting
 * `commands.ownerDisplay`, `gateway.tailscale.resetOnExit` and
 * `agents.defaults.compaction.reserveTokensFloor`, which nothing on the boot
 * path re-adds.
 *
 * These tests EXECUTE the shipped blocks under `set -euo pipefail` against
 * stubs. The rule they pin is the one the boot path needs: every read here
 * either resolves, or says so and carries on, and none of them can take the
 * gateway down.
 */

// Starts a real process (bash / python3 / node / git): vitest's 5 s test and
// 10 s hook defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const PRE_START = readFileSync(path.join(REPO, "scripts", "gateway-pre-start.sh"), "utf-8");

const canRun =
  process.platform !== "win32" && spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "clawbox-version-probe-"));
});
afterEach(() => {
  // The unreadable-file cases leave a 0000 file behind.
  try {
    chmodSync(path.join(root, "pin.txt"), 0o644);
  } catch { /* not every case writes one */ }
  try {
    chmodSync(path.join(root, "hostname.env"), 0o644);
  } catch { /* not every case writes one */ }
  rmSync(root, { recursive: true, force: true });
});

/** Slice a region of the shipped script by its first and last line. */
function block(fromLine: string, toLine: string): string {
  const start = PRE_START.indexOf(fromLine);
  if (start < 0) throw new Error(`slice start not found: ${fromLine}`);
  const end = PRE_START.indexOf(toLine, start);
  if (end < 0) throw new Error(`slice end not found: ${toLine}`);
  return PRE_START.slice(start, end + toLine.length);
}

function run(program: string): { status: number | null; out: string; stderr: string } {
  const file = path.join(root, "block.sh");
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${program}\n`);
  chmodSync(file, 0o755);
  // `spawnSync` inherits process.env, and an explicit CLAWBOX_OPENCLAW_V2 WINS
  // over everything the probe derives — by design, and the shipped script says
  // so. Nothing in this repo exports it today, so this is future-proofing
  // against a runner (or a shell on a box) that does, and it is not symmetric:
  // an ambient `=0` makes the v1-pinning assertions pass against ANY block,
  // including beta's, which is the case that would hide a regression; an
  // ambient `=1` makes the "writes NOTHING" case fail loudly instead.
  // Deleted rather than emptied: "unset" is the state a device is in.
  const env = { ...process.env };
  delete env.CLAWBOX_OPENCLAW_V2;
  const r = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000, env });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stderr: r.stderr ?? "" };
}

/**
 * Skip ONLY where root's extra privilege changes which branch the shipped block
 * takes, and the rule is narrow: `[ -r "$f" ]` and `[ -w "$dir" ]` answer
 * differently for root, so a 0000 file (or a 0555 directory) is a no-op for it
 * and the case would pass by taking the happy path and prove nothing. Nothing
 * else here is uid-dependent — the mode grading reads `stat -c %a`, the `chmod`
 * stub fails for every user alike, and `umask 077` yields 0600 for root too —
 * so a case whose branch turns on the MODE runs everywhere, and skipping it
 * would only cost coverage on a box (CI is non-root; a `sudo npm test` is not).
 */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

interface Probe {
  status: number | null;
  out: string;
  /** Only what went to fd 2 — the stream the WARNs promise. */
  stderr: string;
  /** The version the block settled on, or null when it never got that far. */
  effective: string | null;
  /** The generation it exported, or null when it never got that far. */
  v2: string | null;
}

/**
 * Run the pin + generation probe with a scripted `openclaw` stub.
 *
 * `cli` is the stub's body. `pin` is the contents of the pin file, or null for
 * no pin file at all; `pinUnreadable` makes the file exist but deny reads.
 */
function probe(opts: {
  cli: string;
  pin?: string | null;
  pinUnreadable?: boolean;
  /** The version in the installed core's package.json, or null for no manifest. */
  pkg?: string | null;
}): Probe {
  // The binary and its manifest, laid out the way npm does it: <prefix>/bin/openclaw
  // beside <prefix>/lib/node_modules/openclaw/package.json.
  const bin = path.join(root, "bin", "openclaw");
  mkdirSync(path.dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env bash\n${opts.cli}\n`);
  chmodSync(bin, 0o755);
  if (opts.pkg !== null && opts.pkg !== undefined) {
    const pkgDir = path.join(root, "lib", "node_modules", "openclaw");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version: opts.pkg }));
  }
  const pinFile = path.join(root, "pin.txt");
  if (opts.pin !== null) {
    writeFileSync(pinFile, opts.pin ?? "2026.8.1\n");
    if (opts.pinUnreadable) chmodSync(pinFile, 0o000);
  }

  const r = run(
    [
      `OPENCLAW_BIN=${JSON.stringify(bin)}`,
      `OPENCLAW_PIN_FILE=${JSON.stringify(pinFile)}`,
      block('OPENCLAW_TARGET=""', "export CLAWBOX_OPENCLAW_V2"),
      'echo "EFFECTIVE=${CLAWBOX_OPENCLAW_EFFECTIVE}"',
      'echo "V2=${CLAWBOX_OPENCLAW_V2}"',
      'echo "REACHED_END=1"',
    ].join("\n"),
  );
  return {
    status: r.status,
    out: r.out,
    stderr: r.stderr,
    effective: /EFFECTIVE=(.*)/.exec(r.out)?.[1] ?? null,
    v2: /V2=(.*)/.exec(r.out)?.[1] ?? null,
  };
}

describe.runIf(canRun)("gateway-pre-start's OpenClaw generation probe", () => {
  it("reads the installed core's own manifest, without running it", () => {
    // ~10 s on a Jetson vs 53 ms for the manifest, in a BLOCKING ExecStartPre.
    // The stub leaves a FILE behind rather than a line on a stream: the shipped
    // call is `--version 2>/dev/null` and the command substitution swallows its
    // stdout, so neither stream can carry the marker out and an assertion on
    // `r.out` would pass against a block that ran the CLI every time.
    const ranMarker = path.join(root, "cli-was-run");
    const r = probe({ cli: `: > ${JSON.stringify(ranMarker)}\necho "openclaw 2026.9.9"`, pkg: "2026.8.1" });
    expect(r.status).toBe(0);
    expect(r.effective).toBe("2026.8.1");
    expect(r.v2).toBe("1");
    expect(existsSync(ranMarker), "the CLI was run even though the manifest answered").toBe(false);
  });

  it("asks the binary when there is no manifest to read", () => {
    const r = probe({ cli: 'echo "openclaw 2026.8.1"', pkg: null });
    expect(r.status).toBe(0);
    expect(r.effective).toBe("2026.8.1");
    expect(r.v2).toBe("1");
  });

  /**
   * What `openclaw --version` costs on a HEALTHY shipped Orin, measured on a
   * box: 7.9-8.0 s, and a cold first boot is the slow case. Rounded up, and
   * stated here rather than in a bare number below, because both bounds are
   * derived from it.
   */
  const MEASURED_VERSION_SECONDS = 8;

  it("time-boxes that call with a value the boot can actually afford", () => {
    const probeBlock = block('OPENCLAW_TARGET=""', "export CLAWBOX_OPENCLAW_V2");
    const m = /timeout (?:-k (\d+) )?(\d+) "\$OPENCLAW_BIN" --version/.exec(probeBlock);
    expect(m, "the version probe is no longer time-boxed at all").not.toBeNull();
    // Plain `timeout` sends SIGTERM only. A `--version` that ignores it would
    // hold this ExecStartPre for the unit's whole start budget — precisely the
    // outcome the bound exists to prevent — so the SIGKILL escalation is part
    // of the behaviour, not a stylistic choice.
    expect(m![1], "the bound sends SIGTERM only, so a wedged --version outlives it").toBeDefined();
    expect(Number(m![1])).toBeGreaterThan(0);
    const seconds = Number(m![2]);
    // The bound is asserted against what it has to survive and what it has to
    // stay inside, not against a literal: a number pinned to a precedent goes
    // stale the moment the precedent moves.
    //
    // Floor — it must leave several multiples of the measured healthy cost as
    // headroom, or it cuts off a WORKING core and makes the fallback fire
    // exactly when it is not needed. `\d+` alone accepted `timeout 1`.
    expect(
      seconds,
      `a healthy --version measures ~${MEASURED_VERSION_SECONDS}s on a shipped Orin; this bound cuts it off`,
    ).toBeGreaterThanOrEqual(3 * MEASURED_VERSION_SECONDS);
    // Ceiling — it has to stay well inside the unit's own budget, read from the
    // shipped unit rather than repeated here: ExecStartPre running out of time
    // is a gateway that never starts, so a lowered TimeoutStartSec has to fail
    // here. Half the budget, not merely under it: this is one OPTIONAL probe
    // and the rest of the pre-start still has to run after it.
    const unit = readFileSync(path.join(REPO, "config", "clawbox-gateway.service"), "utf-8");
    const budget = Number(/^TimeoutStartSec=(\d+)$/m.exec(unit)?.[1]);
    expect(budget, "clawbox-gateway.service no longer states TimeoutStartSec in seconds").toBeGreaterThan(0);
    expect(seconds, "one optional probe may not claim half the unit's start budget").toBeLessThanOrEqual(budget / 2);
  });

  it("still calls a v1 core v1, whatever the pin says", () => {
    // The INSTALLED core is the authority, because it is the process that
    // parses what this script writes.
    const r = probe({ cli: "exit 1", pkg: "2026.7.4", pin: "2026.8.1\n" });
    expect(r.status).toBe(0);
    expect(r.effective).toBe("2026.7.4");
    expect(r.v2).toBe("0");
  });

  for (const [name, cli] of [
    ["exits non-zero saying nothing", "exit 1"],
    ["crashes with a stack trace on stderr", 'echo "Error: bad engine" >&2; exit 7'],
    ["prints a banner the regex does not match", 'echo "openclaw (development build)"'],
    ["prints nothing at all and succeeds", "exit 0"],
  ] as const) {
    it(`reads the manifest when the CLI ${name}, instead of taking the gateway down`, () => {
      // Before TASK-657: the pipeline failed, `set -e` aborted the whole
      // pre-start, and the unit never started the gateway.
      const r = probe({ cli, pkg: "2026.8.1", pin: "2026.7.0\n" });
      expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
      expect(r.effective).toBe("2026.8.1");
      expect(r.v2).toBe("1");
      expect(r.out).toContain("REACHED_END=1");
    });
  }

  it("writes NOTHING when the installed core cannot be identified at all", () => {
    // The pin is deliberately not a fallback: a partially failed update is
    // exactly the state where the core cannot answer AND the pin is ahead of
    // it, so guessing from it would write v2 keys a v1 gateway refuses and
    // permanently delete keys nothing on the boot path re-adds. Boot on the
    // config that already worked.
    const r = probe({ cli: "exit 1", pkg: null, pin: "2026.8.1\n" });
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.out, "it decided a generation it could not know").not.toContain("REACHED_END=1");
    expect(r.stderr).toMatch(/cannot tell which OpenClaw generation/);
    expect(r.stderr).toMatch(/leaving openclaw.json exactly as it is/);
    // The skipped pre-start is not only the generation-sensitive rewrites, so
    // the WARN must name what this boot does NOT re-apply.
    expect(r.stderr).toMatch(/auth token/i);
    expect(r.stderr).toMatch(/allowedOrigins/);
  });

  for (const version of ["0.0.0-dev", "1.2.3", "next", "2026.8"] as const) {
    it(`refuses to call a core v1 on a version it cannot read as a date (${version})`, () => {
      // The manifest read accepted ANY non-empty string, while the CLI
      // fallback right beneath it applied `grep -oE '20[0-9]{4}...'`. So the
      // two sources validated differently and the stricter one was the one
      // almost never reached: a dev/nightly build, a fork, an
      // `npm i -g <git url>` install or a vendor rebuild sailed past the
      // "write nothing" guard as a non-empty value and selected v1 semantics
      // on a core that may well be v2 — which then refuses the legacy
      // messages.tts / imageGenerationModel / allowInsecureAuth names this
      // script would write, and never reports ready. Exactly the outcome this
      // change exists to make impossible, through a different door.
      const r = probe({ cli: "exit 1", pkg: version, pin: "2026.8.1\n" });
      expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
      expect(r.out, "it decided a generation it could not know").not.toContain("REACHED_END=1");
      expect(r.stderr).toMatch(/cannot tell which OpenClaw generation/);
    });
  }

  it("takes a date out of the CLI banner even when the manifest was rejected", () => {
    // The two sources are graded DIFFERENTLY on purpose, and the difference is
    // only visible when both arms run — every case above pairs a rejected
    // manifest with a CLI that cannot answer, so none of them sees it. The
    // manifest holds a version FIELD, so the whole string must be the version
    // (`^20…`). The CLI prints a BANNER, where the version is one token among
    // words this script does not control, so that arm can only EXTRACT — which
    // means a banner mentioning any other date-shaped number is taken at face
    // value. Pinned rather than tightened: an anchor that is wrong by one space
    // turns every healthy fallback into "cannot identify the core" and skips
    // the whole pre-start fleet-wide, and the real banner of a shipped core has
    // not been measured. If this assertion ever has to change, that measurement
    // is the thing to take first.
    const r = probe({ cli: 'echo "openclaw 0.0.0-dev (built from 2026.8.1)"', pkg: "0.0.0-dev" });
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.effective).toBe("2026.8.1");
    expect(r.v2).toBe("1");
  });

  it("still reads a real date version, suffix and all", () => {
    // The control for the four above: the shape check must not reject the
    // versions the fleet actually runs.
    const r = probe({ cli: "exit 1", pkg: "2026.8.1-rc.2" });
    expect(r.status).toBe(0);
    expect(r.effective).toBe("2026.8.1");
    expect(r.v2).toBe("1");
  });

  for (const [name, pkg] of [
    ["is not valid JSON", "@@corrupt@@"],
    ["is empty", ""],
    ["carries no version at all", "{}"],
    ["carries a non-string version", '{"version":{"major":2026}}'],
  ] as const) {
    it(`falls through to the CLI when the manifest ${name}`, () => {
      const pkgDir = path.join(root, "lib", "node_modules", "openclaw");
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(path.join(pkgDir, "package.json"), pkg);
      const r = probe({ cli: 'echo "openclaw 2026.8.1"', pkg: null });
      expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
      expect(r.effective).toBe("2026.8.1");
    });
  }

  it.skipIf(isRoot)("falls through to the CLI when the manifest cannot be read", () => {
    const pkgDir = path.join(root, "lib", "node_modules", "openclaw");
    mkdirSync(pkgDir, { recursive: true });
    const manifest = path.join(pkgDir, "package.json");
    writeFileSync(manifest, JSON.stringify({ version: "2026.8.1" }));
    chmodSync(manifest, 0o000);
    try {
      const r = probe({ cli: 'echo "openclaw 2026.7.4"', pkg: null });
      expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
      expect(r.effective).toBe("2026.7.4");
    } finally {
      chmodSync(manifest, 0o644);
    }
  });

  it("lets an explicit generation win over a core it cannot identify", () => {
    // The comment above this check says an explicit CLAWBOX_OPENCLAW_V2 "wins".
    // With the write-nothing exit 0 placed above it, a pinned generation became
    // a silent no-op instead — and every sibling suite pins BOTH generations
    // of this script that way.
    const bin = path.join(root, "bin", "openclaw");
    mkdirSync(path.dirname(bin), { recursive: true });
    writeFileSync(bin, "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(bin, 0o755);
    const r = run(
      [
        "CLAWBOX_OPENCLAW_V2=1",
        `OPENCLAW_BIN=${JSON.stringify(bin)}`,
        `OPENCLAW_PIN_FILE=${JSON.stringify(path.join(root, "absent.txt"))}`,
        block('OPENCLAW_TARGET=""', "export CLAWBOX_OPENCLAW_V2"),
        'echo "V2=${CLAWBOX_OPENCLAW_V2}"',
        'echo "REACHED_END=1"',
      ].join("\n"),
    );
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.out).toContain("REACHED_END=1");
    expect(r.out).toContain("V2=1");
  });

  it("carries on when the pin file exists but cannot be read", () => {
    // Same class, same script, one screen up: `head` on an unreadable file
    // exits non-zero and pipefail carries it into the assignment.
    const r = probe({ cli: "exit 1", pkg: "2026.8.1", pin: "2026.8.1\n", pinUnreadable: true });
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.effective).toBe("2026.8.1");
  });
});

describe.runIf(canRun)("gateway-pre-start's mDNS hostname read", () => {
  function hostname(opts: { contents?: string; unreadable?: boolean }): { status: number | null; name: string | null; out: string } {
    const env = path.join(root, "hostname.env");
    writeFileSync(env, opts.contents ?? "HOSTNAME=someboxname\n");
    if (opts.unreadable) chmodSync(env, 0o000);
    const r = run(
      [
        `HOSTNAME_ENV=${JSON.stringify(env)}`,
        block('CONFIGURED_HOSTNAME="clawbox"', "\n# Build the dynamic part of the allowedOrigins list"),
        'echo "NAME=${CONFIGURED_HOSTNAME}"',
      ].join("\n"),
    );
    return { status: r.status, name: /NAME=(.*)/.exec(r.out)?.[1] ?? null, out: r.out };
  }

  it("reads the configured hostname", () => {
    const r = hostname({});
    expect(r.status).toBe(0);
    expect(r.name).toBe("someboxname");
  });

  it("falls back to clawbox when the file cannot be read, instead of aborting", () => {
    // `sed` exits 2 on a file it cannot open, pipefail carries it, and the
    // gateway never starts — the same defect as the version probe.
    if (isRoot) return; // 0000 is a no-op for root; the case would prove nothing
    const r = hostname({ unreadable: true });
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.name).toBe("clawbox");
    // Not silent: this name rebuilds gateway.controlUi.allowedOrigins, so a
    // fallback drops the configured origin and the Control UI stops being
    // reachable by the name the owner uses.
    expect(r.out).toMatch(/WARN/);
  });
});

// The MCP token is the SOLE credential for `/setup-api/*`: `mcp/lib/api.ts`
// sends it as a bearer and `src/middleware.ts` accepts it. Its `chmod 600` used
// to run unguarded under `set -euo pipefail`, so a token file another uid owns
// — a root update step, a manual repair — returned EPERM and cost the box its
// gateway on EVERY boot from then on (TASK-657). Guarding it turned that into a
// warning, which is the opposite failure: the unit runs as User=clawbox
// (config/clawbox-gateway.service), root's umask gives `openssl rand > file`
// mode 0644, and the block below then read that file and exported it.
//
// So the outcome that matters is the MODE, not the chmod's exit code.
describe.runIf(canRun)("gateway-pre-start's MCP token hardening", () => {
  /** 64 hex chars: long enough that the seeding branch above leaves it alone. */
  const EXISTING = "a".repeat(64);

  function token(opts: {
    contents?: string;
    mode?: number;
    chmodFails?: boolean;
    /** What a stubbed `stat -c %a` reports, for a mode this uid cannot produce. */
    statSays?: string;
    /**
     * Permission bits to leave on `data/` itself. 0500 is the state where the
     * block can neither seed a token nor replace one: `mktemp` and the redirect
     * both fail, and nothing downstream may turn that into a failed unit.
     */
    dataMode?: number;
    /**
     * What a stubbed `openssl rand -hex 32` writes. The seeding branch's own
     * length check runs BEFORE the write, so a write that returns 0 having
     * emitted only part of the token is the one way a short file survives to
     * the registration below.
     */
    opensslWrites?: string;
  }): {
    status: number | null;
    out: string;
    /** The file's permission bits after the block ran, or null if it is gone. */
    mode: number | null;
    /** Its contents after the block ran. */
    contents: string | null;
    /** What the block exported, which is what reaches the MCP subprocess. */
    exported: string | null;
  } {
    const clawboxRoot = path.join(root, "clawbox");
    mkdirSync(path.join(clawboxRoot, "data"), { recursive: true });
    const file = path.join(clawboxRoot, "data", ".mcp-token");
    if (opts.contents !== undefined) {
      writeFileSync(file, opts.contents);
      chmodSync(file, opts.mode ?? 0o600);
    }
    // A `chmod` that fails is the only way to reproduce EPERM without being two
    // different users; everything else on PATH stays real, because the recovery
    // has to work with the chmod that just failed.
    const stubBin = path.join(root, "stub-bin");
    mkdirSync(stubBin, { recursive: true });
    if (opts.chmodFails) {
      const stub = path.join(stubBin, "chmod");
      writeFileSync(stub, "#!/bin/sh\necho \"chmod: changing permissions: Operation not permitted\" >&2\nexit 1\n");
      chmodSync(stub, 0o755);
    }
    // The one mode this uid cannot actually create: another user's 0600, which
    // `stat` reports as 600 while every read of it is denied.
    if (opts.statSays !== undefined) {
      const stub = path.join(stubBin, "stat");
      writeFileSync(stub, `#!/bin/sh\necho ${opts.statSays}\n`);
      chmodSync(stub, 0o755);
    }
    // A truncated write that reports success: `openssl` exits 0 having emitted
    // less than the token it was asked for, which is what an ENOSPC part way
    // through the redirect leaves behind.
    if (opts.opensslWrites !== undefined) {
      const stub = path.join(stubBin, "openssl");
      writeFileSync(stub, `#!/bin/sh\nprintf %s ${JSON.stringify(opts.opensslWrites)}\n`);
      chmodSync(stub, 0o755);
    }
    if (opts.dataMode !== undefined) chmodSync(path.join(clawboxRoot, "data"), opts.dataMode);
    const r = run(
      [
        `CLAWBOX_ROOT=${JSON.stringify(clawboxRoot)}`,
        `PATH=${JSON.stringify(stubBin)}:$PATH`,
        block('MCP_TOKEN_FILE="$CLAWBOX_ROOT/data/.mcp-token"', "export CLAWBOX_MCP_TOKEN_VAL"),
        'echo "EXPORTED=${CLAWBOX_MCP_TOKEN_VAL}"',
        'echo "REACHED_END=1"',
      ].join("\n"),
    );
    // Put the directory back before anything reads through it, including the
    // afterEach cleanup.
    if (opts.dataMode !== undefined) chmodSync(path.join(clawboxRoot, "data"), 0o755);
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : null;
    // A case that leaves the token unreadable to this uid must still be
    // reportable: the mode is already captured, so open it up for the
    // contents read and for the tmpdir cleanup.
    try {
      chmodSync(file, 0o600);
    } catch {
      /* the block may have removed it */
    }
    return {
      status: r.status,
      out: r.out,
      mode,
      contents: existsSync(file) ? readFileSync(file, "utf-8") : null,
      exported: /EXPORTED=(.*)/.exec(r.out)?.[1] ?? null,
    };
  }

  it("hardens an existing token and leaves it exactly as it was", () => {
    const r = token({ contents: EXISTING, mode: 0o644 });
    expect(r.status).toBe(0);
    expect(r.mode).toBe(0o600);
    // The control for the rotation below: a chmod that WORKS must not rotate.
    expect(r.contents).toBe(EXISTING);
    expect(r.exported).toBe(EXISTING);
  });

  it("never exports a token other local users can read", () => {
    // The file root created at 0644 and clawbox cannot chmod. Warning and
    // carrying on hands the only /setup-api/* credential to every local user.
    const r = token({ contents: EXISTING, mode: 0o644, chmodFails: true });
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.mode, "the token was left readable by group/other").not.toBeNull();
    expect(r.mode! & 0o077, `token left at mode ${r.mode!.toString(8)}`).toBe(0);
    // Not silently: the operator has a root-owned file to clean up.
    expect(r.out).toMatch(/WARN/);
    // And the box still has a working MCP token — the alternative to exposure
    // is not a gateway that never starts.
    expect(r.exported).toHaveLength(64);
    // What the file holds is what reaches the MCP subprocess (`openssl rand`
    // leaves a trailing newline; `$(cat …)` strips it).
    expect(r.exported).toBe(r.contents!.trim());
    expect(r.exported).not.toBe(EXISTING);
    expect(r.out).toContain("REACHED_END=1");
  });

  it("does not rotate, or warn, over a file that is already 0600", () => {
    // chmod on a root-owned file fails whatever its mode is. The old warning
    // fired here too, over a box with nothing wrong with it.
    const r = token({ contents: EXISTING, mode: 0o600, chmodFails: true });
    expect(r.status).toBe(0);
    expect(r.mode).toBe(0o600);
    expect(r.contents).toBe(EXISTING);
    expect(r.out).not.toMatch(/WARN/);
  });

  it.skipIf(isRoot)("replaces a token this gateway cannot read, instead of refusing to boot", () => {
    // The state the fleet's writers ACTUALLY produce when they run as root is
    // root:root 0600, not 0644: scripts/register-mcp.sh chmods 600 on the line
    // after its redirect, and production-server.js writes { mode: 0o600 }. That
    // file is unreadable to User=clawbox and unchmoddable by it — and grading
    // the mode on the literal string "600" declined to touch it, so the
    // `[ ! -r "$MCP_TOKEN_FILE" ] → exit 1` three lines below fired: ExecStartPre
    // fails, no gateway, on every boot until someone with shell access fixes
    // the mode. That is TASK-657's own headline defect, standing inside the one
    // block that carries the remedy for it.
    //
    // Reproduced without being two users: the file is 0000 (every read denied,
    // exactly as another user's 0600 is), `chmod` fails the way it does on
    // another user's file, and `stat` reports the 600 those writers leave.
    const r = token({ contents: EXISTING, mode: 0o000, chmodFails: true, statSays: "600" });
    expect(r.status, `the pre-start aborted, so the box gets no gateway:\n${r.out}`).toBe(0);
    expect(r.out).toContain("REACHED_END=1");
    // Replaced, and the replacement is this uid's own 0600 token.
    expect(r.mode! & 0o077).toBe(0);
    expect(r.exported).toHaveLength(64);
    expect(r.exported).not.toBe(EXISTING);
    expect(r.out).toMatch(/WARN/);
    // A rotation reaches the MCP subprocess (the reconcile below rewrites
    // openclaw.json) but NOT the verifier in the web server, which holds its
    // own copy — so the WARN has to name the unit that must pick the new
    // bearer up. See src/lib/mcp-token.ts.
    expect(r.out).toMatch(/clawbox-setup/);
  });

  it("leaves a readable token no other user can read exactly as it is", () => {
    // 0400 and 0000-that-this-uid-owns are exposed to NOBODY. Grading the mode
    // on the literal "600" rotated both of them, and rotating a credential that
    // was never exposed is pure cost: it invalidates the bearer the web server
    // is holding for no benefit at all. The `& 077` grading is what makes this
    // case a no-op, and nothing else in this block pins it.
    const r = token({ contents: EXISTING, mode: 0o400, chmodFails: true });
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.contents, "a token no other user can read was rotated anyway").toBe(EXISTING);
    expect(r.exported).toBe(EXISTING);
    expect(r.out).not.toMatch(/WARN/);
  });

  it.skipIf(isRoot)("boots without a bearer it can neither seed nor replace, instead of failing the unit", () => {
    // The last unguarded step in the block, and it made every guard above it
    // decorative: when the seeding AND the replacement both fail — `data/` not
    // writable — control fell out of the "left exactly as it stands" WARN
    // straight into `ERROR: MCP token file is not readable → exit 1`.
    // `ExecStartPre=` carries no `-` prefix, so that fails the unit and
    // Restart=always spends StartLimitBurst: no gateway and no chat, on every
    // boot. Not privileged, either — `data/` is clawbox-owned at 0755, so any
    // process running as clawbox reaches it with `rm .mcp-token; chmod 500 .`.
    // A missing bearer costs this boot its MCP tools, exactly like the failed
    // registration write below it, which has always been a WARN. TASK-657.
    const r = token({ dataMode: 0o500 });
    expect(r.status, `the pre-start aborted, so the box gets no gateway:\n${r.out}`).toBe(0);
    expect(r.out).toContain("REACHED_END=1");
    // Said, and said as what it costs — not as an error, and not silently.
    expect(r.out).toMatch(/WARN: MCP token file is not readable/);
    expect(r.out).toMatch(/MCP tools are unavailable this boot/);
    expect(r.out).not.toMatch(/ERROR/);
    // Empty, deliberately: the reconcile's python sys.exit(0)s on it, so
    // openclaw.json keeps whatever it already had rather than being rewritten
    // with a token this boot never read.
    expect(r.exported).toBe("");
  });

  it("does not register a bearer a truncated write left too short to be one", () => {
    // The seeding gate re-seeds anything under 32 bytes, so a shorter file can
    // only be one whose own write did not finish — ENOSPC part way through
    // `openssl rand -hex 32 > "$1"`, on the boot where the seed failed and
    // `|| true` swallowed it. That length check ran BEFORE the write, and
    // nothing between it and the registration looked at the value again: the
    // block exported a truncated bearer and the reconcile published it to
    // openclaw.json as if the box had generated it.
    //
    // The window that matters is 16–31 characters, because it WORKS:
    // src/lib/mcp-token.ts's readTokenFile() accepts 16 and up, so the box runs
    // on a bearer with a fraction of the intended entropy and nothing says so.
    // (Under 16 the verifier mints its own value instead and every tool call
    // 307s to /login — broken, but at least loudly.)
    const r = token({ opensslWrites: "a".repeat(20) });
    expect(r.status, `the pre-start aborted, so the box gets no gateway:\n${r.out}`).toBe(0);
    expect(r.out).toContain("REACHED_END=1");
    expect(r.contents, "the fixture never produced a short token").toBe("a".repeat(20));
    // Refused, and said as what it costs — the same shape as the empty case.
    expect(r.exported).toBe("");
    expect(r.out).toMatch(/WARN: MCP token file holds only 20 characters/);
    expect(r.out).toMatch(/MCP tools are unavailable this boot/);
    expect(r.out).not.toMatch(/ERROR/);
  });

  it("seeds a missing token at 0600 without a chmod to do it", () => {
    const r = token({ chmodFails: true });
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.mode! & 0o077).toBe(0);
    expect(r.exported).toHaveLength(64);
  });
});
