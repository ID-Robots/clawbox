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
 */

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const RUN_TUNNEL = path.join(process.cwd(), "scripts/run-tunnel.sh");
const HOST = "amber-otter-k7m2p9qx4w3n.clawbox.tech";
const TOKEN = "eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=";
const QUICK_URL = "https://fake-quick-789.trycloudflare.com";

let root: string;
let fakeBin: string;
let callLog: string;

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
});
