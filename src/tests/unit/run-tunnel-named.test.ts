import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * scripts/run-tunnel.sh with the NAMED tunnel, actually executed against a fake
 * cloudflared. No real Cloudflare tunnel is involved: the fake prints what
 * cloudflared prints on the paths the script cares about, and records the argv
 * and environment it was started with.
 *
 *   - a credential on file → `tunnel --no-autoupdate run --url …`, the token in
 *     TUNNEL_TOKEN (never argv), https://<hostname> published, mode `named`
 *   - no credential, or a malformed one → the quick tunnel, mode `quick`
 *   - the named run dying inside its first window → the quick tunnel
 *   - Cloudflare refusing the token → credential removed, its fingerprint kept
 *   - the token never reaches stdout, whatever cloudflared prints
 *   - the length bounds on the token and the hostname label, which used to be
 *     bounded repeats in a bash regex, still accept and reject the same strings —
 *     and validating the credential no longer costs the supervisor 260 MB
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const RUN_TUNNEL = path.join(process.cwd(), "scripts/run-tunnel.sh");
const HOST = "amber-otter-k7m2p9qx4w3n.clawbox.tech";
const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
const QUICK_URL = "https://fake-quick-789.trycloudflare.com";

let root: string;
let fakeBin: string;
let callLog: string;

// Every fixture is started `detached: true`, so one signal reaps the whole group:
// run-tunnel.sh, its pipeline subshell and the fake cloudflared's `while true`
// loop. That only helps if something always sends it. When it was sent from
// stop() alone, a test that failed — or a vitest abort — before stop() left the
// group behind: six of them (18 processes) were once found still running four
// hours after the suite finished, their temp dirs long deleted. Every start() is
// recorded here and reaped in afterEach, pass or fail.
const spawned: ChildProcess[] = [];

function reapSpawned() {
  let failure: unknown;
  for (const child of spawned.splice(0)) {
    if (child.pid == null) continue;
    try {
      // A negative pid signals the group. The group outliving the leader is
      // exactly the leak being closed here, so signal it even once the child
      // itself has exited.
      process.kill(-child.pid, "SIGTERM");
    } catch (err) {
      // ESRCH: nothing left in the group — the outcome this is here to get.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH" && !failure) failure = err;
    }
  }
  if (failure) throw failure;
}

// Belt and braces for the case afterEach cannot cover: vitest tearing the worker
// down mid-test. Whatever afterEach already reaped is gone from the array.
process.once("exit", reapSpawned);

const cf = (name: string) => path.join(root, "data", "cloudflared", name);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "clawbox-run-tunnel-named-"));
  fakeBin = path.join(root, "fake-cloudflared");
  callLog = path.join(root, "calls.log");
  mkdirSync(path.join(root, "data", "cloudflared"), { recursive: true });
  // FAKE_NAMED: ok | die | refuse | late. Records argv (one line per call) and
  // whether TUNNEL_TOKEN arrived intact, without ever writing the token itself.
  writeFileSync(
    fakeBin,
    `#!/usr/bin/env bash
printf 'argv:%s\\n' "$*" >> "${callLog}"
if [[ " $* " == *" run "* ]]; then
  if [ "\${TUNNEL_TOKEN:-}" = "${TOKEN}" ]; then echo "env:token-ok" >> "${callLog}"; else echo "env:token-missing" >> "${callLog}"; fi
  case "\${FAKE_NAMED:-ok}" in
    ok)
      echo "INF Starting tunnel tunnelID=abc token=\${TUNNEL_TOKEN}" >&2
      echo "INF Registered tunnel connection connIndex=0 location=fra01 protocol=quic" >&2
      while true; do sleep 0.2; done ;;
    die) echo "ERR failed to dial edge" >&2; exit 1 ;;
    refuse) echo "Provided Tunnel token is not valid." >&2; exit 1 ;;
    late) echo "INF Registered tunnel connection connIndex=0" >&2; sleep 1; exit 3 ;;
  esac
fi
if [ -n "\${TUNNEL_TOKEN:-}" ]; then echo "env:quick-saw-token" >> "${callLog}"; fi
echo "INF |  ${QUICK_URL}  |" >&2
while true; do sleep 0.2; done
`,
    { mode: 0o755 },
  );
});

afterEach(() => {
  // Before the temp dir goes: the leaked groups found on the box were still
  // running with the CLAWBOX_ROOT they had been started with already deleted.
  reapSpawned();
  rmSync(root, { recursive: true, force: true });
});

function writeCredential(content = `hostname=${HOST}\ntoken=${TOKEN}\n`) {
  writeFileSync(cf("named-tunnel"), content, { mode: 0o600 });
}

interface Run {
  child: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

function start(env: Record<string, string> = {}): Run {
  let out = "";
  const child = spawn("bash", [RUN_TUNNEL], {
    env: { ...process.env, CLAWBOX_ROOT: root, CLOUDFLARED_BIN: fakeBin, ...env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(child);
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code, signal) => resolve(signal ? null : code));
  });
  return { child, output: () => out, exited };
}

async function waitFor(pred: () => boolean) {
  for (let i = 0; i < 600 && !pred(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(pred()).toBe(true);
}

const urlIs = (url: string) => () =>
  existsSync(cf("tunnel.url")) && readFileSync(cf("tunnel.url"), "utf-8").trim() === url;

async function stop(run: Run) {
  process.kill(-run.child.pid!, "SIGTERM");
  return run.exited;
}

const calls = () => (existsSync(callLog) ? readFileSync(callLog, "utf-8") : "");

/** One of the Vm* lines of /proc/<pid>/status, in kB. */
function procVmKb(pid: number, field: "VmPeak" | "VmSize"): number {
  const status = readFileSync(`/proc/${pid}/status`, "utf-8");
  const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(status);
  expect(match, `no ${field} line in /proc/${pid}/status`).not.toBeNull();
  return Number(match![1]);
}

/** A token of `length` characters from the alphabet the script accepts. */
const tokenOf = (length: number) => "a".repeat(length);

describe("run-tunnel.sh — named tunnel", () => {
  it("runs the named tunnel when a credential is on file, and publishes its hostname", async () => {
    writeCredential();
    const run = start();
    await waitFor(urlIs(`https://${HOST}`));
    // record_url prints this after tunnel.url and the history line are written.
    await waitFor(() => run.output().includes("captured URL"));

    expect(readFileSync(cf("tunnel.mode"), "utf-8").trim()).toBe("named");
    expect(calls()).toContain("argv:tunnel --no-autoupdate run --url http://localhost:80");
    expect(calls()).toContain("env:token-ok");
    // The token is never on argv…
    expect(calls()).not.toContain(TOKEN);
    // …and never forwarded to the journal, even when cloudflared prints it.
    expect(run.output()).not.toContain(TOKEN);
    expect(run.output()).toContain("token=[redacted]");
    // The history records the stable URL, and only the URL.
    expect(readFileSync(cf("tunnel-url.log"), "utf-8")).toMatch(new RegExp(`Z https://${HOST.replace(/\./g, "\\.")}\\n$`));

    expect(await stop(run)).toBe(0);
    // A stop is not a failure: no quick tunnel was started behind it.
    expect(calls().match(/^argv:/gm)).toHaveLength(1);
    expect(existsSync(cf("tunnel.mode"))).toBe(false);
    expect(existsSync(cf("named-tunnel"))).toBe(true);
  });

  it("runs the quick tunnel exactly as before when no credential is on file", async () => {
    const run = start();
    await waitFor(urlIs(QUICK_URL));
    expect(readFileSync(cf("tunnel.mode"), "utf-8").trim()).toBe("quick");
    expect(calls()).toBe(`argv:tunnel --no-autoupdate --url http://localhost:80\n`);
    expect(await stop(run)).toBe(0);
  });

  it("ignores a malformed credential and runs the quick tunnel", async () => {
    writeCredential(`hostname=evil.example.com\ntoken=${TOKEN}\n`);
    const run = start();
    await waitFor(urlIs(QUICK_URL));
    expect(calls()).not.toContain(" run ");
    expect(run.output()).not.toContain(TOKEN);
    await stop(run);
  });

  it("does not let an inherited TUNNEL_TOKEN reach the quick tunnel", async () => {
    const run = start({ TUNNEL_TOKEN: TOKEN });
    await waitFor(urlIs(QUICK_URL));
    expect(calls()).not.toContain("env:quick-saw-token");
    await stop(run);
  });

  it("falls back to the quick tunnel when the named run dies in its first minute", async () => {
    writeCredential();
    const run = start({ FAKE_NAMED: "die" });
    await waitFor(urlIs(QUICK_URL));
    expect(readFileSync(cf("tunnel.mode"), "utf-8").trim()).toBe("quick");
    expect(run.output()).toContain("falling back to the quick tunnel");
    // An early death is not a refusal: the credential stays for the next start.
    expect(readFileSync(cf("named-tunnel"), "utf-8")).toContain(TOKEN);
    expect(existsSync(cf("named-refused"))).toBe(false);
    expect(run.output()).not.toContain(TOKEN);
    await stop(run);
  });

  it("removes a credential Cloudflare refused, remembers its fingerprint, and falls back", async () => {
    writeCredential();
    const run = start({ FAKE_NAMED: "refuse" });
    await waitFor(urlIs(QUICK_URL));
    expect(existsSync(cf("named-tunnel"))).toBe(false);
    expect(readFileSync(cf("named-refused"), "utf-8").trim()).toBe(
      createHash("sha256").update(TOKEN).digest("hex"),
    );
    expect(run.output()).toContain("Cloudflare refused the named tunnel credential");
    expect(run.output()).not.toContain(TOKEN);
    await stop(run);
  });

  it("exits with the named run's status (no fallback) once it had outlived its first window", async () => {
    writeCredential();
    const run = start({ FAKE_NAMED: "late", NAMED_EARLY_EXIT_SECS: "0" });
    expect(await run.exited).toBe(3);
    expect(calls().match(/^argv:/gm)).toHaveLength(1);
    expect(existsSync(cf("named-tunnel"))).toBe(true);
    // Cleared on exit, like tunnel.url.
    expect(existsSync(cf("tunnel.mode"))).toBe(false);
  });

  it.runIf(process.platform === "linux")(
    "validates the credential without allocating a bounded-repeat NFA",
    async () => {
      writeCredential();
      const run = start();
      await waitFor(urlIs(`https://${HOST}`));

      // The supervisor validates the token once and then stays up for the whole
      // tunnel lifetime, so whatever that match allocates it holds until the
      // tunnel stops. glibc compiles a bounded repeat by expanding it into one
      // NFA state per permitted repetition, so `{32,4096}` left this bash at
      // VmSize 268 MB — on an 8 GB box, 261 MB of swap for a length check.
      // Measured here against the pre-fix script: VmPeak 279552 kB, VmSize
      // 268404 kB; against this one, 7800 kB for both. VmPeak is checked as well
      // as VmSize because it is the one figure glibc cannot hand back — a future
      // allocator that trimmed the arena after the match would hide the cost
      // from VmSize while still paying it.
      const ceilingKb = 32 * 1024;
      expect(procVmKb(run.child.pid!, "VmPeak")).toBeLessThan(ceilingKb);
      expect(procVmKb(run.child.pid!, "VmSize")).toBeLessThan(ceilingKb);

      expect(await stop(run)).toBe(0);
    },
  );

  // The bounds used to be the `{32,4096}` in the regex itself; they are an
  // explicit length check now, and the accepted set must not have moved.
  for (const { length, accepted } of [
    { length: 31, accepted: false },
    { length: 32, accepted: true },
    { length: 4096, accepted: true },
    { length: 4097, accepted: false },
  ]) {
    it(`${accepted ? "accepts" : "rejects"} a ${length}-character token`, async () => {
      const token = tokenOf(length);
      writeCredential(`hostname=${HOST}\ntoken=${token}\n`);
      const run = start();

      if (accepted) {
        await waitFor(urlIs(`https://${HOST}`));
        expect(readFileSync(cf("tunnel.mode"), "utf-8").trim()).toBe("named");
        expect(calls()).toContain("argv:tunnel --no-autoupdate run --url http://localhost:80");
      } else {
        // A rejected credential is not an error: the script falls back quietly.
        await waitFor(urlIs(QUICK_URL));
        expect(readFileSync(cf("tunnel.mode"), "utf-8").trim()).toBe("quick");
        expect(calls()).not.toContain(" run ");
      }
      expect(run.output()).not.toContain(token);

      await stop(run);
    });
  }

  // Same story for the hostname label: `{0,61}` between the first and last
  // character is a 63-character label, and a length check says so more cheaply.
  for (const { length, accepted } of [
    { length: 63, accepted: true },
    { length: 64, accepted: false },
  ]) {
    it(`${accepted ? "accepts" : "rejects"} a ${length}-character hostname label`, async () => {
      const host = `${"a".repeat(length)}.clawbox.tech`;
      writeCredential(`hostname=${host}\ntoken=${TOKEN}\n`);
      const run = start();

      if (accepted) {
        await waitFor(urlIs(`https://${host}`));
        expect(readFileSync(cf("tunnel.mode"), "utf-8").trim()).toBe("named");
      } else {
        await waitFor(urlIs(QUICK_URL));
        expect(calls()).not.toContain(" run ");
        expect(run.output()).not.toContain(TOKEN);
      }

      await stop(run);
    });
  }
});
