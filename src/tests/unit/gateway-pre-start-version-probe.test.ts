import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
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

function run(program: string): { status: number | null; out: string } {
  const file = path.join(root, "block.sh");
  writeFileSync(file, `#!/usr/bin/env bash\nset -euo pipefail\n${program}\n`);
  chmodSync(file, 0o755);
  const r = spawnSync("bash", [file], { encoding: "utf-8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

interface Probe {
  status: number | null;
  out: string;
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
    effective: /EFFECTIVE=(.*)/.exec(r.out)?.[1] ?? null,
    v2: /V2=(.*)/.exec(r.out)?.[1] ?? null,
  };
}

describe.runIf(canRun)("gateway-pre-start's OpenClaw generation probe", () => {
  it("reads the installed core's own manifest, without running it", () => {
    // ~10 s on a Jetson vs 53 ms for the manifest, in a BLOCKING ExecStartPre.
    const r = probe({ cli: 'echo "openclaw 2026.9.9"; echo RAN >&2', pkg: "2026.8.1" });
    expect(r.status).toBe(0);
    expect(r.effective).toBe("2026.8.1");
    expect(r.v2).toBe("1");
    expect(r.out, "the CLI was run even though the manifest answered").not.toContain("RAN");
  });

  it("asks the binary when there is no manifest to read", () => {
    const r = probe({ cli: 'echo "openclaw 2026.8.1"', pkg: null });
    expect(r.status).toBe(0);
    expect(r.effective).toBe("2026.8.1");
    expect(r.v2).toBe("1");
  });

  it("time-boxes that call, so a wedged CLI cannot hold the boot", () => {
    expect(block('OPENCLAW_TARGET=""', "export CLAWBOX_OPENCLAW_V2")).toMatch(
      /timeout \d+ "\$OPENCLAW_BIN" --version/,
    );
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
    expect(r.out).toMatch(/cannot tell which OpenClaw generation/);
    expect(r.out).toMatch(/leaving openclaw.json exactly as it is/);
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
    const r = hostname({ unreadable: true });
    expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
    expect(r.name).toBe("clawbox");
    // Not silent: this name rebuilds gateway.controlUi.allowedOrigins, so a
    // fallback drops the configured origin and the Control UI stops being
    // reachable by the name the owner uses.
    expect(r.out).toMatch(/WARN/);
  });
});
