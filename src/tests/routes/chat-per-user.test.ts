import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";

// Every ClawBox user has their own chat: the Hermes transcript a route reads
// and writes, the spoken-reply repair and the Hermes session a turn resumes
// are the CALLER's — the owner's for the owner, theirs for anyone else, and
// never someone else's whatever the request names.

const who = vi.hoisted(() => ({ person: null as { username: string; isOwner: boolean } | null }));
vi.mock("@/lib/owner-session", () => ({ personSession: vi.fn(async () => who.person) }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: async () => "hermes" }));
const spoken = vi.hoisted(() => ({ loadSpokenHistory: vi.fn(async () => []) }));
vi.mock("@/lib/chat-spoken-history", () => spoken);

const OWNER = { username: "clawbox", isOwner: true };
const ALICE = { username: "alice", isOwner: false };
let root: string;

function writeTranscript(key: string, text: string) {
  const dir = path.join(root, "data", "chat-transcripts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.jsonl`), `${JSON.stringify({ role: "user", text, timestamp: 10 })}\n`);
}

const history = (sessionKey?: string, method = "GET") => {
  const url = new URL("http://localhost/setup-api/chat/history");
  if (sessionKey !== undefined) url.searchParams.set("sessionKey", sessionKey);
  return new NextRequest(url, { method });
};

beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-chat-per-user-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.CLAWBOX_USER = "clawbox";
  who.person = null;
  writeTranscript("desktop", "the owner's secret plans");
  writeTranscript("desktop-user-alice", "alice's own question");
});

afterEach(() => {
  delete process.env.CLAWBOX_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("/setup-api/chat/history per person", () => {
  it("opens a user on their own main thread when they name none — never the owner's", async () => {
    who.person = ALICE;
    const { GET } = await import("@/app/setup-api/chat/history/route");
    const body = await (await GET(history())).json();
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(["alice's own question"]);
  });

  it("refuses a user the owner's transcript, and another user's, by name", async () => {
    who.person = ALICE;
    writeTranscript("desktop-user-bob", "bob's thoughts");
    const { GET, DELETE } = await import("@/app/setup-api/chat/history/route");
    for (const key of ["desktop", "desktop-0123456789ab", "desktop-user-bob"]) {
      const res = await GET(history(key));
      expect(res.status, key).toBe(403);
      expect(await res.json(), key).toMatchObject({ code: "not_your_chat" });
    }
    // …and cannot clear it either.
    expect((await DELETE(history("desktop", "DELETE"))).status).toBe(403);
    expect(fs.existsSync(path.join(root, "data", "chat-transcripts", "desktop.jsonl"))).toBe(true);
  });

  it("keeps the owner on their own thread, and off a user's", async () => {
    who.person = OWNER;
    const { GET } = await import("@/app/setup-api/chat/history/route");
    const body = await (await GET(history())).json();
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(["the owner's secret plans"]);
    expect((await GET(history("desktop-user-alice"))).status).toBe(403);
  });

  it("answers the agent's bearer (no person) with the owner's thread, as before there were users", async () => {
    who.person = null;
    const { GET } = await import("@/app/setup-api/chat/history/route");
    const body = await (await GET(history())).json();
    expect(body.messages.map((m: { text: string }) => m.text)).toEqual(["the owner's secret plans"]);
  });
});

describe("/setup-api/chat/spoken-history per person", () => {
  it("reads the caller's own main session", async () => {
    who.person = ALICE;
    const { GET } = await import("@/app/setup-api/chat/spoken-history/route");
    await GET(new Request("http://localhost/setup-api/chat/spoken-history"));
    expect(spoken.loadSpokenHistory).toHaveBeenLastCalledWith("agent:main:clawbox-user-alice");
    who.person = OWNER;
    await GET(new Request("http://localhost/setup-api/chat/spoken-history"));
    expect(spoken.loadSpokenHistory).toHaveBeenLastCalledWith("agent:main:main");
  });
});

describe("which Hermes session a turn may resume", () => {
  it("lets a user resume only a session their own chat opened, and keeps the owner's from them", async () => {
    const scope = await import("@/lib/chat-scope-server");
    const ownersSession = "20261016_101500_a1b2c3";
    const alicesSession = "20261016_101600_d4e5f6";
    // An id the box never recorded is the owner's (every session from before users).
    expect(scope.hermesSessionFor(ALICE, ownersSession)).toBe("");
    expect(scope.hermesSessionFor(OWNER, ownersSession)).toBe(ownersSession);

    scope.noteHermesSession(alicesSession, "desktop-user-alice");
    expect(scope.hermesSessionFor(ALICE, alicesSession)).toBe(alicesSession);
    expect(scope.hermesSessionFor({ username: "bob", isOwner: false }, alicesSession)).toBe("");
    expect(scope.hermesSessionFor(OWNER, alicesSession)).toBe("");

    scope.forgetHermesSessionsOf("alice");
    expect(scope.hermesSessionFor(ALICE, alicesSession)).toBe("");
  });

  it("records a session a gateway-routed `hermes chat` opened (v0.22.4: `local-` + 64 hex)", async () => {
    const scope = await import("@/lib/chat-scope-server");
    const alicesSession = `local-${"a1b2c3d4".repeat(8)}`;
    scope.noteHermesSession(alicesSession, "desktop-user-alice");
    expect(scope.hermesSessionFor(ALICE, alicesSession)).toBe(alicesSession);
    expect(scope.hermesSessionFor({ username: "bob", isOwner: false }, alicesSession)).toBe("");
    expect(scope.hermesSessionFor(OWNER, alicesSession)).toBe("");
    scope.forgetHermesSessionsOf("alice");
  });

  it("names the caller's own transcript, and refuses someone else's or an unsafe one", async () => {
    const scope = await import("@/lib/chat-scope-server");
    const req = new Request("http://localhost/");
    who.person = ALICE;
    expect(await scope.transcriptKeyFor(req, undefined)).toMatchObject({ ok: true, key: "desktop-user-alice" });
    expect(await scope.transcriptKeyFor(req, "desktop-utab-0123456789ab-alice")).toMatchObject({ ok: true });
    expect(await scope.transcriptKeyFor(req, "desktop")).toMatchObject({ ok: false, status: 403, code: "not_your_chat" });
    expect(await scope.transcriptKeyFor(req, "../../openclaw.json")).toMatchObject({ ok: false, status: 400 });
    who.person = OWNER;
    expect(await scope.transcriptKeyFor(req, undefined)).toMatchObject({ ok: true, key: "desktop" });
  });
});
