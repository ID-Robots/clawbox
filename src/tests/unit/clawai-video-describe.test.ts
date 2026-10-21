import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

// Starts real processes (python3, ffmpeg): vitest's 5 s test and 10 s hook
// defaults are not enough on a loaded CI runner. See
// src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

// The helper the gateway's video row runs (see
// gateway-pre-start-clawai-video.test.ts for the row). It is driven here the
// way OpenClaw drives it, against a loopback stand-in for the proxy that
// records what the box would have sent. Clips are made with the real ffmpeg
// when the machine has one; the refusals need none.

const HELPER = path.resolve(process.cwd(), "scripts/openclaw/clawai-video-describe.py");
const hasPython3 = spawnSync("python3", ["--version"], { stdio: "ignore" }).status === 0;
const PYTHON = hasPython3
  ? execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf-8" }).trim()
  : "";
const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

const TOKEN = "claw_test_0000000000000000000000000000";
const VISION_ID = "deepseek-v4-flash-vision-exp";
const REPLY = "A test pattern with a moving counter in the corner.";

interface Seen { url: string; auth: string | undefined; body: Record<string, unknown> }
let server: Server;
let base: string;
let seen: Seen[];
let answer: { status: number; body: unknown };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        url: req.url ?? "",
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>,
      });
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/ai`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "clawai-video-describe-"));
  seen = [];
  answer = { status: 200, body: { choices: [{ message: { role: "assistant", content: REPLY } }] } };
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

type Config = Record<string, unknown>;

/** openclaw.json of a box paired to ClawBox AI, its deepseek entry aimed at the stand-in. */
function writeConfig(patch: (cfg: Config) => void = () => {}): string {
  const cfg: Config = {
    models: {
      providers: {
        deepseek: {
          baseUrl: base,
          apiKey: TOKEN,
          api: "openai-completions",
          models: [
            { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", input: ["text"] },
            { id: "gpt-5.6-luna", name: "ClawBox AI Vision (previous)", input: ["text", "image"] },
            { id: VISION_ID, name: "ClawBox AI Vision", input: ["text", "image"] },
          ],
        },
      },
    },
    agents: { defaults: { imageModel: { primary: `deepseek/${VISION_ID}` } } },
  };
  patch(cfg);
  const file = path.join(dir, "openclaw.json");
  writeFileSync(file, JSON.stringify(cfg));
  return file;
}

function clip(name: string, seconds: number, size = "320x240", rate = 5): string {
  const out = path.join(dir, name);
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc=duration=${seconds}:size=${size}:rate=${rate}`,
    "-c:v", "mpeg4", "-y", out,
  ]);
  return out;
}

/** Run the helper with the arguments the gateway row passes, templates resolved or not. */
function run(
  video: string,
  {
    prompt = "{{Prompt}}",
    maxChars = "{{MaxChars}}",
    env = {},
  }: { prompt?: string; maxChars?: string; env?: Record<string, string> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(PYTHON, [HELPER, "--max-chars", maxChars, "--prompt", prompt, video], {
      env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: dir, LANG: "C.UTF-8", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

type Part = { type: string; text?: string; image_url?: { url: string } };
function parts(body: Record<string, unknown>): Part[] {
  const messages = body.messages as Array<{ content: Part[] }>;
  return messages[0].content;
}

describe.skipIf(!hasPython3 || !hasFfmpeg)("clawai-video-describe.py on a real clip", () => {
  it("describes the clip from its frames, on the box's own vision model, in one request", async () => {
    const config = writeConfig();
    const out = await run(clip("four.mp4", 4), { env: { OPENCLAW_CONFIG_PATH: config } });

    expect(out.stderr).toBe("");
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe(REPLY);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/ai/chat/completions");
    expect(seen[0].auth).toBe(`Bearer ${TOKEN}`);
    // The image model the box already looks at pictures with, not merely the
    // first vision entry the provider lists.
    expect(seen[0].body.model).toBe(VISION_ID);

    const [text, ...images] = parts(seen[0].body);
    expect(text.type).toBe("text");
    expect(text.text).toContain("4 images are frames taken in order from one video");
    expect(text.text).toContain("There is no sound track");
    // `{{Prompt}}` left unresolved is no prompt at all.
    expect(text.text).toContain("Describe the video.");
    expect(text.text).not.toContain("{{");
    expect(images).toHaveLength(4);
    for (const image of images) {
      expect(image.type).toBe("image_url");
      expect(image.image_url?.url.startsWith("data:image/jpeg;base64,")).toBe(true);
      const jpeg = Buffer.from(image.image_url!.url.split(",")[1], "base64");
      expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    }
  });

  it("spends at most the frame budget on a long clip", async () => {
    const config = writeConfig();
    const out = await run(clip("long.mp4", 30, "160x120", 2), { env: { OPENCLAW_CONFIG_PATH: config } });

    expect(out.code).toBe(0);
    expect(parts(seen[0].body).filter((p) => p.type === "image_url")).toHaveLength(8);
  });

  it("asks the gateway's prompt, within its length limit, and holds the answer to it", async () => {
    const config = writeConfig();
    answer = { status: 200, body: { choices: [{ message: { content: [{ type: "text", text: "A colour test card that goes on and on." }] } }] } };
    const out = await run(clip("short.mp4", 2), {
      prompt: "What is on screen?",
      maxChars: "20",
      env: { OPENCLAW_CONFIG_PATH: config },
    });

    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe("A colour test card t");
    const text = parts(seen[0].body)[0].text ?? "";
    expect(text).toContain("What is on screen?");
    expect(text).toContain("Answer in at most 20 characters.");
  });

  it("finds the config under OPENCLAW_STATE_DIR too", async () => {
    const config = writeConfig();
    const state = path.join(dir, "state");
    mkdirSync(state);
    copyFileSync(config, path.join(state, "openclaw.json"));
    const out = await run(clip("one.mp4", 1), { env: { OPENCLAW_STATE_DIR: state } });

    expect(out.code).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it("fails on a refusal from the proxy, and never prints the token", async () => {
    const config = writeConfig();
    answer = { status: 429, body: { error: { code: "allowance_exhausted", echo: TOKEN } } };
    const out = await run(clip("capped.mp4", 1), { env: { OPENCLAW_CONFIG_PATH: config } });

    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("HTTP 429");
    expect(out.stderr).toContain("allowance_exhausted");
    expect(out.stderr).not.toContain(TOKEN);
  });

  it("fails on an empty answer rather than printing nothing as a description", async () => {
    const config = writeConfig();
    answer = { status: 200, body: { choices: [{ message: { content: "   " } }] } };
    const out = await run(clip("empty.mp4", 1), { env: { OPENCLAW_CONFIG_PATH: config } });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("returned no description");
  });
});

describe.skipIf(!hasPython3)("clawai-video-describe.py refusals", () => {
  /** Any file will do: these fail before a frame is read. */
  function video(): string {
    const file = path.join(dir, "clip.mp4");
    writeFileSync(file, "not really a video");
    return file;
  }

  it("refuses a box that is not paired to ClawBox AI, without a request", async () => {
    const config = writeConfig((cfg) => {
      ((cfg.models as Config).providers as Record<string, Config>).deepseek.apiKey = "sk-owner-own-key";
    });
    const out = await run(video(), { env: { OPENCLAW_CONFIG_PATH: config } });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("not paired to ClawBox AI");
    expect(out.stderr).not.toContain("sk-owner-own-key");
    expect(seen).toHaveLength(0);
  });

  it("refuses without a vision model to send the frames to", async () => {
    const config = writeConfig((cfg) => {
      const ds = ((cfg.models as Config).providers as Record<string, Config>).deepseek;
      ds.models = (ds.models as Config[]).filter((m) => !(m.input as string[]).includes("image"));
    });
    const out = await run(video(), { env: { OPENCLAW_CONFIG_PATH: config } });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("no ClawBox AI vision model");
    expect(seen).toHaveLength(0);
  });

  it("refuses without ffmpeg, and says so", async () => {
    const config = writeConfig();
    const empty = path.join(dir, "bin");
    mkdirSync(empty);
    const out = await run(video(), { env: { OPENCLAW_CONFIG_PATH: config, PATH: empty } });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("ffmpeg is not installed");
    expect(seen).toHaveLength(0);
  });

  it("refuses a video that is not there", async () => {
    const out = await run(path.join(dir, "gone.mp4"), { env: { OPENCLAW_CONFIG_PATH: writeConfig() } });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("the video file is missing");
  });

  it("refuses an unreadable config", async () => {
    const out = await run(video(), { env: { OPENCLAW_CONFIG_PATH: path.join(dir, "missing.json") } });

    expect(out.code).toBe(1);
    expect(out.stderr).toContain("cannot read the gateway config");
  });
});
