import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * ~/.hermes/config.yaml has MORE THAN ONE writer. At install time the auth
 * script (setup-hermes-dashboard-auth.sh) and the MCP registrar
 * (register-mcp.sh, fire-and-forgotten by production-server.js on the
 * clawbox-setup restart) both read-modify-write it seconds apart. Whichever one
 * snapshotted the file first and wrote last silently erased the other's block —
 * a lost update. That is what erased the dashboard block between the auth
 * script's write and its verify, making it look like the credentials were wrong.
 *
 * The fix is a single flock, defined once in scripts/lib/hermes-config-lock.sh
 * and sourced by every writer, plus a refusal to report success when that lock
 * could not be taken. These pin the contract and the runtime behaviour.
 */
const REPO = process.cwd();
const LIB = path.join(REPO, "scripts", "lib", "hermes-config-lock.sh");
const AUTH = path.join(REPO, "scripts", "setup-hermes-dashboard-auth.sh");
const REGISTER = path.join(REPO, "scripts", "register-mcp.sh");
const LIB_SRC = fs.readFileSync(LIB, "utf-8");
const AUTH_SRC = fs.readFileSync(AUTH, "utf-8");
const REGISTER_SRC = fs.readFileSync(REGISTER, "utf-8");

const RUNNABLE =
  process.platform !== "win32" &&
  spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf-8" }).status === 0;
const FLOCK =
  RUNNABLE && spawnSync("bash", ["-c", "command -v flock"], { encoding: "utf-8" }).status === 0;

/** Locate a marker, failing loudly rather than silently slicing from -1. */
function indexOfOrThrow(haystack: string, needle: string | RegExp): number {
  const i = typeof needle === "string" ? haystack.indexOf(needle) : haystack.search(needle);
  if (i < 0) throw new Error(`marker not found: ${needle}`);
  return i;
}

/** A PATH whose `flock` always fails to acquire, plus the real tools. */
function shimWithFailingFlock(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "flock"), "#!/usr/bin/env bash\nexit 1\n", { mode: 0o755 });
  return `${dir}:${process.env.PATH ?? ""}`;
}

describe("the lock is defined once, not copied into each writer", () => {
  /**
   * The helper used to be duplicated verbatim in both writers. Mutual exclusion
   * then held only while the two copies stayed byte-identical: editing one would
   * silently un-serialise the pair while every test still passed. One
   * definition, sourced twice, makes that failure mode unreachable.
   */
  it("only the shared library defines the helper and the lock path", () => {
    expect(LIB_SRC).toContain("acquire_config_lock() {");
    expect(LIB_SRC).toContain('CONFIG_LOCK="${HERMES_CONFIG_CANONICAL}.lock"');
    for (const [name, src] of [
      ["setup-hermes-dashboard-auth.sh", AUTH_SRC],
      ["register-mcp.sh", REGISTER_SRC],
    ] as const) {
      expect(src, `${name} must not define its own helper`).not.toContain(
        "acquire_config_lock() {",
      );
      expect(src, `${name} must not derive its own lock path`).not.toMatch(
        /^CONFIG_LOCK=/m,
      );
    }
  });

  it("both writers source the shared library", () => {
    for (const [name, src] of [
      ["setup-hermes-dashboard-auth.sh", AUTH_SRC],
      ["register-mcp.sh", REGISTER_SRC],
    ] as const) {
      expect(src, `${name} must source the lock library`).toContain(
        'LOCK_LIB="$(dirname "${BASH_SOURCE[0]}")/lib/hermes-config-lock.sh"',
      );
      expect(src, `${name} must actually source it`).toContain('. "$LOCK_LIB"');
    }
  });

  it("a missing library is refused, never silently ignored", () => {
    // Running unserialised is the bug; a broken deploy must fail loudly rather
    // than quietly reintroduce it.
    for (const src of [AUTH_SRC, REGISTER_SRC]) {
      expect(src).toMatch(/if \[ ! -f "\$LOCK_LIB" \]; then/);
    }
  });

  it("both take the lock before they touch config.yaml", () => {
    // The auth script acquires before its mint; the registrar acquires before
    // its PyYAML reconcile AND holds it across the `hermes tools disable` CLI
    // call (which does its own wide load->save_config on the same file).
    expect(AUTH_SRC).toMatch(/acquire_config_lock[\s\S]*mint_credentials/);
    const acquireAt = indexOfOrThrow(REGISTER_SRC, /^acquire_config_lock register-mcp$/m);
    const cliAt = indexOfOrThrow(REGISTER_SRC, "tools disable browser");
    expect(acquireAt).toBeLessThan(cliAt);
    expect(LIB_SRC).toContain("flock -w 120 9");
  });

  it("keeps the exec that opens the lock fd free of a stderr redirect", () => {
    // Redirections on `exec` are permanent: `exec 9>file 2>/dev/null` would
    // silence the whole script and hide every error message.
    expect(LIB_SRC).not.toMatch(/exec 9>"\$CONFIG_LOCK"\s+2>/);
    expect(LIB_SRC).toContain('exec 9>"$CONFIG_LOCK"');
  });
});

describe.runIf(RUNNABLE)("the lock is really taken at runtime", () => {
  it("opens the lock file beside the config", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-lock-"));
    const configPath = path.join(root, "hermes", "config.yaml");
    const proc = spawnSync("bash", [AUTH], {
      encoding: "utf-8",
      env: { ...process.env, CLAWBOX_ROOT: root, HERMES_CONFIG: configPath },
    });
    if (FLOCK) {
      expect(proc.status, proc.stderr).toBe(0);
      expect(fs.existsSync(`${configPath}.lock`)).toBe(true);
    }
  });

  it.runIf(FLOCK)("derives ONE lock file from two spellings of the same config", () => {
    // A symlinked home is enough to give two writers two different lock paths
    // from the same file — at which point both believe they are locked and
    // neither excludes the other. The derivation canonicalises first.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-lockpath-"));
    const real = path.join(root, "real");
    fs.mkdirSync(path.join(real, "hermes"), { recursive: true });
    const link = path.join(root, "link");
    fs.symlinkSync(real, link, "dir");

    const lockOf = (configPath: string) => {
      const probe = `
        HERMES_CONFIG="${configPath}"
        . "${LIB}"
        printf '%s' "$CONFIG_LOCK"
      `;
      const p = spawnSync("bash", ["-c", probe], { encoding: "utf-8" });
      expect(p.status, p.stderr).toBe(0);
      return p.stdout.trim();
    };

    const viaReal = lockOf(path.join(real, "hermes", "config.yaml"));
    const viaLink = lockOf(path.join(link, "hermes", "config.yaml"));
    const viaDots = lockOf(path.join(real, "hermes", "..", "hermes", "config.yaml"));
    expect(viaLink).toBe(viaReal);
    expect(viaDots).toBe(viaReal);
  });

  it.runIf(FLOCK)("waits for a held lock instead of racing through it", () => {
    // Hold the shared lock for ~800ms in the background, then run the auth
    // script. If it honours the lock it blocks until release (elapsed ≳ hold);
    // if it ignored it, it would finish in well under 300ms. This is the mutual
    // exclusion that stops the lost update.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-lockwait-"));
    const configPath = path.join(root, "hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Pre-seed a foreign writer's content; it must survive the auth script's
    // write (the auth script preserves unrelated top-level keys).
    fs.writeFileSync(configPath, "mcp_servers:\n  clawbox:\n    enabled: true\n");
    const lockFile = `${configPath}.lock`;

    // One bash driver so the holder and the auth script actually overlap: launch
    // a background holder that takes the lock for ~0.8s, wait 0.15s so it wins
    // the lock first, then run the auth script. Timed from Node, so a missing
    // `date`/`awk` cannot silently report 0 and pass the assertion.
    const script = `
      set -e
      LOCK="${lockFile}"
      ( exec 9>"$LOCK"; flock 9; sleep 0.8 ) &
      hold=$!
      sleep 0.15                       # ensure the holder has the lock first
      CLAWBOX_ROOT="${root}" HERMES_CONFIG="${configPath}" bash "${AUTH}" >/dev/null 2>&1
      wait $hold
    `;
    const startedAt = Date.now();
    spawnSync("bash", ["-c", script], { encoding: "utf-8", timeout: 20000 });
    const elapsed = (Date.now() - startedAt) / 1000;
    // Held ~0.8s, started ~0.15s in, so the auth script should wait ≳0.5s.
    expect(elapsed).toBeGreaterThan(0.5);

    // And the foreign writer's key survived alongside the new dashboard block.
    const config = fs.readFileSync(configPath, "utf-8");
    expect(config).toMatch(/^dashboard:/m);
    expect(config).toMatch(/^mcp_servers:/m);
  });
});

/**
 * PHASE TWO of the lost-update race, which is the dangerous half.
 *
 * Phase one is a competing writer landing between the write and the verify: the
 * verify fails, loudly, and is retried. Phase two is a writer landing AFTER the
 * verify — the script printed "done" and exited 0 over a device whose config had
 * no dashboard block at all, i.e. a clean success reported over a box with no
 * auth provider. Holding the lock to exit closes it for cooperating writers.
 * When the lock cannot be taken, nothing closes it, so success must not be
 * reported at all.
 */
describe.runIf(RUNNABLE)("a run that could not serialise never reports success", () => {
  it("exits non-zero, and says the credentials are not the problem", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-unserialised-"));
    const configPath = path.join(root, "hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });

    const proc = spawnSync("bash", [AUTH], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: shimWithFailingFlock(path.join(root, "shim")),
        CLAWBOX_ROOT: root,
        HERMES_CONFIG: configPath,
      },
    });

    // 8 = verified, but not under mutual exclusion. Distinct from 3 (a genuine
    // mismatch) and 4 (an environment failure) on purpose.
    expect(proc.status).toBe(8);
    expect(proc.stderr).toMatch(/never held/i);
    expect(proc.stderr).toMatch(/NOT a credential problem/i);
    // The work was still DONE — only the certification is withheld, so the
    // dashboard still has an auth provider to start with.
    expect(fs.readFileSync(configPath, "utf-8")).toMatch(/^dashboard:/m);
  });

  it("does not report success when the block is erased right after the verify", () => {
    // The exact phase-two shape, made deterministic. On the fresh-box path the
    // script calls python3 exactly three times: generate, write, VERIFY. A shim
    // that fires one competing write the instant call #3 returns lands precisely
    // in the verify -> exit window a real racing writer hits by chance.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-phase2-"));
    const configPath = path.join(root, "hermes", "config.yaml");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "mcp_servers:\n  clawbox:\n    enabled: true\n");

    const realPy = spawnSync("bash", ["-c", "command -v python3"], {
      encoding: "utf-8",
    }).stdout.trim();
    const shim = path.join(root, "shim");
    const pathWithShim = shimWithFailingFlock(shim);

    // The competing writer: a stale read-modify-write that drops the block.
    const clobber = path.join(root, "clobber.py");
    fs.writeFileSync(
      clobber,
      [
        "import os, re, sys",
        "p = sys.argv[1]",
        "cfg = open(p).read()",
        'cfg = re.sub(r"(?m)^dashboard:[ \\t]*\\n(?:[ \\t].*\\n|[ \\t]*\\n)*", "", cfg)',
        'tmp = p + ".other"',
        'open(tmp, "w").write(cfg)',
        "os.replace(tmp, p)",
      ].join("\n"),
    );

    const counter = path.join(root, "n");
    fs.writeFileSync(
      path.join(shim, "python3"),
      [
        "#!/usr/bin/env bash",
        `n=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${counter}"`,
        `"${realPy}" "$@"`,
        "rc=$?",
        `if [ "$n" -eq 3 ]; then "${realPy}" "${clobber}" "${configPath}"; fi`,
        "exit $rc",
      ].join("\n"),
      { mode: 0o755 },
    );

    const proc = spawnSync("bash", [AUTH], {
      encoding: "utf-8",
      env: {
        ...process.env,
        PATH: pathWithShim,
        CLAWBOX_ROOT: root,
        HERMES_CONFIG: configPath,
      },
    });

    // The box really is broken: the block it verified is gone from disk.
    expect(fs.readFileSync(configPath, "utf-8")).not.toMatch(/^dashboard:/m);
    // So the one thing the script must not do is report success.
    expect(proc.status, `reported success over a config with no dashboard block`).not.toBe(0);
  });
});
