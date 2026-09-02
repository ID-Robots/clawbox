import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * The transcript route: what the chat replays after a refresh, and the half of
 * "new chat" that makes forgetting reach the disk.
 *
 * The gate under test is the one that keeps this from becoming a lie on the
 * other edition. OpenClaw HAS a transcript — the gateway holds it — so a GET
 * here from an OpenClaw box is a caller asking the wrong store, and it is told
 * so rather than handed an empty list it would paint over a conversation that
 * plainly exists.
 */

let harness: "openclaw" | "hermes" = "hermes";
let root: string;

vi.mock("@/lib/harness", () => ({
  getActiveHarness: async () => harness,
}));

async function load() {
  vi.resetModules();
  return import("@/app/setup-api/chat/history/route");
}

const request = (limit?: string, sessionKey?: string) => {
  const url = new URL("http://localhost/setup-api/chat/history");
  if (limit !== undefined) url.searchParams.set("limit", limit);
  if (sessionKey !== undefined) url.searchParams.set("sessionKey", sessionKey);
  return new NextRequest(url);
};

describe("/setup-api/chat/history", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-history-"));
    process.env.CLAWBOX_ROOT = root;
    harness = "hermes";
  });

  afterEach(() => {
    delete process.env.CLAWBOX_ROOT;
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeTranscript(lines: object[], key = "desktop") {
    const dir = path.join(root, "data", "chat-transcripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${key}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
  }

  it("replays the conversation oldest first", async () => {
    writeTranscript([
      { role: "user", text: "remember 41", timestamp: 10 },
      { role: "assistant", text: "Noted.", timestamp: 20 },
    ]);
    const { GET } = await load();
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toEqual([
      { role: "user", text: "remember 41", timestamp: 10 },
      { role: "assistant", text: "Noted.", timestamp: 20 },
    ]);
  });

  it("hands media back under the names the chat surface renders", async () => {
    // The store calls them `media`/`turnId`; the bubble reads `images` and
    // `idempotencyKey`. Translating here rather than at four call sites is the
    // whole reason this route exists between the two.
    writeTranscript([
      {
        role: "assistant",
        text: "here you go",
        timestamp: 1,
        media: ["/setup-api/chat/media?path=%2Fa.png"],
        audio: ["/setup-api/chat/media?path=%2Fb.wav"],
        turnId: "run-1",
      },
    ]);
    const { GET } = await load();
    const [row] = (await (await GET(request())).json()).messages;
    expect(row.images).toEqual(["/setup-api/chat/media?path=%2Fa.png"]);
    expect(row.audio).toEqual(["/setup-api/chat/media?path=%2Fb.wav"]);
    expect(row.idempotencyKey).toBe("run-1");
  });

  it("hands back which model and provider served a reply", async () => {
    // HERMES-05: the store had carried these since the switch fix, and this
    // route dropped them on the floor — so the bubble could never show them.
    writeTranscript([
      { role: "assistant", text: "Hi.", timestamp: 1, model: "deepseek-v4-flash", provider: "clawai" },
      { role: "assistant", text: "Older.", timestamp: 2 },
    ]);
    const { GET } = await load();
    const [served, older] = (await (await GET(request())).json()).messages;
    expect(served).toMatchObject({ model: "deepseek-v4-flash", provider: "clawai" });
    expect(older).not.toHaveProperty("model");
    expect(older).not.toHaveProperty("provider");
  });

  it("is an empty conversation, not an error, on a box that has said nothing", async () => {
    const { GET } = await load();
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).messages).toEqual([]);
  });

  it("honours a limit, and defaults rather than 400s on a nonsensical one", async () => {
    writeTranscript(
      Array.from({ length: 5 }, (_, i) => ({ role: "user", text: `m${i}`, timestamp: i })),
    );
    const { GET } = await load();
    const two = (await (await GET(request("2"))).json()).messages;
    expect(two.map((m: { text: string }) => m.text)).toEqual(["m3", "m4"]);
    // The caller asked for the conversation and there is a right answer to give
    // them; refusing over a bad query string would empty the screen instead.
    const junk = (await (await GET(request("banana"))).json()).messages;
    expect(junk).toHaveLength(5);
  });

  it("clears the transcript on DELETE", async () => {
    writeTranscript([{ role: "user", text: "private", timestamp: 1 }]);
    const { DELETE, GET } = await load();
    expect((await DELETE(request())).status).toBe(200);
    expect((await (await GET(request())).json()).messages).toEqual([]);
  });

  it("keeps each conversation's transcript apart, by session key", async () => {
    // A tab beside the desktop thread is its own file. Closing the tab deletes
    // THAT file and leaves the desktop's alone — the (+) on the Hermes edition
    // used to delete the one transcript there was.
    const tab = "desktop-0123456789ab";
    writeTranscript([{ role: "user", text: "main thread", timestamp: 1 }]);
    writeTranscript([{ role: "user", text: "in the tab", timestamp: 2 }], tab);
    const { GET, DELETE } = await load();
    expect((await (await GET(request(undefined, tab))).json()).messages).toEqual([
      { role: "user", text: "in the tab", timestamp: 2 },
    ]);
    expect((await DELETE(request(undefined, tab))).status).toBe(200);
    expect((await (await GET(request(undefined, tab))).json()).messages).toEqual([]);
    expect((await (await GET(request())).json()).messages).toEqual([
      { role: "user", text: "main thread", timestamp: 1 },
    ]);
  });

  it("refuses a key that is not a bare filename, before it can become one", async () => {
    const { GET, DELETE } = await load();
    expect((await GET(request(undefined, "../openclaw"))).status).toBe(400);
    expect((await DELETE(request(undefined, "../openclaw"))).status).toBe(400);
  });

  it("tells an OpenClaw box it is asking the wrong store", async () => {
    // Not an empty 200: that renders as "no history" over a conversation the
    // gateway is still holding.
    harness = "openclaw";
    const { GET, DELETE } = await load();
    const res = await GET(request());
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/gateway/i);
    expect((await DELETE(request())).status).toBe(409);
  });

  it("does not delete an OpenClaw box's transcript through the wrong door", async () => {
    // The gate is on the WRITE too. A DELETE that fell through would be a
    // no-op today, and a data-loss bug the moment this store gains a second
    // writer.
    writeTranscript([{ role: "user", text: "still here", timestamp: 1 }]);
    harness = "openclaw";
    const { DELETE } = await load();
    await DELETE(request());
    harness = "hermes";
    const { GET } = await load();
    expect((await (await GET(request())).json()).messages).toHaveLength(1);
  });
});
