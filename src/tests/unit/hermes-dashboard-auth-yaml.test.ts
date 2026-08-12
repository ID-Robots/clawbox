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
