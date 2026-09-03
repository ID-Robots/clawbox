import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * A Hermes reply gets spoken, the way an OpenClaw one already is.
 *
 * On OpenClaw the GATEWAY speaks the finished reply and pushes a second
 * message carrying the audio as an attachment part; the chat folds the two
 * together and renders one bubble with a player. Hermes has a voice of its own
 * — `POST /api/audio/speak`, which resolves the same `tts.provider` the Voice
 * tab writes — but it never speaks a reply unbidden, so nothing was ever asked
 * and a Hermes box answered in silence however well its voice was configured.
 *
 * The route asks now, and announces the clip as a `MEDIA:` line: exactly what
 * it already does for a picture the agent drew, which means `splitAssistantMedia`
 * lifts it into the same `audio` array the gateway's attachment produces and
 * the renderer needed no edition of its own. These tests pin that shape, and
 * the two ways it must fail soft.
 */

const spawned: Array<{ bin: string; args: string[] }> = [];
let stderrBanner = "session_id: 20260810_221825_609d1e";
let stdoutReply = "The lantern is green.";

vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  spawn: (bin: string, args: string[]) => {
    spawned.push({ bin, args });
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(() => {
      if (stdoutReply) child.stdout.emit("data", Buffer.from(stdoutReply));
      if (stderrBanner) child.stderr.emit("data", Buffer.from(stderrBanner));
      child.emit("close", 0);
    }, 0);
    return child;
  },
}));

vi.mock("@/lib/hermes-model-options", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-model-options")>()),
  getModelOptions: async () => {
    throw new Error("catalogue unavailable");
  },
}));

vi.mock("@/lib/harness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/harness")>()),
  getActiveHarness: async () => "hermes" as const,
  HERMES_BIN: "/home/clawbox/.local/bin/hermes",
}));

/** What `hermes config get` answers — this is what decides whether we speak. */
let hermesConfig: Record<string, string> = {};
vi.mock("@/lib/hermes-config-cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-config-cache")>()),
  hermesConfigGetMany: async (keys: string[]) =>
    Object.fromEntries(keys.map((k) => [k, hermesConfig[k] ?? ""])),
  hermesConfigGet: async (k: string) => hermesConfig[k] ?? "",
}));

/** Hermes' own speak endpoint. */
let speakCalls: Array<{ path: string; body: unknown }> = [];
let speakReply: () => Response = () => new Response("", { status: 500 });
vi.mock("@/lib/hermes-dashboard-auth", () => ({
  dashboardFetch: async (apiPath: string, init?: RequestInit) => {
    speakCalls.push({ path: apiPath, body: init?.body ? JSON.parse(String(init.body)) : null });
    return speakReply();
  },
  HERMES_DASHBOARD_UNIT: "clawbox-hermes-dashboard.service",
  DASHBOARD_WS_ORIGIN: "ws://127.0.0.2:9119",
}));

let restoreEnv: () => void = () => {};
let root: string;

/** A clip big enough to be audio rather than a bare container header. */
const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4096, 1)]);

function spokenOk(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      mime_type: "audio/wav",
      data_url: `data:audio/wav;base64,${WAV.toString("base64")}`,
      provider: "clawbox-local",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function post(body: Record<string, unknown>) {
  vi.resetModules();
  const { POST } = await import("@/app/setup-api/hermes/chat/route");
  return POST(
    new Request("http://localhost/setup-api/hermes/chat", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

const transcript = () =>
  fs
    .readFileSync(path.join(root, "data", "chat-transcripts", "desktop.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

beforeEach(() => {
  spawned.length = 0;
  speakCalls = [];
  speakReply = spokenOk;
  stdoutReply = "The lantern is green.";
  stderrBanner = "session_id: 20260810_221825_609d1e";
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-hermesspeak-"));
  restoreEnv = saveEnv("CLAWBOX_ROOT", "HOME", "OPENCLAW_HOME");
  process.env.CLAWBOX_ROOT = root;
  process.env.HOME = root;
  fs.mkdirSync(path.join(root, "data", "chat-media"), { recursive: true });
  // A box whose on-device voice is registered and selected.
  hermesConfig = {
    "tts.provider": "clawbox-local",
    "tts.providers.clawbox-local.type": "command",
    "tts.providers.clawbox-local.command": "/opt/clawbox-tts.sh --voice {voice}",
  };
});

afterEach(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("a Hermes reply on a box with a voice", () => {
  it("is spoken through Hermes' own endpoint", async () => {
    const res = await post({ message: "what colour" });
    expect(res.status).toBe(200);

    // Hermes' own speak API — not a chain of our own, and not the openclaw CLI.
    expect(speakCalls.map((c) => c.path)).toContain("/api/audio/speak");
    // The words, never the MEDIA: machinery around them.
    expect((speakCalls[0].body as { text: string }).text).toBe("The lantern is green.");
  });

  it("hands the chat a playable clip on the reply", async () => {
    await post({ message: "what colour" });

    const assistant = transcript().filter((m) => m.role === "assistant").pop();
    // The same `audio` array an OpenClaw attachment part produces, so one
    // renderer serves both editions.
    expect(assistant.audio).toHaveLength(1);
    expect(assistant.audio[0]).toMatch(/^\/setup-api\/chat\/media\?path=/);
    // And the caption is still the caption — the directive never reaches it.
    expect(assistant.text).toBe("The lantern is green.");
    expect(assistant.text).not.toMatch(/MEDIA:/);
  });

  it("writes the clip where the media route will serve it from", async () => {
    await post({ message: "what colour" });

    const dir = path.join(root, "data", "chat-media", "chat-spoken");
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.wav$/);
    expect(fs.statSync(path.join(dir, files[0])).size).toBe(WAV.byteLength);
  });
});

describe("a Hermes reply that cannot be spoken", () => {
  it("still answers, silently, when the voice refuses", async () => {
    // FALSE FAILURE is the risk here: losing the answer because the voice was
    // busy would be a far worse trade than losing the audio.
    speakReply = () => new Response("nope", { status: 503 });
    const res = await post({ message: "what colour" });

    expect(res.status).toBe(200);
    const assistant = transcript().filter((m) => m.role === "assistant").pop();
    expect(assistant.text).toBe("The lantern is green.");
    expect(assistant.audio).toBeUndefined();
  });

  it("never claims a clip the endpoint did not actually send", async () => {
    // FALSE SUCCESS: `ok: true` carrying a container header and nothing else.
    speakReply = () =>
      new Response(
        JSON.stringify({ ok: true, mime_type: "audio/wav", data_url: "data:audio/wav;base64,UklGRg==" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    await post({ message: "what colour" });

    const assistant = transcript().filter((m) => m.role === "assistant").pop();
    expect(assistant.audio).toBeUndefined();
  });
});

describe("a Hermes box with no voice configured", () => {
  it("is never asked to speak", async () => {
    // Hermes' factory `edge` is Microsoft's cloud voice, which ClawBox does not
    // offer — so this box has no voice of OURS and must not be spoken through.
    hermesConfig = { "tts.provider": "edge" };
    const res = await post({ message: "what colour" });

    expect(res.status).toBe(200);
    expect(speakCalls).toHaveLength(0);
    const assistant = transcript().filter((m) => m.role === "assistant").pop();
    expect(assistant.audio).toBeUndefined();
  });
});
