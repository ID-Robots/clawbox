/**
 * The owner's OpenAI access for coding runs (src/lib/coding-openai.ts), against
 * real files in a temporary box: the key in the device secret store, the
 * ChatGPT sign-in in the coding agent's own Codex home, the limit in the
 * config — and the Codex device flow, with the CLI replaced by a child that
 * prints what codex-cli 0.154.0 printed for `login --device-auth`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";
import { PassThrough } from "stream";
import fs from "fs";
import os from "os";
import path from "path";
import type { ChildProcess } from "child_process";
import { saveEnv } from "@/tests/helpers/env";

type Lib = typeof import("@/lib/coding-openai");

/** A placeholder in the shape of an OpenAI project key — not a real credential. */
const KEY = "sk-proj-unit-test-placeholder-0123456789";

let lib: Lib;
let root: string;
let home: string;
let restore: () => void;

/** What `codex login --device-auth` prints, colours and all (captured; the code replaced). */
const DEVICE_OUTPUT = [
  "",
  "Welcome to Codex [v\u001b[90m0.154.0\u001b[0m]",
  "\u001b[90mOpenAI's command-line coding agent\u001b[0m",
  "",
  "Follow these steps to sign in with ChatGPT using device code authorization:",
  "",
  "1. Open this link in your browser and sign in to your account",
  "   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m",
  "",
  "2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m",
  "   \u001b[94mAB1C-DEFGH\u001b[0m",
  "",
].join("\n");

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  pid: undefined;
  exitCode: number | null;
  signalCode: string | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn(() => {
    child.signalCode = "SIGTERM";
    return true;
  });
  return child;
}

function installCodexBinary(): void {
  fs.mkdirSync(path.join(home, ".local", "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".local", "bin", "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

function writeAuth(content: unknown): void {
  fs.mkdirSync(lib.codexHome(), { recursive: true });
  fs.writeFileSync(path.join(lib.codexHome(), "auth.json"), JSON.stringify(content));
}

const readConfig = () => JSON.parse(fs.readFileSync(path.join(root, "data", "config.json"), "utf8")) as Record<string, unknown>;

beforeEach(async () => {
  restore = saveEnv("CLAWBOX_ROOT", "SESSION_SECRET", "HOME");
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-openai-")));
  home = path.join(root, "home");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(root, "data", ".session-secret"), "5e".repeat(32), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ clawai_token: "keep_me" }));
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = "ab".repeat(32);
  process.env.HOME = home;
  vi.resetModules();
  (await import("@/lib/project-secrets"))._resetSecretKeyCacheForTests();
  lib = await import("@/lib/coding-openai");
});

afterEach(() => {
  lib._resetCodexLoginForTests();
  lib._setCodexSpawnForTests(null);
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("the key's shape", () => {
  it("takes OpenAI's key shapes and nothing pasted into the wrong field", () => {
    expect(lib.looksLikeOpenAIKey(KEY)).toBe(true);
    expect(lib.looksLikeOpenAIKey("sk-svcacct-abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(lib.looksLikeOpenAIKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe(false);
    expect(lib.looksLikeOpenAIKey("sk-short")).toBe(false);
    expect(lib.looksLikeOpenAIKey("sk-proj-has a space in it 0123456789")).toBe(false);
    expect(lib.looksLikeOpenAIKey("password1234567890123456")).toBe(false);
  });
});

describe("the key, in the device secret store", () => {
  it("is stored encrypted, beside the other providers' credentials and never in the config", async () => {
    await lib.setOpenAIKey(KEY);
    expect(await lib.readOpenAIKey()).toBe(KEY);
    expect(JSON.stringify(readConfig())).not.toContain(KEY);
    expect(readConfig().clawai_token).toBe("keep_me");
    expect(fs.readFileSync(path.join(root, "data", "secrets.json"), "utf8")).not.toContain(KEY);
    // A device row: outside every owner surface, so no route or MCP verb lists it.
    const secrets = await import("@/lib/project-secrets");
    expect((await secrets.listSecrets()).some((s) => s.name === "OPENAI_API_KEY")).toBe(false);
  });

  it("makes OpenAI connected by key, and its removal disconnects it", async () => {
    await lib.setOpenAIKey(KEY);
    expect(await lib.getOpenAIConnection()).toMatchObject({ connected: true, hasKey: true, source: "key", status: "connected" });
    await lib.clearOpenAIKey();
    expect(await lib.readOpenAIKey()).toBeNull();
    expect(await lib.getOpenAIConnection()).toMatchObject({ connected: false, hasKey: false, source: null, status: "disconnected" });
  });

  it("refuses what is not a key, and writes nothing", async () => {
    await expect(lib.setOpenAIKey("sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).rejects.toThrow(/OpenAI API key/);
    expect(await lib.readOpenAIKey()).toBeNull();
  });
});

describe("the ChatGPT sign-in, in the coding agent's own Codex home", () => {
  it("lives under the box's data folder, never in ~/.codex", () => {
    expect(lib.codexHome()).toBe(path.join(root, "data", "coding-agent-codex"));
    expect(lib.codexHome().startsWith(path.join(home, ".codex"))).toBe(false);
  });

  it("is read off Codex's own auth.json there", async () => {
    expect(lib.hasCodexLogin()).toBe(false);
    writeAuth({ tokens: { access_token: "a", refresh_token: "r" } });
    expect(lib.hasCodexLogin()).toBe(true);
    expect(await lib.getOpenAIConnection()).toMatchObject({ connected: true, hasLogin: true, source: "chatgpt" });
    writeAuth({ tokens: null, OPENAI_API_KEY: null });
    expect(lib.hasCodexLogin()).toBe(false);
    fs.writeFileSync(path.join(lib.codexHome(), "auth.json"), "{not json");
    expect(lib.hasCodexLogin()).toBe(false);
  });

  it("is never read from the owner's own ~/.codex", async () => {
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "a", refresh_token: "r" } }));
    expect(lib.hasCodexLogin()).toBe(false);
    expect((await lib.getOpenAIConnection()).connected).toBe(false);
  });

  it("comes second to a saved key", async () => {
    writeAuth({ tokens: { access_token: "a", refresh_token: "r" } });
    await lib.setOpenAIKey(KEY);
    expect(await lib.getOpenAIConnection()).toMatchObject({ hasKey: true, hasLogin: true, source: "key" });
  });
});

describe("limited", () => {
  it("reads limited while the limit a run met is still ahead, and connected after", async () => {
    await lib.setOpenAIKey(KEY);
    const now = Date.now();
    await lib.noteOpenAILimit(now + 60_000, now);
    expect(await lib.getOpenAIConnection(now)).toMatchObject({ status: "limited", limitedUntil: now + 60_000 });
    expect(await lib.openAILimitedUntil(now)).toBe(now + 60_000);
    expect(await lib.getOpenAIConnection(now + 61_000)).toMatchObject({ status: "connected", limitedUntil: null });
  });

  it("is never limited while nothing is connected, and a new key clears it", async () => {
    const now = Date.now();
    await lib.noteOpenAILimit(now + 60_000, now);
    expect(await lib.getOpenAIConnection(now)).toMatchObject({ status: "disconnected", limitedUntil: null });
    await lib.setOpenAIKey(KEY);
    expect(await lib.openAILimitedUntil(now)).toBeNull();
  });

  it("ignores a reset time already past", async () => {
    const now = Date.now();
    await lib.noteOpenAILimit(now - 1, now);
    expect(readConfig()[lib.OPENAI_LIMITED_UNTIL_CONFIG_KEY]).toBeUndefined();
  });
});

describe("codex login --device-auth", () => {
  it("is not started without the Codex CLI, and says how to install it", async () => {
    const spawned = vi.fn();
    lib._setCodexSpawnForTests(spawned as never);
    const login = await lib.startCodexLogin();
    expect(login.status).toBe("failed");
    expect(login.error).toMatch(/install\.sh --step codex_cli/);
    expect(spawned).not.toHaveBeenCalled();
  });

  it("runs in the coding agent's Codex home and answers OpenAI's page and the code", async () => {
    installCodexBinary();
    const child = fakeChild();
    const spawned = vi.fn(() => {
      setTimeout(() => child.stdout.write(DEVICE_OUTPUT), 10);
      return child as unknown as ChildProcess;
    });
    lib._setCodexSpawnForTests(spawned);
    const login = await lib.startCodexLogin();
    expect(login).toMatchObject({ status: "pending", verificationUrl: "https://auth.openai.com/codex/device", userCode: "AB1C-DEFGH" });
    const [bin, args, opts] = spawned.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv; detached: boolean }];
    expect(bin).toBe(path.join(home, ".local", "bin", "codex"));
    expect(args).toEqual(["login", "--device-auth"]);
    expect(opts.env.CODEX_HOME).toBe(lib.codexHome());
    expect(opts.env.NO_COLOR).toBe("1");
    expect(opts.detached).toBe(true);

    // The owner approves on OpenAI's page; Codex writes its login and exits 0.
    writeAuth({ tokens: { access_token: "a", refresh_token: "r" } });
    child.exitCode = 0;
    child.emit("exit", 0, null);
    expect(lib.readCodexLogin(login.id)).toMatchObject({ status: "approved", error: null });
    expect((await lib.getOpenAIConnection()).source).toBe("chatgpt");
  });

  it("fails, in a scrubbed sentence, when the CLI ends without a login", async () => {
    installCodexBinary();
    const child = fakeChild();
    lib._setCodexSpawnForTests(() => {
      setTimeout(() => child.stdout.write(DEVICE_OUTPUT), 10);
      return child as unknown as ChildProcess;
    });
    const login = await lib.startCodexLogin();
    child.stderr.write("Error: device code expired; token sk-proj-leakyleakyleakyleaky0000\n");
    await new Promise((r) => setTimeout(r, 10));
    child.exitCode = 1;
    child.emit("exit", 1, null);
    const after = lib.readCodexLogin(login.id)!;
    expect(after.status).toBe("failed");
    expect(after.error).not.toContain("sk-proj");
  });

  it("ends the CLI when the owner cancels, and a second start ends the first", async () => {
    installCodexBinary();
    const first = fakeChild();
    const second = fakeChild();
    const children = [first, second];
    lib._setCodexSpawnForTests(() => {
      const child = children.shift()!;
      setTimeout(() => child.stdout.write(DEVICE_OUTPUT), 10);
      return child as unknown as ChildProcess;
    });
    const a = await lib.startCodexLogin();
    const b = await lib.startCodexLogin();
    expect(first.kill).toHaveBeenCalled();
    expect(lib.readCodexLogin(a.id)).toBeNull();
    expect(lib.cancelCodexLogin(b.id)).toBe(true);
    expect(second.kill).toHaveBeenCalled();
    expect(lib.readCodexLogin(b.id)?.status).toBe("cancelled");
  });

  it("is ended by a sign-out, which also removes Codex's stored login", async () => {
    installCodexBinary();
    writeAuth({ tokens: { access_token: "a", refresh_token: "r" } });
    await lib.signOutCodex();
    expect(lib.hasCodexLogin()).toBe(false);
  });
});
