import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { HermesAdapter, type HermesTurnContext } from "@/lib/harness/hermes-adapter";
import { capabilitiesFor, UNKNOWN_FACTS } from "@/lib/harness/capabilities";

/**
 * A reload must not split the conversation from the agent.
 *
 * The screen comes back from the durable transcript, but the Hermes session
 * behind it lived only in the adapter's memory: a reload (F5, kiosk restart,
 * update, reboot) redrew the old messages and the next one opened a fresh
 * session that knew none of them. The transcript now records the session each
 * reply ran on, the history route hands the newest back, and `loadHistory`
 * resumes it.
 */

vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => "hermes" }));

const caps = capabilitiesFor("hermes", { ...UNKNOWN_FACTS, hasClawaiToken: true });
const ctx: HermesTurnContext = { devicePairing: { provider: "clawai", model: "deepseek" }, modelsReady: true, sessionKey: "desktop" };
const SESSION = "20260823_190319_3e9e35";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-reload-session-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A page whose GETs go to the real history route over the real store. */
async function page(posts: Array<Record<string, unknown>>) {
  const { GET } = await import("@/app/setup-api/chat/history/route");
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET") {
      return GET(new NextRequest(new URL(String(url), "http://localhost")));
    }
    posts.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return { ok: true, status: 200, json: async () => ({ text: "ok", harness: "hermes", sessionId: SESSION }) } as unknown as Response;
  });
  return new HermesAdapter(caps, () => ctx, fetchImpl as unknown as typeof fetch);
}

describe("a reloaded Hermes chat", () => {
  it("continues the conversation it shows", async () => {
    const { appendTranscript } = await import("@/lib/harness/transcript-store");
    // What the chat route records for turn 1 of the conversation on screen.
    await appendTranscript({ role: "user", text: "remember the number 42", timestamp: 1 });
    await appendTranscript({ role: "assistant", text: "Noted.", timestamp: 2, sessionId: SESSION });

    // A reload builds a new adapter (use-harness-adapter.ts) and redraws the transcript.
    const posts: Array<Record<string, unknown>> = [];
    const reloaded = await page(posts);
    const history = await reloaded.loadHistory({ limit: 50 });
    expect(history.messages.map((m) => m.text)).toEqual(["remember the number 42", "Noted."]);
    await reloaded.sendTurn({ text: "which number?", attachments: [], idempotencyKey: "t2" });
    expect(posts[0]?.sessionId).toBe(SESSION);
  });

  it("resumes the newest session the transcript recorded", async () => {
    const { appendTranscript } = await import("@/lib/harness/transcript-store");
    await appendTranscript({ role: "assistant", text: "old", timestamp: 1, sessionId: "20260101_000000_aaaaaa" });
    await appendTranscript({ role: "assistant", text: "new", timestamp: 2, sessionId: SESSION });
    await appendTranscript({ role: "system", text: "Error: x", timestamp: 3, variant: "error" });
    const { GET } = await import("@/app/setup-api/chat/history/route");
    const body = await (await GET(new NextRequest("http://localhost/setup-api/chat/history"))).json();
    expect(body.sessionId).toBe(SESSION);
    // The id rides beside the messages, not inside them.
    expect(body.messages.some((m: Record<string, unknown>) => "sessionId" in m)).toBe(false);
  });

  it("starts fresh after New chat, even across a reload", async () => {
    const { appendTranscript } = await import("@/lib/harness/transcript-store");
    await appendTranscript({ role: "assistant", text: "Noted.", timestamp: 2, sessionId: SESSION });
    const { DELETE } = await import("@/app/setup-api/chat/history/route");
    await DELETE(new NextRequest("http://localhost/setup-api/chat/history", { method: "DELETE" }));

    const posts: Array<Record<string, unknown>> = [];
    const reloaded = await page(posts);
    await reloaded.loadHistory({ limit: 50 });
    await reloaded.sendTurn({ text: "hello", attachments: [], idempotencyKey: "t1" });
    expect(posts[0]).not.toHaveProperty("sessionId");
  });
});
