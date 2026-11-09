import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * TASK-2359 — which local port scripts/run-tunnel.sh forwards to, on both
 * install layouts, actually executed with a fake cloudflared that records its
 * argv.
 *
 * clawbox-tunnel.service hands the script LOCAL_SERVICE_URL: the appliance's
 * config/clawbox-tunnel.service names http://localhost:80, and install-x64.sh
 * writes its own unit with http://localhost:$PORT — the same $PORT it gives the
 * UI unit. A unit without the variable used to get a blind :80, which on a PC
 * install is a port nothing listens on: the public URL answered 502. Now the
 * script takes the web UI's port from PORT, CLAWBOX_PORT, or the PORT in the UI
 * unit (clawbox-setup.service) before it falls back to 80.
 *
 * A systemd start at boot is a fresh run of the script with the unit's
 * environment, which is what every case here is.
 */

// Starts a real process: see src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO = process.cwd();
const RUN_TUNNEL = path.join(REPO, "scripts/run-tunnel.sh");
const QUICK_URL = "https://port-target-check.trycloudflare.com";
const HOST = "port-target-box.clawbox.tech";
const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0";

let root: string;
let callLog: string;
let fakeCloudflared: string;
let fakeSystemctl: string;
const spawned: ChildProcess[] = [];

const cf = (name: string) => path.join(root, "data", "cloudflared", name);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "clawbox-run-tunnel-target-"));
  mkdirSync(path.join(root, "data", "cloudflared"), { recursive: true });
  callLog = path.join(root, "calls.log");
  fakeCloudflared = path.join(root, "cloudflared");
  fakeSystemctl = path.join(root, "systemctl");
  writeFileSync(
    fakeCloudflared,
    `#!/usr/bin/env bash
printf 'argv:%s\\n' "$*" >> "${callLog}"
for arg in "$@"; do
  if [ "$arg" = run ]; then
    echo "INF Registered tunnel connection connIndex=0" >&2
    while true; do sleep 0.2; done
  fi
done
echo "INF |  ${QUICK_URL}  |" >&2
while true; do sleep 0.2; done
`,
    { mode: 0o755 },
  );
  // `systemctl show -p Environment --value <unit>`: the web UI unit's
  // Environment= line, from ui-unit.env; no file = a unit systemd does not know.
  writeFileSync(
    fakeSystemctl,
    `#!/usr/bin/env bash
printf 'systemctl:%s\\n' "$*" >> "${callLog}"
[ -f "${root}/ui-unit.env" ] || exit 1
cat "${root}/ui-unit.env"
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  try {
    for (const child of spawned.splice(0)) {
      if (child.pid == null) continue;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface Run {
  child: ChildProcess;
  exited: Promise<number | null>;
}

/** run-tunnel.sh with exactly the given unit environment — nothing inherited that could name a port. */
function start(unitEnv: Record<string, string>): Run {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: root,
    CLAWBOX_ROOT: root,
    CLOUDFLARED_BIN: fakeCloudflared,
    SYSTEMCTL_BIN: fakeSystemctl,
    ...unitEnv,
  };
  const child = spawn("bash", [RUN_TUNNEL], { env, detached: true, stdio: "ignore" });
  spawned.push(child);
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ? null : code));
  });
  return { child, exited };
}

async function waitFor(pred: () => boolean) {
  for (let i = 0; i < 600 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(pred()).toBe(true);
}

const calls = () => (existsSync(callLog) ? readFileSync(callLog, "utf-8") : "");
const argvLines = () => calls().split("\n").filter((line) => line.startsWith("argv:"));
const published = () => existsSync(cf("tunnel.url"));

/** Start, wait for the tunnel to publish, and answer the --url it was given. */
async function forwardedTo(unitEnv: Record<string, string>): Promise<string> {
  const run = start(unitEnv);
  await waitFor(published);
  const argv = argvLines().at(-1) ?? "";
  const target = / --url (\S+)$/.exec(argv)?.[1] ?? "";
  // Status reads the same target back from tunnel.target.
  expect(readFileSync(cf("tunnel.target"), "utf-8").trim()).toBe(target);
  process.kill(-run.child.pid!, "SIGTERM");
  expect(await run.exited).toBe(0);
  return target;
}

/** `Environment=KEY=VALUE` lines of a unit, as systemd would hand them to the script. */
function unitEnvironment(unitText: string, vars: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of unitText.split("\n")) {
    const m = /^Environment=([A-Z_]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    env[m[1]] = m[2].replace(/\$([A-Z_]+)/g, (_, name: string) => vars[name] ?? `$${name}`);
  }
  return env;
}

/** The body of the `cat > "$<name>" <<EOF … EOF` unit install-x64.sh writes. */
function installX64Unit(variable: string): string {
  const source = readFileSync(path.join(REPO, "install-x64.sh"), "utf-8");
  const m = new RegExp(`cat > "\\$${variable}" <<EOF\\n([\\s\\S]*?)\\nEOF\\n`).exec(source);
  if (!m) throw new Error(`install-x64.sh writes no ${variable}`);
  return m[1];
}

describe("run-tunnel.sh — the port the unit forwards to (TASK-2359)", () => {
  it("appliance: config/clawbox-tunnel.service forwards to :80, the PORT clawbox-setup.service serves on", async () => {
    const tunnelUnit = unitEnvironment(readFileSync(path.join(REPO, "config/clawbox-tunnel.service"), "utf-8"));
    const uiUnit = unitEnvironment(readFileSync(path.join(REPO, "config/clawbox-setup.service"), "utf-8"));
    expect(uiUnit.PORT).toBe("80");

    expect(await forwardedTo({ LOCAL_SERVICE_URL: tunnelUnit.LOCAL_SERVICE_URL })).toBe(
      `http://localhost:${uiUnit.PORT}`,
    );
  });

  it.each(["3005", "8080"])(
    "PC install (CLAWBOX_PORT=%s): install-x64.sh's tunnel unit forwards to the port its UI unit serves on",
    async (port) => {
      const vars = { PORT: port, PROJECT_DIR: root, CLAWBOX_HOME: root, CLAWBOX_USER: "owner" };
      const tunnelUnit = unitEnvironment(installX64Unit("tunnel_unit"), vars);
      const uiUnit = unitEnvironment(installX64Unit("ui_unit"), vars);
      expect(uiUnit.PORT).toBe(port);

      expect(await forwardedTo({ LOCAL_SERVICE_URL: tunnelUnit.LOCAL_SERVICE_URL })).toBe(
        `http://localhost:${port}`,
      );
    },
  );

  describe("a unit that names no LOCAL_SERVICE_URL", () => {
    it("takes PORT", async () => {
      expect(await forwardedTo({ PORT: "3005" })).toBe("http://localhost:3005");
    });

    it("takes the installer's CLAWBOX_PORT", async () => {
      expect(await forwardedTo({ CLAWBOX_PORT: "3005" })).toBe("http://localhost:3005");
    });

    it("asks the web UI's own unit for the PORT it serves on", async () => {
      writeFileSync(path.join(root, "ui-unit.env"), "HOME=/home/owner NODE_ENV=production PORT=3005 HOSTNAME=0.0.0.0\n");
      expect(await forwardedTo({})).toBe("http://localhost:3005");
      expect(calls()).toContain("systemctl:show -p Environment --value clawbox-setup.service");
    });

    it("reads the unit's PORT the way systemd applies it: the last assignment wins", async () => {
      writeFileSync(path.join(root, "ui-unit.env"), "PORT=80 NODE_ENV=production PORT=3005\n");
      expect(await forwardedTo({})).toBe("http://localhost:3005");
    });

    it("gets 80 from the appliance's UI unit", async () => {
      writeFileSync(path.join(root, "ui-unit.env"), "PORT=80 HTTPS_PORT=443\n");
      expect(await forwardedTo({})).toBe("http://localhost:80");
    });

    it("skips a value that is not a port", async () => {
      writeFileSync(path.join(root, "ui-unit.env"), "PORT=3005\n");
      expect(await forwardedTo({ PORT: "70000", CLAWBOX_PORT: "http" })).toBe("http://localhost:3005");
      expect(await forwardedTo({ PORT: "03005" })).toBe("http://localhost:3005");
    });

    it("falls back to the appliance's 80 only when nothing names a port", async () => {
      expect(await forwardedTo({})).toBe("http://localhost:80");
    });
  });

  it("keeps the unit's explicit LOCAL_SERVICE_URL over every fallback", async () => {
    writeFileSync(path.join(root, "ui-unit.env"), "PORT=9999\n");
    expect(await forwardedTo({ LOCAL_SERVICE_URL: "http://localhost:3005", PORT: "4000" })).toBe(
      "http://localhost:3005",
    );
    expect(calls()).not.toContain("systemctl:");
  });

  it("restart (as at boot): a stop erases tunnel.target, the next start forwards to the same port", async () => {
    const unit = { LOCAL_SERVICE_URL: "http://localhost:3005" };
    const first = start(unit);
    await waitFor(published);
    process.kill(-first.child.pid!, "SIGTERM");
    expect(await first.exited).toBe(0);
    expect(existsSync(cf("tunnel.target"))).toBe(false);
    expect(existsSync(cf("tunnel.url"))).toBe(false);

    const second = start(unit);
    await waitFor(published);
    expect(readFileSync(cf("tunnel.target"), "utf-8").trim()).toBe("http://localhost:3005");
    expect(argvLines()).toHaveLength(2);
    expect(argvLines().every((argv) => argv.endsWith(" --url http://localhost:3005"))).toBe(true);
    process.kill(-second.child.pid!, "SIGTERM");
    expect(await second.exited).toBe(0);
  });

  it("the named tunnel forwards to the same port as the quick one", async () => {
    writeFileSync(cf("named-tunnel"), `hostname=${HOST}\ntoken=${TOKEN}\n`, { mode: 0o600 });
    const run = start({ PORT: "3005" });
    await waitFor(published);
    expect(readFileSync(cf("tunnel.url"), "utf-8").trim()).toBe(`https://${HOST}`);
    expect(argvLines()).toHaveLength(1);
    expect(argvLines()[0]).toMatch(/ run --url http:\/\/localhost:3005$/);
    expect(readFileSync(cf("tunnel.target"), "utf-8").trim()).toBe("http://localhost:3005");
    process.kill(-run.child.pid!, "SIGTERM");
    expect(await run.exited).toBe(0);
  });
});
