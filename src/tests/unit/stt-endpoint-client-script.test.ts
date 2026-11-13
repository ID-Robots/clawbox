import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, spawnSync } from "child_process";
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

// scripts/stt-endpoint-client.py — the channel half of the owner's own speech
// server (TASK-2501 PR-D). OpenClaw runs it as a CLI row for every voice note
// and reads the transcript from stdout. Run for real here against a mock
// OpenAI-compatible server on loopback: what it sends, and what it refuses.

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const SCRIPT = path.resolve(process.cwd(), "scripts/stt-endpoint-client.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;

let dir: string;
let server: http.Server;
let port: number;
let seen: { url?: string; auth?: string; body?: string }[];
let answer: { status: number; body: string };

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stt-endpoint-client-"));
  fs.mkdirSync(path.join(dir, "data"));
  fs.writeFileSync(path.join(dir, "voice.ogg"), Buffer.alloc(2048, 7));
  seen = [];
  answer = { status: 200, body: JSON.stringify({ text: " a voice note " }) };
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString("latin1") });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(dir, { recursive: true, force: true });
});

function store(record: unknown, key?: string, keyFor?: string): void {
  fs.writeFileSync(path.join(dir, "data", "config.json"), JSON.stringify({ stt_endpoint: record }));
  // As the app writes it (stt-endpoint.ts): bound to the address it was saved for.
  const base = (record as { baseUrl?: string } | null)?.baseUrl;
  if (key) fs.writeFileSync(path.join(dir, "data", ".stt-endpoint-key"), JSON.stringify({ v: 1, for: keyFor ?? base, key }));
}

/** Async, so the mock server in this same process can answer while it runs. */
function run(): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("python3", ["-I", SCRIPT, path.join(dir, "voice.ogg")], {
      env: { PATH: process.env.PATH ?? "", CLAWBOX_DEVICE_STORE: path.join(dir, "data", "config.json"), HTTP_PROXY: "http://192.0.2.1:9", http_proxy: "http://192.0.2.1:9", NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

describe.skipIf(!hasPython3)("stt-endpoint-client.py", () => {
  it("never sends a key stored for another address, nor one in any other shape (TASK-2501)", async () => {
    store({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "asr-small" }, "key-of-b", "http://127.0.0.2:8000/v1");
    expect((await run()).status).toBe(0);
    expect(seen[0].auth).toBeUndefined();
    fs.writeFileSync(path.join(dir, "data", ".stt-endpoint-key"), "a-bare-key");
    expect((await run()).status).toBe(0);
    expect(seen[1].auth).toBeUndefined();
  });

  it("posts the voice note with the model and key to the saved server and prints the transcript", async () => {
    store({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "asr-small" }, "lan-key\n");
    const r = await run();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("a voice note\n");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/v1/audio/transcriptions");
    expect(seen[0].auth).toBe("Bearer lan-key");
    expect(seen[0].body).toContain('name="model"\r\n\r\nasr-small');
    expect(seen[0].body).toContain('filename="voice.ogg"');
  });

  it("sends no key when none is saved, and ignores an outbound proxy", async () => {
    store({ baseUrl: `http://localhost:${port}/v1`, model: "whisper-1" });
    const r = await run();
    expect(r.status).toBe(0);
    expect(seen[0].auth).toBeUndefined();
  });

  it("refuses an address outside the local network and sends nothing", async () => {
    store({ baseUrl: "http://8.8.8.8/v1", model: "whisper-1" }, "lan-key");
    const r = await run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not on this box or the local network; nothing was sent/);
    expect(r.stderr).not.toContain("lan-key");
  });

  it("fails on a server error, a redirect or no transcript, without printing one", async () => {
    store({ baseUrl: `http://127.0.0.1:${port}/v1`, model: "whisper-1" });
    answer = { status: 500, body: "boom" };
    expect((await run()).status).toBe(1);
    answer = { status: 200, body: JSON.stringify({ nope: true }) };
    const r = await run();
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("");
  });

  it("fails when no server is saved", async () => {
    fs.writeFileSync(path.join(dir, "data", "config.json"), "{}");
    const r = await run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no speech server is saved/);
  });
});
