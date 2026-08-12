import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * scripts/setup-hermes-dashboard-auth.sh emits Hermes's `dashboard.basic_auth`
 * block by hand. The dashboard binds a non-loopback address and therefore
 * REFUSES to start without an auth provider, so a block that does not parse is
 * not a cosmetic problem — it is a device whose dashboard never comes up, with
 * nothing left on the box able to repair it.
 *
 * The username is the only field an operator supplies (HERMES_DASH_USERNAME).
 * These run the real script and read back what it wrote.
 */

const SCRIPT = path.join(process.cwd(), "scripts", "setup-hermes-dashboard-auth.sh");

// The script needs bash and a python3 with hashlib.scrypt. Both are present on
// the device and on CI; skip rather than fail anywhere else.
const RUNNABLE =
  process.platform !== "win32" &&
  spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf-8" }).status === 0;

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-dashauth-"));
  return { root, configPath: path.join(root, "hermes", "config.yaml") };
}

function run(root: string, configPath: string, username?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAWBOX_ROOT: root, HERMES_CONFIG: configPath };
  if (username !== undefined) env.HERMES_DASH_USERNAME = username;
  return spawnSync("bash", [SCRIPT], { encoding: "utf-8", env });
}

/** Run the read-only classifier (`--check`) against a given root + config. */
function check(root: string, configPath: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAWBOX_ROOT: root,
    HERMES_CONFIG: configPath,
    ...extraEnv,
  };
  return spawnSync("bash", [SCRIPT, "--check"], { encoding: "utf-8", env });
}

const REAL_PYTHON =
  spawnSync("bash", ["-c", "command -v python3"], { encoding: "utf-8" }).stdout.trim() ||
  "/usr/bin/python3";

/**
 * A dir holding a `python3` whose `hashlib.scrypt` always raises — the "the
 * check could not run in THIS interpreter" case the diagnosis worried about
 * (a uv-managed python without OpenSSL scrypt). Absolute shebang so the stub
 * never re-resolves to itself on PATH. Returns the dir to prepend to PATH.
 */
function scryptBrokenPythonDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-nopy-"));
  fs.writeFileSync(
    path.join(dir, "python3"),
    [
      `#!${REAL_PYTHON}`,
      "import hashlib, sys",
      'def boom(*a, **k): raise ValueError("scrypt unavailable in this interpreter")',
      "hashlib.scrypt = boom",
      "src = sys.stdin.read()",
      'exec(compile(src, "<stub>", "exec"), {"__name__": "__main__"})',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return dir;
}

/** A valid scrypt password_hash for a chosen plaintext, via the real python. */
function scryptHash(plaintext: string): string {
  const proc = spawnSync(
    "python3",
    [
      "-c",
      [
        "import base64,hashlib,sys",
        "pw=sys.argv[1].encode(); salt=bytes(range(16))",
        "dk=hashlib.scrypt(pw,salt=salt,n=2**14,r=8,p=1,dklen=32,maxmem=0)",
        "print('scrypt$%d$%d$%d$%s$%s'%(2**14,8,1,base64.b64encode(salt).decode(),base64.b64encode(dk).decode()))",
      ].join("\n"),
      plaintext,
    ],
    { encoding: "utf-8" },
  );
  // Assert the FIXTURE built, rather than letting a silent python failure
  // return "" — that would seed `password_hash: ""`, the classifier would
  // answer NOT_CONFIGURED, and the mismatch test below would fail pointing at
  // the classifier instead of at its own broken input.
  if (proc.status !== 0) {
    throw new Error(`scryptHash fixture failed (status ${proc.status}): ${proc.stderr}`);
  }
  const hash = proc.stdout.trim();
  if (!hash.startsWith("scrypt$")) {
    throw new Error(`scryptHash produced an unusable fixture: ${JSON.stringify(hash)}`);
  }
  return hash;
}

/** Write a self-consistent-looking dashboard block for a given hash. */
function seedBlock(configPath: string, passwordHash: string) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    [
      "dashboard:",
      "  basic_auth:",
      '    username: "clawbox"',
      `    password_hash: "${passwordHash}"`,
      '    secret: "deadbeef"',
      "    session_ttl_seconds: 604800",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

/** Provision a throwaway root once and return what the script wrote. */
function provision(username: string) {
  const { root, configPath } = makeRoot();
  const proc = run(root, configPath, username);
  return {
    status: proc.status,
    stderr: proc.stderr,
    config: fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "",
    password: fs.readFileSync(path.join(root, "data", ".hermes-dashboard-pw"), "utf-8"),
  };
}

/** The value half of `    username: <value>`, as the script wrote it. */
function usernameScalar(config: string): string {
  const line = config.split("\n").find((l) => l.trim().startsWith("username:"));
  if (!line) throw new Error("no username line in the emitted block");
  return line.slice(line.indexOf(":") + 1).trim();
}

const usernameLines = (config: string) =>
  config.split("\n").filter((l) => l.trim().startsWith("username:"));

describe.runIf(RUNNABLE)("hermes dashboard auth block", () => {
  it("writes a usable block for the default username", () => {
    const { status, stderr, config, password } = provision("clawbox");
    expect(status, stderr).toBe(0);
    expect(JSON.parse(usernameScalar(config))).toBe("clawbox");
    expect(config).toContain("password_hash:");
    expect(password.length).toBeGreaterThan(0);
  });

  it("stays parseable for a username carrying YAML punctuation", () => {
    // ':' after a bare scalar opens a nested mapping and '#' opens a comment,
    // so either one silently changes what the line means — or ends the document.
    for (const name of ["ops: admin", "clawbox #1", "-dash-lead", "user@example.com", "yes"]) {
      const { status, config } = provision(name);
      expect(status).toBe(0);
      const scalar = usernameScalar(config);
      // A double-quoted scalar reads back verbatim, whatever it holds.
      expect(scalar.startsWith('"')).toBe(true);
      expect(JSON.parse(scalar)).toBe(name);
      // And nothing leaked past it into a second key.
      expect(usernameLines(config)).toHaveLength(1);
    }
  });

  it("does not re-mint when the stored hash already verifies the stored password", () => {
    // The in-app updater now dispatches `hermes_edition` on every update, which
    // runs this script every time. Re-minting a working box's credentials would
    // rotate the password the auth proxy holds — a dashboard the customer can
    // no longer be signed into, once per update.
    const { root, configPath } = makeRoot();
    const pwPath = path.join(root, "data", ".hermes-dashboard-pw");
    expect(run(root, configPath, "clawbox").status).toBe(0);
    const passwordBefore = fs.readFileSync(pwPath, "utf-8");
    const hashBefore = /password_hash:\s*"([^"]+)"/.exec(
      fs.readFileSync(configPath, "utf-8"),
    )?.[1];

    const second = run(root, configPath, "clawbox");

    expect(second.status).toBe(0);
    expect(second.stdout).toContain("already configured");
    expect(fs.readFileSync(pwPath, "utf-8")).toBe(passwordBefore);
    expect(
      /password_hash:\s*"([^"]+)"/.exec(fs.readFileSync(configPath, "utf-8"))?.[1],
    ).toBe(hashBefore);
  });

  it("re-mints in place after the password file is lost, without a second block", () => {
    // The factory-reset shape: data/ is wiped, ~/.hermes/config.yaml survives.
    // A second top-level `dashboard:` key would be invalid YAML.
    const { root, configPath } = makeRoot();
    expect(run(root, configPath, "first").status).toBe(0);
    fs.rmSync(path.join(root, "data", ".hermes-dashboard-pw"));
    expect(run(root, configPath, "second: user").status).toBe(0);

    const config = fs.readFileSync(configPath, "utf-8");
    expect(config.split("\n").filter((l) => l.startsWith("dashboard:"))).toHaveLength(1);
    expect(usernameLines(config)).toHaveLength(1);
    expect(JSON.parse(usernameScalar(config))).toBe("second: user");
  });

  it("leaves the stored password and the stored hash describing the same password", () => {
    // The script verifies this itself before reporting success; assert the
    // proof rather than trusting the exit code alone.
    const { root, configPath } = makeRoot();
    run(root, configPath, "clawbox");
    const config = fs.readFileSync(configPath, "utf-8");
    const pw = fs.readFileSync(path.join(root, "data", ".hermes-dashboard-pw"), "utf-8").trim();

    const stored = /password_hash:\s*"([^"]+)"/.exec(config)?.[1] ?? "";
    const [scheme, n, r, p, saltB64, dkB64] = stored.split("$");
    expect(scheme).toBe("scrypt");

    const check = spawnSync(
      "python3",
      [
        "-c",
        [
          "import base64,hashlib,sys",
          "pw,n,r,p,salt,dk = sys.argv[1:]",
          "got = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p), dklen=len(base64.b64decode(dk)), maxmem=0)",
          "print('match' if got == base64.b64decode(dk) else 'mismatch')",
        ].join("\n"),
        pw, n, r, p, saltB64, dkB64,
      ],
      { encoding: "utf-8" },
    );
    expect(check.stdout.trim()).toBe("match");
  });
});

/**
 * Honest failure classes. Two Hermes provisions in a row printed
 * "freshly written password and hash do not verify" and blamed the credentials
 * — which were provably correct — because the check returned a bare exit 1 for
 * every kind of failure: a genuine mismatch, a block a racing writer had erased,
 * a config it couldn't read, and an interpreter where scrypt couldn't run. The
 * fix is a classifier: "could not run the check" and "the password does not
 * match the hash" must be DIFFERENT outcomes with different exit codes, and an
 * environment failure must never be reported as a credential problem. `--check`
 * exposes the classifier as its own exit code (0 ok, 3 mismatch, 4 not
 * configured, 5 no password, 6/7 environment).
 */
describe.runIf(RUNNABLE)("dashboard auth: honest failure classes", () => {
  it("reports a good pair as usable (exit 0)", () => {
    const { root, configPath } = makeRoot();
    expect(run(root, configPath, "clawbox").status).toBe(0);
    const proc = check(root, configPath);
    expect(proc.status, proc.stderr).toBe(0);
    expect(proc.stdout).toContain("OK");
  });

  it("catches a GENUINE mismatch (exit 3), distinctly from an environment error", () => {
    // A valid, well-formed block for password "AAA", but the stored plaintext
    // is "BBB": the hash genuinely does not verify the password.
    const { root, configPath } = makeRoot();
    seedBlock(configPath, scryptHash("AAA"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", ".hermes-dashboard-pw"), "BBB", { mode: 0o600 });

    const proc = check(root, configPath);
    expect(proc.status).toBe(3);
    expect(proc.stderr).toContain("DESYNCED");
    // And it must NOT masquerade as one of the environment codes.
    expect([6, 7]).not.toContain(proc.status);
  });

  it("does NOT report a vanished block as a credential mismatch", () => {
    // The lost-update artefact: another writer's config (mcp_servers only, no
    // dashboard block) with a password file still present. The block is simply
    // gone — there is no credential to compare — so this is NOT_CONFIGURED (4),
    // never MISMATCH (3). This is the exact state the racing writer leaves, and
    // blaming the credentials for it is what hid the real bug for two provisions.
    const { root, configPath } = makeRoot();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, "mcp_servers:\n  clawbox:\n    enabled: true\n");
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", ".hermes-dashboard-pw"), "leftover-password", {
      mode: 0o600,
    });

    const proc = check(root, configPath);
    expect(proc.status).toBe(4);
    expect(proc.stdout + proc.stderr).toContain("NOT CONFIGURED");
    expect(proc.status).not.toBe(3);
  });

  it("classifies a scrypt-less interpreter as an environment error, NOT a mismatch", () => {
    // First provision a genuinely-correct pair with the real python.
    const { root, configPath } = makeRoot();
    expect(run(root, configPath, "clawbox").status).toBe(0);

    // Now verify it with an interpreter whose scrypt raises. The pair is CORRECT
    // — the check just cannot run. That must be exit 7 (COULD NOT RUN), never 3.
    const stubDir = scryptBrokenPythonDir();
    const proc = check(root, configPath, { PATH: `${stubDir}${path.delimiter}${process.env.PATH}` });
    expect(proc.status).toBe(7);
    expect(proc.stderr).toContain("COULD NOT RUN");
    expect(proc.stderr).not.toContain("does not match");
  });

  it("a provision that cannot compute a hash fails as ENVIRONMENT, not as a bad credential", () => {
    // Full provision under a scrypt-less interpreter: the OLD script would still
    // reach its verify and print "do not verify", blaming credentials it never
    // managed to write. The classifier stops at generation with an environment
    // exit code and an environment message.
    const { root, configPath } = makeRoot();
    const stubDir = scryptBrokenPythonDir();
    const proc = run2(root, configPath, {
      PATH: `${stubDir}${path.delimiter}${process.env.PATH}`,
    });
    // 4 = environment error (could not generate). Definitely not the success 0,
    // and not the credential-mismatch 2.
    expect(proc.status).toBe(4);
    const all = `${proc.stdout}\n${proc.stderr}`;
    expect(all).not.toMatch(/do not verify|does not match/);
    expect(all).toMatch(/could not generate|environment/i);
  });
});

/**
 * A LOCAL write failure is its own outcome. `mint_credentials` is always called
 * as `mint_credentials || mint_rc=$?`, which disables `set -e` for its whole
 * body — so an unchecked write failure returned 0, the verify then classified
 * PW_MISSING, and the script reported "a concurrent process rewrote the file"
 * and "another process ... is not honouring $CONFIG_LOCK". That blames a
 * cooperating writer for a full disk or a bad permission, which is exactly the
 * dishonest verdict this script exists to remove.
 */
describe.runIf(RUNNABLE)("a local write failure is not blamed on another writer", () => {
  it("reports an unwritable password file as a write failure", () => {
    const { root, configPath } = makeRoot();
    // data/ exists but is read-only, so creating data/.hermes-dashboard-pw
    // fails while everything else about the environment is fine.
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.chmodSync(dataDir, 0o500);

    let proc;
    try {
      proc = run(root, configPath);
    } finally {
      fs.chmodSync(dataDir, 0o700);
    }

    expect(proc.status).not.toBe(0);
    const all = `${proc.stdout}\n${proc.stderr}`;
    expect(all).toMatch(/could not write the dashboard password file/i);
    expect(all).toMatch(/NOT a concurrent writer/i);
    // The two verdicts it must NOT reach.
    expect(all).not.toMatch(/concurrent process rewrote/i);
    expect(all).not.toMatch(/not honouring/i);
  });
});

/** Full provision with extra env (used to inject a broken PATH). */
function run2(root: string, configPath: string, extraEnv: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CLAWBOX_ROOT: root,
    HERMES_CONFIG: configPath,
    ...extraEnv,
  };
  return spawnSync("bash", [SCRIPT], { encoding: "utf-8", env });
}
