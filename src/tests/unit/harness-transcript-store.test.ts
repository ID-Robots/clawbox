import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The durable transcript — the UI's replay log, and the reason a refresh no
 * longer empties a screen the agent still remembers.
 *
 * Two things are load-bearing beyond "it stores lines", and both are here:
 *
 *  - it holds the customer's own words, so the FILE MODES matter as much as
 *    the content;
 *  - it is append-only on a device with a customer's disk to protect, so the
 *    caps have to actually bite, and the trim has to be size-triggered rather
 *    than run on every turn.
 */

let root: string;
let store: typeof import("@/lib/harness/transcript-store");

async function loadStore(): Promise<typeof import("@/lib/harness/transcript-store")> {
  vi.resetModules();
  return import("@/lib/harness/transcript-store");
}

describe("transcript store", () => {
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-transcript-"));
    process.env.CLAWBOX_ROOT = root;
    store = await loadStore();
  });

  afterEach(() => {
    delete process.env.CLAWBOX_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const dir = () => path.join(root, "data", "chat-transcripts");
  const file = () => path.join(dir(), "desktop.jsonl");

  it("keeps the conversation in the order it happened", async () => {
    await store.appendTranscript({ role: "user", text: "remember 41", timestamp: 10 });
    await store.appendTranscript({ role: "assistant", text: "Noted.", timestamp: 20 });

    expect(await store.readTranscript()).toEqual([
      { role: "user", text: "remember 41", timestamp: 10 },
      { role: "assistant", text: "Noted.", timestamp: 20 },
    ]);
  });

  it("is an empty conversation, not an error, before anything is said", async () => {
    // Every caller would otherwise have to special-case a fresh chat, and the
    // one that forgot would show an error where the greeting belongs.
    expect(await store.readTranscript()).toEqual([]);
  });

  it("carries the media refs so a replayed picture is still a picture", async () => {
    await store.appendTranscript({
      role: "assistant",
      text: "here you go",
      timestamp: 1,
      media: ["/setup-api/chat/media?path=%2Fa.png"],
      audio: ["/setup-api/chat/media?path=%2Fb.wav"],
      turnId: "run-1",
    });
    const [row] = await store.readTranscript();
    expect(row.media).toEqual(["/setup-api/chat/media?path=%2Fa.png"]);
    expect(row.audio).toEqual(["/setup-api/chat/media?path=%2Fb.wav"]);
    expect(row.turnId).toBe("run-1");
  });

  it("writes the directory and the file so only the owner can read them", async () => {
    // A transcript is the least redacted thing on the box: passwords typed at
    // the agent, names, addresses, whatever was in an attached screenshot. Same
    // posture as config.json next door.
    await store.appendTranscript({ role: "user", text: "my address is…", timestamp: 1 });
    expect(fs.statSync(dir()).mode & 0o777).toBe(store.TRANSCRIPT_LIMITS.DIR_MODE);
    expect(fs.statSync(file()).mode & 0o777).toBe(store.TRANSCRIPT_LIMITS.FILE_MODE);
  });

  it("tightens a file an older build left world-readable", async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(), "", { mode: 0o644 });
    fs.chmodSync(file(), 0o644);

    await store.appendTranscript({ role: "user", text: "hello", timestamp: 1 });

    // `appendFile`'s mode only applies when it CREATES the file, so without the
    // explicit chmod a transcript that predates this stays at whatever it had.
    expect(fs.statSync(file()).mode & 0o777).toBe(store.TRANSCRIPT_LIMITS.FILE_MODE);
  });

  it("skips a line a crash left half-written rather than losing the conversation", async () => {
    await store.appendTranscript({ role: "user", text: "first", timestamp: 1 });
    fs.appendFileSync(file(), '{"role":"assistant","text":"trunca');
    await store.appendTranscript({ role: "assistant", text: "third", timestamp: 3 });

    const rows = await store.readTranscript();
    expect(rows.map((r) => r.text)).toEqual(["first", "third"]);
  });

  it("refuses a row whose role the chat has no way to render", async () => {
    // Re-validated on the way out even though we wrote it: the file is on a
    // disk a shell can reach, and this value becomes a rendered bubble.
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(file(), [
      JSON.stringify({ role: "root", text: "not a role", timestamp: 1 }),
      JSON.stringify({ role: "assistant", text: "kept", timestamp: 2 }),
      JSON.stringify({ role: "user", timestamp: 3 }),
      "",
    ].join("\n"));

    expect((await store.readTranscript()).map((r) => r.text)).toEqual(["kept"]);
  });

  it("hands back only the tail the caller asked for", async () => {
    for (let i = 0; i < 10; i++) {
      await store.appendTranscript({ role: "user", text: `m${i}`, timestamp: i });
    }
    expect((await store.readTranscript(3)).map((r) => r.text)).toEqual(["m7", "m8", "m9"]);
  });

  it("bounds one runaway reply instead of letting it blow the whole budget", async () => {
    const huge = "x".repeat(store.TRANSCRIPT_LIMITS.MAX_TEXT_BYTES * 2);
    await store.appendTranscript({ role: "assistant", text: huge, timestamp: 1 });
    const [row] = await store.readTranscript();
    expect(row.text.length).toBe(store.TRANSCRIPT_LIMITS.MAX_TEXT_BYTES);
  });

  it("trims the oldest away once the file is over its size cap", async () => {
    // Written in chunks big enough to cross MAX_BYTES, so the trim runs for
    // real rather than being asserted against a stubbed threshold.
    const chunk = "y".repeat(60_000);
    for (let i = 0; i < 40; i++) {
      await store.appendTranscript({ role: "assistant", text: `${i}:${chunk}`, timestamp: i });
    }
    const size = fs.statSync(file()).size;
    expect(size).toBeLessThanOrEqual(store.TRANSCRIPT_LIMITS.MAX_BYTES);
    const rows = await store.readTranscript(500);
    // Newest-last: the recent conversation is what survives.
    expect(rows[rows.length - 1].text.startsWith("39:")).toBe(true);
    expect(rows[0].text.startsWith("0:")).toBe(false);
  });

  it("does not rewrite the file on an ordinary append", async () => {
    // The trim is a read-modify-rewrite of the whole conversation, which is
    // exactly the work JSONL was chosen to avoid. Run per turn it would put
    // that cost back on a Jetson for no benefit.
    const spy = vi.spyOn(fs.promises, "writeFile");
    await store.appendTranscript({ role: "user", text: "short", timestamp: 1 });
    await store.appendTranscript({ role: "assistant", text: "also short", timestamp: 2 });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("leaves nothing behind when the conversation is cleared", async () => {
    await store.appendTranscript({ role: "user", text: "private", timestamp: 1 });
    // A crash mid-trim is the one thing that could leave a second copy.
    fs.writeFileSync(`${file()}.tmp`, "leftover");

    await store.clearTranscript();

    expect(fs.existsSync(file())).toBe(false);
    expect(fs.existsSync(`${file()}.tmp`)).toBe(false);
    expect(await store.readTranscript()).toEqual([]);
  });

  it("clears idempotently, because the button is double-clickable", async () => {
    await expect(store.clearTranscript()).resolves.toBeUndefined();
    await expect(store.clearTranscript()).resolves.toBeUndefined();
  });

  it("never fails a turn over a transcript it could not write", async () => {
    // The conversation is the product; the replay log is a convenience. A
    // read-only disk must cost the user their history, not their answer.
    const spy = vi.spyOn(fs.promises, "appendFile").mockRejectedValue(new Error("EROFS"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(store.appendTranscript({ role: "user", text: "hi", timestamp: 1 })).resolves.toBe(false);
    // …and the words themselves never reach the journal.
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain("hi");
    }
    spy.mockRestore();
    warn.mockRestore();
  });

  it("sweeps a transcript nobody has touched in a month", async () => {
    await store.appendTranscript({ role: "user", text: "old", timestamp: 1 });
    const later = Date.now() + store.TRANSCRIPT_LIMITS.MAX_AGE_MS + 1;

    expect(await store.sweepTranscripts(later)).toBe(1);
    expect(fs.existsSync(file())).toBe(false);
  });

  it("leaves a recent transcript alone", async () => {
    await store.appendTranscript({ role: "user", text: "recent", timestamp: 1 });
    expect(await store.sweepTranscripts(Date.now())).toBe(0);
    expect(fs.existsSync(file())).toBe(true);
  });

  it("refuses a key that would name a file outside the store", async () => {
    // Unused while the key is a constant, and the guard the moment it is not.
    expect(store.transcriptKeyIsSafe("desktop")).toBe(true);
    expect(store.transcriptKeyIsSafe("chat-2")).toBe(true);
    expect(store.transcriptKeyIsSafe("../../.openclaw/openclaw")).toBe(false);
    expect(store.transcriptKeyIsSafe("/etc/passwd")).toBe(false);
    expect(store.transcriptKeyIsSafe("")).toBe(false);
  });

  // ── Thinking and tool steps, beside the answer ─────────────────────────

  it("keeps the monologue and the steps in their own fields, out of the text", async () => {
    await store.appendTranscript({
      role: "assistant",
      text: "Hey! What can I help you with today?",
      timestamp: 5,
      reasoning: 'The user just said "Hey". Keep it short.',
      toolCalls: [{ name: "terminal", detail: "uname -sr", status: "ok" }],
    });
    const [record] = await store.readTranscript();
    expect(record.text).toBe("Hey! What can I help you with today?");
    expect(record.reasoning).toBe('The user just said "Hey". Keep it short.');
    expect(record.toolCalls).toEqual([{ name: "terminal", detail: "uname -sr", status: "ok" }]);
    // The whole point: replay must not put the monologue back in the bubble.
    expect(record.text).not.toContain("Keep it short");
  });

  it("reads a line written BEFORE these fields existed", async () => {
    // Backward compatibility is not a nicety here — every box that has chatted
    // already has a transcript full of these lines, and they must keep
    // replaying rather than being skipped as malformed.
    const dir = path.join(root, "data", "chat-transcripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "desktop.jsonl"),
      `${JSON.stringify({ role: "assistant", text: "old reply", timestamp: 1 })}
`,
    );
    const [record] = await store.readTranscript();
    expect(record).toEqual({ role: "assistant", text: "old reply", timestamp: 1 });
  });

  it("drops a tool entry with no name rather than replaying a nameless chip", async () => {
    const dir = path.join(root, "data", "chat-transcripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "desktop.jsonl"),
      `${JSON.stringify({
        role: "assistant",
        text: "hi",
        timestamp: 1,
        toolCalls: [{ detail: "orphan" }, { name: "terminal" }, "not an object"],
      })}
`,
    );
    const [record] = await store.readTranscript();
    expect(record.toolCalls).toEqual([{ name: "terminal" }]);
  });

  it("ignores a status it does not recognise", async () => {
    await store.appendTranscript({
      role: "assistant",
      text: "hi",
      timestamp: 1,
      toolCalls: [{ name: "terminal", status: "weird" as unknown as "ok" }],
    });
    const [record] = await store.readTranscript();
    expect(record.toolCalls).toEqual([{ name: "terminal" }]);
  });

  it("clamps the monologue on its own budget, not the answer's", async () => {
    const huge = "x".repeat(store.TRANSCRIPT_LIMITS.MAX_TEXT_BYTES + 500);
    await store.appendTranscript({
      role: "assistant",
      text: "short answer",
      timestamp: 1,
      reasoning: huge,
    });
    const [record] = await store.readTranscript();
    expect(record.text).toBe("short answer");
    expect(record.reasoning?.length).toBe(store.TRANSCRIPT_LIMITS.MAX_TEXT_BYTES);
  });

  it("bounds how many steps one turn can record", async () => {
    const many = Array.from({ length: store.TRANSCRIPT_LIMITS.MAX_TOOL_CALLS + 10 }, (_, i) => ({
      name: `tool_${i}`,
    }));
    await store.appendTranscript({ role: "assistant", text: "hi", timestamp: 1, toolCalls: many });
    const [record] = await store.readTranscript();
    expect(record.toolCalls).toHaveLength(store.TRANSCRIPT_LIMITS.MAX_TOOL_CALLS);
  });

  it("lives under the data directory a factory reset wipes by default", async () => {
    // Location as a security property: the reset route erases everything under
    // DATA_DIR that is not in its keep-list, so putting transcripts here means
    // they go without anyone having to remember a rule.
    expect(store.TRANSCRIPT_DIR).toBe(path.join(root, "data", "chat-transcripts"));
  });
});
