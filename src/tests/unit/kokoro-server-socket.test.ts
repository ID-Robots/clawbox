import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  lstatSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Finding #14 of the 2026-09-05 security scan. `scripts/kokoro-server.py`
 * bound `/tmp/kokoro-server.sock` and chmod'd it 0666, then handed the
 * request's `output` straight to `sf.write` — so any other local uid on the
 * box (a compromised avahi-daemon, the captive portal's dnsmasq as `nobody`)
 * could name `~/.openclaw/openclaw.json` and have the clawbox user truncate it
 * with WAV bytes.
 *
 * Every legitimate client is the clawbox user (or root, which no mode stops),
 * and both real clients mktemp the WAV under `${TMPDIR:-/tmp}` BEFORE asking
 * (clawbox-tts.sh's `kokoro_via_server`, kokoro-client.sh). So the server now
 * refuses everyone else at the socket (0600 + SO_PEERCRED) and honours exactly
 * that one output shape: an existing regular *.wav of ours directly in the
 * temp directory.
 *
 * These EXECUTE the shipped script's own socket region under python3 — the
 * real `serve_unix`, `resolve_output`, `open_output` and the peer check —
 * with `generate_to_file` stubbed to write a fixed byte string through the
 * same open, so the test fails if the real file drifts. A wrong allow-list
 * would silently push every spoken reply to the cloud voice through
 * clawbox-tts.sh's fallback, which is why the real region and not a copy.
 */

// Starts real python3 processes and waits on sockets: vitest's 5 s default is
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SERVER = path.resolve(process.cwd(), "scripts/kokoro-server.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
// SO_PEERCRED is Linux; the box is Linux and so is CI.
const canRun = hasPython3 && process.platform === "linux";

/** What the stubbed generate_to_file writes — recognisable, and nothing like a WAV. */
const WRITTEN = "kokoro-socket-test: stand-in for the utterance\n";

/**
 * Pull the socket server out of the script verbatim: from its heading to the
 * `# ── Main` heading. Nothing in between imports soundfile or kokoro, which
 * do not exist on a CI runner.
 */
function extractRegion(): string {
  const src = readFileSync(SERVER, "utf-8");
  const start = src.indexOf("# ── Unix socket server (legacy)");
  // The trailing rule char keeps this from landing on the heading's mention
  // inside the region's own comment.
  const end = src.indexOf("\n# ── Main ─", start);
  if (start < 0 || end < 0) throw new Error("socket server region not found in kokoro-server.py");
  return src.slice(start, end);
}

const REGION = canRun ? extractRegion() : "";

/** The stubs the region needs in front of it, with the socket in `sockPath`. */
function stubs(sockPath: string): string {
  return [
    "import os, json, socket, struct, tempfile, stat, threading",
    `SOCKET_PATH = ${JSON.stringify(sockPath)}`,
    'DEFAULT_VOICE = "af_heart"',
    "def touch_activity():\n    pass",
    // The same open as the real generate_to_file uses, so the O_NOFOLLOW /
    // no-O_CREAT contract is what is exercised, not a stand-in for it.
    "def generate_to_file(text, output_path, voice=DEFAULT_VOICE):",
    "    with open_output(output_path) as f:",
    `        f.write(${JSON.stringify(WRITTEN)}.encode())`,
  ].join("\n");
}

/** Run a one-shot program with the region loaded and print its last line. */
function evalRegion(lines: string[], sockPath = "/tmp/unused.sock"): string {
  const program = [stubs(sockPath), REGION, ...lines].join("\n");
  const out = execFileSync("python3", ["-c", program], { encoding: "utf-8" }).trim().split("\n");
  return out[out.length - 1];
}

/** A live server: the real serve_unix on a thread inside a python3 child. */
class LiveServer {
  child: ChildProcess;
  sockPath: string;
  log = "";

  private constructor(child: ChildProcess, sockPath: string) {
    this.child = child;
    this.sockPath = sockPath;
  }

  static async start(sockPath: string, env: Record<string, string> = {}): Promise<LiveServer> {
    const program = [
      stubs(sockPath),
      REGION,
      // The real script runs serve_unix on a daemon thread beside the HTTP
      // server; join() here so a thread that dies takes the process with it
      // and the traceback reaches this test rather than a silent hang.
      "t = threading.Thread(target=serve_unix, args=(None,), daemon=True)",
      "t.start()",
      "t.join()",
    ].join("\n");
    const child = spawn("python3", ["-c", program], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const server = new LiveServer(child, sockPath);
    child.stdout?.on("data", (d) => (server.log += String(d)));
    child.stderr?.on("data", (d) => (server.log += String(d)));
    await server.waitFor("listening on");
    return server;
  }

  private waitFor(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        if (this.log.includes(text)) return resolve();
        if (this.child.exitCode !== null) return reject(new Error(`server exited:\n${this.log}`));
        if (Date.now() - started > 20_000) return reject(new Error(`server never said "${text}":\n${this.log}`));
        setTimeout(tick, 25);
      };
      tick();
    });
  }

  /** Send one request the way the clients do (write, shutdown, read the reply). */
  ask(req: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = net.connect(this.sockPath);
      let reply = "";
      conn.on("connect", () => conn.end(JSON.stringify(req)));
      conn.on("data", (d) => (reply += String(d)));
      conn.on("close", () => resolve(reply));
      conn.on("error", reject);
    });
  }

  stop(): void {
    this.child.kill("SIGKILL");
  }
}

/** A unique name directly in `dir` (the clients' mktemp shape), never created here. */
function uniqueName(dir: string, suffix: string): string {
  return path.join(dir, `kokoro-socket-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}${suffix}`);
}

describe.skipIf(!canRun)("kokoro-server.py — who may speak on its socket, and where it will write", () => {
  // Under os.tmpdir() (short: a Unix socket path is capped at ~108 bytes), and
  // the python child inherits the same TMPDIR, so its tempfile.gettempdir()
  // and this test's os.tmpdir() name the same directory.
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "kokoro-sock-"));
  const tempRoot = os.tmpdir();
  let server: LiveServer;
  const created: string[] = [];

  beforeAll(async () => {
    server = await LiveServer.start(path.join(tmpDir, "kokoro.sock"));
  });

  afterAll(() => {
    server?.stop();
    for (const f of created) rmSync(f, { force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A regular file of ours at `p` (mode 0600, the way mktemp makes one). */
  function regular(p: string, content = "victim: must survive\n"): string {
    writeFileSync(p, content, { flag: "wx", mode: 0o600 });
    created.push(p);
    return p;
  }

  it("binds the socket owner-only — the 0666 of old is gone", () => {
    expect(statSync(server.sockPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(SERVER, "utf-8")).not.toContain("0o666");
  });

  it("fills a mktemp'd .wav directly in the temp directory — the shape both clients send", async () => {
    const wav = regular(uniqueName(tempRoot, ".wav"), "");

    expect(await server.ask({ text: "hello", output: wav })).toBe("OK");
    expect(readFileSync(wav, "utf-8")).toBe(WRITTEN);
  });

  it("refuses a request that names no output — it never mktemps one of its own", async () => {
    const reply = await server.ask({ text: "hello" });

    expect(reply).toBe("ERR:output required");
    expect(readFileSync(SERVER, "utf-8")).not.toContain("mktemp(");
  });

  const VICTIM = "victim: must survive\n";

  /** Ask for `output`, and prove the target is byte-for-byte what it was. */
  async function refused(output: string, target: string): Promise<string> {
    const before = existsSync(target) ? readFileSync(target) : null;
    const reply = await server.ask({ text: "hello", output });
    expect(reply.startsWith("ERR:"), `expected a refusal, got ${JSON.stringify(reply)}`).toBe(true);
    const after = existsSync(target) ? readFileSync(target) : null;
    expect(after).toEqual(before);
    return reply;
  }

  it("refuses a regular file outside the temp directory and leaves it untouched", async () => {
    // What the exploit named: the gateway's config under a home directory.
    const home = path.join(tmpDir, "home", ".openclaw");
    mkdirSync(home, { recursive: true });
    const config = regular(path.join(home, "openclaw.json"), '{"gateway":{}}\n');
    const wavOutside = regular(path.join(home, "reply.wav"), VICTIM);

    await refused(config, config);
    // A .wav in a SUBDIRECTORY of the temp dir is outside too: the rule is
    // "directly in", the way mktemp puts it there.
    const reply = await refused(wavOutside, wavOutside);
    expect(reply).toContain("directly in the temp directory");
    expect(readFileSync(config, "utf-8")).toBe('{"gateway":{}}\n');
  });

  it("refuses a symlink inside the temp directory that points outside, and follows nothing", async () => {
    const victim = regular(path.join(tmpDir, "victim.wav"), VICTIM);
    const link = uniqueName(tempRoot, ".wav");
    symlinkSync(victim, link);
    created.push(link);

    const reply = await refused(link, victim);
    expect(reply).toContain("not a symlink");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("refuses a path that does not end in .wav", async () => {
    const txt = regular(uniqueName(tempRoot, ".txt"), VICTIM);

    const reply = await refused(txt, txt);
    expect(reply).toContain(".wav");
  });

  it("refuses a file that does not exist rather than creating it", async () => {
    const missing = uniqueName(tempRoot, ".wav");

    const reply = await refused(missing, missing);
    expect(reply).toContain("already exist");
    expect(existsSync(missing)).toBe(false);
  });

  it("refuses a relative path", async () => {
    const reply = await server.ask({ text: "hello", output: "kokoro.wav" });
    expect(reply).toContain("ERR:");
    expect(reply).toContain("absolute");
  });

  it("honours its own TMPDIR beside /tmp — where clawbox-tts.sh's mktemp goes when TMPDIR is set", async () => {
    // The clients mktemp under `${TMPDIR:-/tmp}` in THEIR environment; the
    // server keys its allow-list on ITS tempfile.gettempdir(). On the box both
    // are /tmp. This pins that a server whose TMPDIR moved accepts files there
    // AND still accepts /tmp, so a divergence refuses nothing it should not.
    const alt = path.join(tmpDir, "alt-tmp");
    mkdirSync(alt);
    const moved = await LiveServer.start(path.join(tmpDir, "moved.sock"), { TMPDIR: alt });
    try {
      const inAlt = regular(path.join(alt, "reply.wav"), "");
      expect(await moved.ask({ text: "hello", output: inAlt })).toBe("OK");
      expect(readFileSync(inAlt, "utf-8")).toBe(WRITTEN);

      const inTmp = regular(uniqueName("/tmp", ".wav"), "");
      expect(await moved.ask({ text: "hello", output: inTmp })).toBe("OK");
    } finally {
      moved.stop();
    }
  });

  it("admits only its own user and root at the socket, read from the kernel", () => {
    const line = evalRegion([
      "print(json.dumps([peer_uid_allowed(os.getuid()), peer_uid_allowed(0), peer_uid_allowed(65534)]))",
    ]);
    expect(JSON.parse(line)).toEqual([true, true, false]);

    // The check is made on every accepted connection with the kernel's own
    // answer, and a refused peer is not "activity" that keeps the model warm.
    const src = readFileSync(SERVER, "utf-8");
    const serve = src.slice(src.indexOf("def serve_unix("));
    expect(serve).toContain("peer_uid(conn)");
    expect(src).toContain("socket.SO_PEERCRED");
    expect(serve.indexOf("peer_uid_allowed(uid)")).toBeLessThan(serve.indexOf("touch_activity()"));
  });

  it("opens the resolved file without following a symlink and never creates one", () => {
    // resolve_output lstat'd a regular file; a symlink swapped in after that
    // has to fail at the open, not be written through.
    const victim = regular(path.join(tmpDir, "swap-victim.wav"), VICTIM);
    const link = path.join(tmpDir, "swapped.wav");
    symlinkSync(victim, link);
    const missing = path.join(tmpDir, "never-made.wav");

    const line = evalRegion([
      "def attempt(p):",
      "    try:",
      "        open_output(p).close()",
      "        return 'opened'",
      "    except OSError as exc:",
      "        return type(exc).__name__",
      `print(json.dumps([attempt(${JSON.stringify(link)}), attempt(${JSON.stringify(missing)}), os.path.exists(${JSON.stringify(missing)})]))`,
    ]);
    expect(JSON.parse(line)).toEqual(["OSError", "FileNotFoundError", false]);
    expect(readFileSync(victim, "utf-8")).toBe(VICTIM);

    // And the real generate_to_file goes through that open, as a file object:
    // soundfile's path form would re-open (and follow) the name.
    const src = readFileSync(SERVER, "utf-8");
    expect(src).toContain('sf.write(f, audio, 24000, format="WAV")');
    expect(src).not.toContain("sf.write(output_path");
    expect(src).toMatch(/os\.open\(path, os\.O_WRONLY \| os\.O_TRUNC \| os\.O_NOFOLLOW \| os\.O_CLOEXEC\)/);
  });

  it("keeps the protocol the clients speak: JSON in, OK out, the voice field, the socket path", () => {
    // clawbox-tts.sh, kokoro-client.sh and local-models.ts needed no edits for
    // this fix; this is what makes that true.
    const src = readFileSync(SERVER, "utf-8");
    expect(src).toContain('SOCKET_PATH = "/tmp/kokoro-server.sock"');
    expect(src).toContain('voice = req.get("voice", DEFAULT_VOICE)');
    expect(src).toContain('conn.sendall(b"OK")');
    // The idle exit still takes the socket with it.
    expect(src.slice(src.indexOf("def _idle_watchdog"), src.indexOf("# Voice mapping"))).toContain(
      "os.unlink(SOCKET_PATH)",
    );
  });
});
