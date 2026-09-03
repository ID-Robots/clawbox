import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `scripts/gateway-pre-start.sh` runs under `set -euo pipefail` as the
 * gateway unit's `ExecStartPre`. Its generation probe is
 *
 *     CLAWBOX_OPENCLAW_EFFECTIVE="$("$OPENCLAW_BIN" --version 2>/dev/null \
 *       | grep -oE '20[0-9]{2}\.[0-9]+\.[0-9]+' | head -1)"
 *
 * and the comment beneath it assumes an empty result when the CLI cannot
 * answer ("The pin only fills in when the binary cannot be asked"). It does not
 * get one. `grep -oE` exits 1 when it matches nothing, `pipefail` carries that
 * to the pipeline, and an assignment whose command substitution failed aborts
 * the script under `set -e`. A box whose `openclaw` binary exists but cannot
 * print its version — a crash, a node engine mismatch, a hang the CLI answers
 * with a non-zero status, a banner the regex does not match — therefore gets
 * NO gateway and no chat at all, with the only trace in the unit's
 * ExecStartPre failure (TASK-657). A missing binary is already handled: the
 * script exits 0 a few lines above.
 *
 * These tests EXECUTE the shipped blocks under `set -euo pipefail` against
 * stubs. The rule they pin is the one the boot path needs: every probe here
 * warns and carries on with its stated fallback, and none of them can take the
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
function probe(opts: { cli: string; pin?: string | null; pinUnreadable?: boolean }): Probe {
  const bin = path.join(root, "openclaw");
  writeFileSync(bin, `#!/usr/bin/env bash\n${opts.cli}\n`);
  chmodSync(bin, 0o755);
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
  it("reads the version the installed binary prints", () => {
    const r = probe({ cli: 'echo "openclaw 2026.8.1"' });
    expect(r.status).toBe(0);
    expect(r.effective).toBe("2026.8.1");
    expect(r.v2).toBe("1");
  });

  it("still calls a v1 binary v1, whatever the pin says", () => {
    // The comment's whole point: the INSTALLED binary is the authority, because
    // it is the process that parses what this script writes.
    const r = probe({ cli: 'echo "openclaw 2026.7.4"', pin: "2026.8.1\n" });
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
    it(`falls back to the pin when the CLI ${name}, instead of taking the gateway down`, () => {
      // Today: the pipeline fails, `set -e` aborts the whole pre-start, and the
      // unit never starts the gateway.
      const r = probe({ cli, pin: "2026.8.1\n" });
      expect(r.status, `the pre-start aborted:\n${r.out}`).toBe(0);
      expect(r.effective).toBe("2026.8.1");
      expect(r.v2).toBe("1");
      // Silence is what made this invisible for a release: the box booted with
      // no gateway and nothing said why.
      expect(r.out).toMatch(/WARN/);
    });
  }

  it("carries on with no version at all when there is no pin either", () => {
    // Nothing can be inferred here, and the legacy names are the safe default —
    // but the gateway must still start.
    const r = probe({ cli: "exit 1", pin: null });
    expect(r.status).toBe(0);
    expect(r.effective).toBe("");
    expect(r.v2).toBe("0");
  });

  it("carries on when the pin file exists but cannot be read", () => {
    // Same class, same script, one screen up: `head` on an unreadable file
    // exits non-zero and pipefail carries it into the assignment.
    const r = probe({ cli: 'echo "openclaw 2026.8.1"', pin: "2026.8.1\n", pinUnreadable: true });
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
        block('CONFIGURED_HOSTNAME="clawbox"', "\nfi"),
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
  });
});
