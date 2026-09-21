import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { readFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawn, spawnSync, execFileSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/**
 * Finding #14 of the 2026-09-05 security scan, the Whisper half.
 * `scripts/whisper-server.py` bound `/tmp/whisper-server.sock` and chmod'd it
 * 0666, so any other local uid on the box could make the clawbox user read
 * (and burn GPU time transcribing) any file it can open.
 *
 * Only the SOCKET half is mirrored from kokoro-server.py — 0600 plus the
 * SO_PEERCRED check. The `audio` field is deliberately NOT confined to a
 * directory: it is a READ path OpenClaw's media row hands in from wherever the
 * gateway downloaded a channel voice note, and an allow-list there would
 * silently break Telegram voice notes. This pins both facts on the real
 * `serve`, executed under python3 with `transcribe` stubbed.
 */

// Starts a real python3 process and waits on a socket: vitest's 5 s default is
// not enough on a loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SERVER = path.resolve(process.cwd(), "scripts/whisper-server.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
// SO_PEERCRED is Linux; the box is Linux and so is CI.
const canRun = hasPython3 && process.platform === "linux";

/** The socket server, verbatim: from its heading to the `__main__` block. */
function extractRegion(): string {
  const src = readFileSync(SERVER, "utf-8");
  const start = src.indexOf("# ── Unix socket server");
  const end = src.indexOf('\nif __name__ == "__main__":', start);
  if (start < 0 || end < 0) throw new Error("socket server region not found in whisper-server.py");
  return src.slice(start, end);
}

const REGION = canRun ? extractRegion() : "";

function stubs(sockPath: string): string {
  return [
    "import os, json, socket, struct, threading",
    `SOCKET_PATH = ${JSON.stringify(sockPath)}`,
    "def touch_activity():\n    pass",
    // Answers with the path it was handed, so the test can see the field
    // reached the engine unchanged, wherever it pointed.
    "def transcribe(model, audio_path):\n    return 'heard ' + audio_path",
  ].join("\n");
}

function evalRegion(lines: string[]): string {
  const program = [stubs("/tmp/unused.sock"), REGION, ...lines].join("\n");
  const out = execFileSync("python3", ["-c", program], { encoding: "utf-8" }).trim().split("\n");
  return out[out.length - 1];
}

class LiveServer {
  child: ChildProcess;
  sockPath: string;
  log = "";

  private constructor(child: ChildProcess, sockPath: string) {
    this.child = child;
    this.sockPath = sockPath;
  }

  static async start(sockPath: string): Promise<LiveServer> {
    const program = [
      stubs(sockPath),
      REGION,
      "t = threading.Thread(target=serve, args=(None,), daemon=True)",
      "t.start()",
      "t.join()",
    ].join("\n");
    const child = spawn("python3", ["-c", program], { stdio: ["ignore", "pipe", "pipe"] });
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

describe.skipIf(!canRun)("whisper-server.py — who may speak on its socket", () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), "whisper-sock-"));
  let server: LiveServer;

  beforeAll(async () => {
    server = await LiveServer.start(path.join(tmpDir, "whisper.sock"));
  });

  afterAll(() => {
    server?.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("binds the socket owner-only — the 0666 of old is gone", () => {
    expect(statSync(server.sockPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(SERVER, "utf-8")).not.toContain("0o666");
  });

  it("admits only its own user and root at the socket, read from the kernel", () => {
    const line = evalRegion([
      "print(json.dumps([peer_uid_allowed(os.getuid()), peer_uid_allowed(0), peer_uid_allowed(65534)]))",
    ]);
    expect(JSON.parse(line)).toEqual([true, true, false]);

    const src = readFileSync(SERVER, "utf-8");
    const serve = src.slice(src.indexOf("def serve("));
    expect(serve).toContain("peer_uid(conn)");
    expect(src).toContain("socket.SO_PEERCRED");
    expect(serve.indexOf("peer_uid_allowed(uid)")).toBeLessThan(serve.indexOf("touch_activity()"));
  });

  it("still transcribes an audio path from anywhere — a channel voice note is wherever the gateway put it", async () => {
    // The kokoro fix confines the OUTPUT path to the temp directory. That rule
    // must not be mirrored here: this is a read, and the media row hands in
    // the gateway's own download location.
    const note = path.join(tmpDir, "downloads", "telegram-voice-note.ogg");

    const reply = JSON.parse(await server.ask({ audio: note }));
    expect(reply).toEqual({ ok: true, text: `heard ${note}` });
  });

  it("keeps the protocol stt-client.py speaks: JSON in, {ok, text} or {ok, error} out", async () => {
    const reply = JSON.parse(await server.ask({ text: "no audio field" }));
    expect(reply.ok).toBe(false);
    expect(typeof reply.error).toBe("string");

    const src = readFileSync(SERVER, "utf-8");
    expect(src).toContain('SOCKET_PATH = "/tmp/whisper-server.sock"');
    expect(src).toContain('audio_path = req["audio"]');
  });
});
