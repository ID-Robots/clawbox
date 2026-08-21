import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import fs from "fs";
import fsPromises, { type FileHandle } from "fs/promises";
import os from "os";
import path from "path";
import { loadSpokenHistory } from "@/lib/chat-spoken-history";

const SESSION_KEY = "agent:main:main";

let root: string;
let sessionsDir: string;
let transcript: string;

function line(id: string, message: Record<string, unknown>): string {
  return JSON.stringify({ type: "message", id, timestamp: new Date(Number(message.timestamp)).toISOString(), message });
}

function assistant(text: string, timestamp: number): Record<string, unknown> {
  return { role: "assistant", timestamp, content: [{ type: "text", text }] };
}

function supplement(text: string, timestamp: number, source: string, marked = true): Record<string, unknown> {
  return {
    role: "assistant",
    timestamp,
    content: [
      { type: "text", text: marked ? "Audio reply" : text },
      { type: "attachment", attachment: { url: source, kind: "audio", mimeType: "audio/wav" } },
    ],
    ...(marked ? {
      openclawTtsSupplement: {
        textSha256: createHash("sha256").update(text).digest("hex"),
        spokenText: text,
      },
    } : {}),
  };
}

function writeTranscript(messages: Record<string, unknown>[]) {
  fs.writeFileSync(transcript, messages.map((message, index) => line(String(index + 1), message)).join("\n") + "\n");
}

describe("loadSpokenHistory", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-spoken-history-"));
    sessionsDir = path.join(root, "agents", "main", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    transcript = path.join(sessionsDir, "main.jsonl");
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify({
      [SESSION_KEY]: { sessionId: "main", sessionFile: transcript },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recovers two identical replies by exact transcript occurrence", async () => {
    const first = path.join(root, "media", "outbound", "first.wav");
    const second = path.join(root, "media", "outbound", "second.wav");
    writeTranscript([
      assistant("Sure.", 100),
      supplement("Sure.", 110, first),
      assistant("Sure.", 200),
      supplement("Sure.", 210, second),
    ]);

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([
      { targetTimestamp: 100, audio: [`/setup-api/chat/media?path=${encodeURIComponent(first)}`] },
      { targetTimestamp: 200, audio: [`/setup-api/chat/media?path=${encodeURIComponent(second)}`] },
    ]);
  });

  it("supports the older repeated-text supplement shape with no marker", async () => {
    const source = path.join(root, "media", "outbound", "legacy.wav");
    writeTranscript([
      assistant("Legacy answer", 300),
      supplement("Legacy answer", 310, source, false),
    ]);

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([
      { targetTimestamp: 300, audio: [`/setup-api/chat/media?path=${encodeURIComponent(source)}`] },
    ]);
  });

  it("uses the originating run when delayed legacy audio follows a newer identical reply", async () => {
    const source = path.join(root, "media", "outbound", "delayed.wav");
    writeTranscript([
      { role: "user", timestamp: 90, idempotencyKey: "run-one:user", content: [{ type: "text", text: "First" }] },
      assistant("Sure.", 100),
      { role: "user", timestamp: 150, idempotencyKey: "run-two:user", content: [{ type: "text", text: "Again" }] },
      assistant("Sure.", 200),
      {
        ...supplement("Sure.", 210, source, false),
        idempotencyKey: "run-one:assistant-media",
      },
    ]);

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([
      { targetTimestamp: 100, audio: [`/setup-api/chat/media?path=${encodeURIComponent(source)}`] },
    ]);
  });

  it("falls back to the nearest target when a hash covers projected display text", async () => {
    const source = path.join(root, "media", "outbound", "tagged.mp3");
    const visible = "Tagged reply";
    writeTranscript([
      assistant(`[[reply_to_current]] ${visible}`, 350),
      {
        role: "assistant",
        timestamp: 360,
        content: [
          { type: "text", text: "Audio reply" },
          { type: "attachment", attachment: { url: source, kind: "audio", mimeType: "audio/mpeg" } },
        ],
        openclawTtsSupplement: {
          textSha256: createHash("sha256").update(visible).digest("hex"),
        },
      },
    ]);

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([
      { targetTimestamp: 350, audio: [`/setup-api/chat/media?path=${encodeURIComponent(source)}`] },
    ]);
  });

  it("returns only bounded on-box media URLs from the transcript", async () => {
    const local = path.join(root, "media", "outbound", "local.wav");
    writeTranscript([
      assistant("Safe", 370),
      {
        role: "assistant",
        timestamp: 380,
        content: [
          { type: "text", text: "Audio reply" },
          { type: "attachment", attachment: { url: "https://tracker.invalid/remote.mp3", kind: "audio" } },
          { type: "attachment", attachment: { url: "data:audio/wav;base64,AAAA", kind: "audio" } },
          { type: "attachment", attachment: { url: local, kind: "audio", mimeType: "audio/wav" } },
        ],
        openclawTtsSupplement: {
          textSha256: createHash("sha256").update("Safe").digest("hex"),
        },
      },
    ]);

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([
      { targetTimestamp: 370, audio: [`/setup-api/chat/media?path=${encodeURIComponent(local)}`] },
    ]);
  });

  it("caps audio merged from repeated supplements for one reply", async () => {
    const sources = Array.from({ length: 6 }, (_, index) =>
      path.join(root, "media", "outbound", `part-${index}.wav`));
    const markedSupplement = (timestamp: number, selected: string[]) => ({
      role: "assistant",
      timestamp,
      content: [
        { type: "text", text: "Audio reply" },
        ...selected.map((source) => ({
          type: "attachment",
          attachment: { url: source, kind: "audio", mimeType: "audio/wav" },
        })),
      ],
      openclawTtsSupplement: {
        textSha256: createHash("sha256").update("Bounded").digest("hex"),
        spokenText: "Bounded",
      },
    });
    writeTranscript([
      assistant("Bounded", 380),
      markedSupplement(381, sources.slice(0, 2)),
      markedSupplement(382, sources.slice(2, 4)),
      markedSupplement(383, sources.slice(4, 6)),
    ]);

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([{
      targetTimestamp: 380,
      audio: sources.slice(0, 4).map((source) =>
        `/setup-api/chat/media?path=${encodeURIComponent(source)}`),
    }]);
  });

  it("drops a truncated leading record from a bounded transcript tail", async () => {
    const oldSource = path.join(root, "media", "outbound", "old.wav");
    const source = path.join(root, "media", "outbound", "tail.wav");
    const excluded = [
      line("1", assistant("Old answer", 380)),
      line("2", supplement("Old answer", 381, oldSource)),
      line("3", assistant("x".repeat(4096), 384)),
    ].join("\n");
    const completeTail = [
      line("4", assistant("Tail answer", 385)),
      line("5", supplement("Tail answer", 386, source)),
    ].join("\n") + "\n";
    fs.writeFileSync(transcript, `${excluded}\n${completeTail}`);

    expect(await loadSpokenHistory(SESSION_KEY, {
      openclawHome: root,
      maxTailBytes: Buffer.byteLength(completeTail) + 32,
    })).toEqual([{
      targetTimestamp: 385,
      audio: [`/setup-api/chat/media?path=${encodeURIComponent(source)}`],
    }]);
  });

  it("continues reading until the bounded tail is complete after short reads", async () => {
    const source = path.join(root, "media", "outbound", "short-read.wav");
    writeTranscript([
      assistant("Short read", 387),
      supplement("Short read", 388, source),
    ]);
    const originalOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (path.resolve(String(args[0])) === path.resolve(transcript)) {
        const originalRead = handle.read.bind(handle);
        handle.read = ((buffer: Uint8Array, offset: number, length: number, position: number) =>
          originalRead(buffer, offset, Math.min(length, 7), position)) as FileHandle["read"];
      }
      return handle;
    });

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([{
      targetTimestamp: 387,
      audio: [`/setup-api/chat/media?path=${encodeURIComponent(source)}`],
    }]);
  });

  it("returns an empty history when the sessions index is not present yet", async () => {
    fs.rmSync(path.join(sessionsDir, "sessions.json"));
    await expect(loadSpokenHistory(SESSION_KEY, { openclawHome: root })).resolves.toEqual([]);
  });

  it("returns an empty history when the indexed transcript was rotated away", async () => {
    fs.rmSync(transcript, { force: true });
    await expect(loadSpokenHistory(SESSION_KEY, { openclawHome: root })).resolves.toEqual([]);
  });

  it("still surfaces a corrupt sessions index instead of treating it as missing", async () => {
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), "{not-json");
    await expect(loadSpokenHistory(SESSION_KEY, { openclawHome: root })).rejects.toBeInstanceOf(SyntaxError);
  });

  it("returns cloned cached results and invalidates them when the transcript grows", async () => {
    const firstSource = path.join(root, "media", "outbound", "cached-one.wav");
    const secondSource = path.join(root, "media", "outbound", "cached-two.wav");
    writeTranscript([
      assistant("Cached", 389),
      supplement("Cached", 390, firstSource),
    ]);

    const first = await loadSpokenHistory(SESSION_KEY, { openclawHome: root });
    first[0].audio[0] = "mutated by caller";
    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([{
      targetTimestamp: 389,
      audio: [`/setup-api/chat/media?path=${encodeURIComponent(firstSource)}`],
    }]);

    writeTranscript([
      assistant("Cached", 389),
      supplement("Cached", 390, firstSource),
      assistant("New cached", 391),
      supplement("New cached", 392, secondSource),
    ]);
    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toHaveLength(2);
  });

  it("supports a realistic sessions index larger than the old four-megabyte ceiling", async () => {
    const source = path.join(root, "media", "outbound", "indexed.wav");
    writeTranscript([
      assistant("Indexed", 390),
      supplement("Indexed", 400, source),
    ]);
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify({
      padding: "x".repeat(4 * 1024 * 1024),
      [SESSION_KEY]: { sessionId: "main", sessionFile: transcript },
    }));

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([
      { targetTimestamp: 390, audio: [`/setup-api/chat/media?path=${encodeURIComponent(source)}`] },
    ]);
  });

  it("accepts the logical transcript path when OPENCLAW_HOME is a symlink", async () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-spoken-real-"));
    const logicalRoot = path.join(root, "linked-home");
    const realSessions = path.join(realRoot, "agents", "main", "sessions");
    fs.mkdirSync(realSessions, { recursive: true });
    fs.symlinkSync(realRoot, logicalRoot);
    const logicalTranscript = path.join(logicalRoot, "agents", "main", "sessions", "linked.jsonl");
    const realTranscript = path.join(realSessions, "linked.jsonl");
    const source = path.join(logicalRoot, "media", "outbound", "linked.wav");
    fs.writeFileSync(realTranscript, [
      line("1", assistant("Linked", 400)),
      line("2", supplement("Linked", 410, source)),
    ].join("\n") + "\n");
    fs.writeFileSync(path.join(realSessions, "sessions.json"), JSON.stringify({
      [SESSION_KEY]: { sessionFile: logicalTranscript },
    }));

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: logicalRoot })).toEqual([
      { targetTimestamp: 400, audio: [`/setup-api/chat/media?path=${encodeURIComponent(source)}`] },
    ]);
    fs.rmSync(realRoot, { recursive: true, force: true });
  });

  it("refuses a sessions index that points outside its own session directory", async () => {
    const outside = path.join(root, "outside.jsonl");
    fs.writeFileSync(outside, line("1", assistant("secret", 500)) + "\n");
    fs.writeFileSync(path.join(sessionsDir, "sessions.json"), JSON.stringify({
      [SESSION_KEY]: { sessionFile: outside },
    }));

    expect(await loadSpokenHistory(SESSION_KEY, { openclawHome: root })).toEqual([]);
  });
});
