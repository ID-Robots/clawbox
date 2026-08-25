import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The credential ClawBox's own systemd units present when they call back into
 * the web app, so a pre-auth route can tell "the heartbeat timer" apart from
 * "anyone on the LAN" (TASK-446).
 */

let root: string;
let tokenFile: string;

async function loadModule() {
  const mod = await import("@/lib/internal-token");
  mod._resetInternalTokenCacheForTests();
  return mod;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-internal-"));
  fs.mkdirSync(path.join(root, "data"));
  tokenFile = path.join(root, "data", "internal-token.env");
  process.env.CLAWBOX_ROOT = root;
  delete process.env.CLAWBOX_INTERNAL_TOKEN;
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  delete process.env.CLAWBOX_INTERNAL_TOKEN;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the internal token", () => {
  it("mints one at 0600, in the KEY=value form systemd's EnvironmentFile reads", async () => {
    // The heartbeat unit runs with ProtectHome=yes and cannot open this file
    // itself; PID 1 parses it as root before the sandbox applies. That only
    // works if it is env-file shaped.
    const { getInternalToken } = await loadModule();
    const token = getInternalToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(tokenFile, "utf-8")).toBe(`CLAWBOX_INTERNAL_TOKEN=${token}\n`);
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600);
  });

  it("reuses the token on disk rather than rotating it every boot", async () => {
    const existing = "b".repeat(64);
    fs.writeFileSync(tokenFile, `CLAWBOX_INTERNAL_TOKEN=${existing}\n`, { mode: 0o600 });
    const { getInternalToken } = await loadModule();
    expect(getInternalToken()).toBe(existing);
  });

  it("prefers the seeded environment variable, as production-server.js sets it", async () => {
    process.env.CLAWBOX_INTERNAL_TOKEN = "c".repeat(64);
    const { getInternalToken } = await loadModule();
    expect(getInternalToken()).toBe("c".repeat(64));
    expect(fs.existsSync(tokenFile)).toBe(false);
  });

  it("accepts the real token and nothing else", async () => {
    const { getInternalToken, verifyInternalToken } = await loadModule();
    const token = getInternalToken();

    expect(verifyInternalToken(token)).toBe(true);
    expect(verifyInternalToken(` ${token} `)).toBe(true);
    // One character off — and it has to BE off. The token is 64 random hex
    // characters, so pinning the replacement to "0" produced the token itself
    // once every sixteen mints; verify then correctly answered true and this
    // line failed as "expected true to be false" on ~6% of CI runs.
    const wrongTail = token.endsWith("0") ? "1" : "0";
    expect(verifyInternalToken(token.slice(0, -1) + wrongTail)).toBe(false);
    expect(verifyInternalToken(token + "x")).toBe(false);
    expect(verifyInternalToken("")).toBe(false);
    expect(verifyInternalToken(null)).toBe(false);
    expect(verifyInternalToken(undefined)).toBe(false);
    // An empty ${CLAWBOX_INTERNAL_TOKEN} from a unit whose EnvironmentFile did
    // not exist yet arrives as the header with nothing after it.
    expect(verifyInternalToken("short")).toBe(false);
  });

  it("reads the header off a Request", async () => {
    const { getInternalToken, isInternalRequest, INTERNAL_TOKEN_HEADER } = await loadModule();
    const token = getInternalToken();

    expect(
      isInternalRequest(new Request("http://127.0.0.1/x", { headers: { [INTERNAL_TOKEN_HEADER]: token } })),
    ).toBe(true);
    expect(isInternalRequest(new Request("http://127.0.0.1/x"))).toBe(false);
  });
});

describe("the heartbeat unit and the route agree", () => {
  const unit = fs.readFileSync(
    new URL("../../../config/clawbox-heartbeat.service", import.meta.url),
    "utf-8",
  );

  it("sends the header the route checks, with the variable the token file defines", async () => {
    const { INTERNAL_TOKEN_HEADER, INTERNAL_TOKEN_ENV_VAR } = await loadModule();
    const execStart = unit.split("\n").find((l) => l.startsWith("ExecStart="));
    expect(execStart).toBeDefined();
    // Header names are case-insensitive over the wire; the constant is
    // lower-case because that is how Request normalises them.
    expect(execStart!.toLowerCase()).toContain(`${INTERNAL_TOKEN_HEADER}: \${${INTERNAL_TOKEN_ENV_VAR.toLowerCase()}}`);
    expect(execStart).toContain("/setup-api/portal/heartbeat-tick");
  });

  it("loads the token file the app writes, optionally", async () => {
    // `-` matters: on a box whose web server has not seeded the file yet, a
    // missing EnvironmentFile must not fail the unit.
    expect(unit).toContain("EnvironmentFile=-/home/clawbox/clawbox/data/internal-token.env");
  });

  it("still tolerates the 401 a box in that state answers with", () => {
    // curl exit 22 is "HTTP error"; without this the timer would flap.
    expect(unit).toMatch(/^SuccessExitStatus=.*\b22\b/m);
  });
});
