import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";

/**
 * /setup-api/chat/tabs — the chat strip as ONE list for every browser signed in
 * to the box (TASK-1159).
 *
 * The bug: a conversation opened on the phone was missing from the desktop's
 * strip, which showed the main "ClawBox" tab alone. The sessions were on the box
 * all along; the LIST was each browser's localStorage, so nothing ever asked the
 * box which ones existed. These run the real route against a real data folder:
 * what one device writes, the other reads; a close is final for both; the owner
 * alone may write; and conversations the list never heard of — a Hermes
 * transcript, an OpenClaw session — are found on the box and listed.
 */

// vite cannot bundle the builtin; a test file is never bundled, so this is the
// same lazy route openclaw-session-store.test.ts takes to build its fixtures.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

let denied: Response | null = null;
let owner = true;
vi.mock("@/lib/route-auth", () => ({
  requireSession: vi.fn(async () => denied),
}));
vi.mock("@/lib/owner-session", () => ({
  hasOwnerSession: vi.fn(async () => owner),
}));

const PHONE_TAB = "agent:main:clawbox-0a1b2c3d4e5f";
const DESKTOP_TAB = "agent:main:clawbox-9f8e7d6c5b4a";
const HERMES_TAB = "desktop-0a1b2c3d4e5f";

let root: string;
let openclawHome: string;

async function load() {
  vi.resetModules();
  return import("@/app/setup-api/chat/tabs/route");
}

const URL_BASE = "http://clawbox.local/setup-api/chat/tabs";
const get = () => new NextRequest(URL_BASE);
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(URL_BASE, {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
  });

const inventoryFile = () => path.join(root, "data", "chat-tabs.json");
const tab = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: "Chat 2", createdAt: 1_000, autoLabel: true, seq: 2, ...extra });

function writeTranscript(key: string, lines: object[]) {
  const dir = path.join(root, "data", "chat-transcripts");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${key}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

/** An agent store shaped like OpenClaw 2026.8's, with the rows given. */
function writeAgentStore(agentId: string, rows: Record<string, object>) {
  const dir = path.join(openclawHome, "agents", agentId, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "openclaw-agent.sqlite"));
  db.exec("CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL, entry_valid INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 0)");
  const insert = db.prepare("INSERT INTO session_nodes (session_key, entry_json) VALUES (?, ?)");
  for (const [key, entry] of Object.entries(rows)) insert.run(key, JSON.stringify(entry));
  db.close();
}

async function tabsOf(res: Response) {
  expect(res.status).toBe(200);
  return ((await res.json()) as { tabs: Array<Record<string, unknown>> }).tabs;
}

describe("/setup-api/chat/tabs", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-chat-tabs-"));
    openclawHome = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-chat-tabs-oc-"));
    process.env.CLAWBOX_ROOT = root;
    process.env.CLAWBOX_OPENCLAW_HOME = openclawHome;
    denied = null;
    owner = true;
  });

  afterEach(() => {
    delete process.env.CLAWBOX_ROOT;
    delete process.env.CLAWBOX_OPENCLAW_HOME;
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(openclawHome, { recursive: true, force: true });
  });

  it("answers an empty list on a box with no tabs, and writes nothing for it", async () => {
    const route = await load();
    expect(await tabsOf(await route.GET(get()))).toEqual([]);
    expect(fs.existsSync(inventoryFile())).toBe(false);
  });

  it("hands the desktop the tab the phone opened — the bug this route exists for", async () => {
    const route = await load();
    // The phone syncs its strip: one side conversation, already named.
    const fromPhone = await tabsOf(await route.POST(post({ upsert: [tab(PHONE_TAB, { label: "Plan my week in Lisbon p…", autoLabel: false })] })));
    expect(fromPhone.map((t) => t.key)).toEqual([PHONE_TAB]);
    // A different browser, with nothing cached, asks the box.
    const onDesktop = await tabsOf(await (await load()).GET(get()));
    expect(onDesktop).toEqual([{ key: PHONE_TAB, label: "Plan my week in Lisbon p…", createdAt: 1_000, seq: 2 }]);
    // The owner's first words are in that file: 0600, like the transcripts.
    expect(fs.statSync(inventoryFile()).mode & 0o777).toBe(0o600);
  });

  it("merges two devices' strips instead of letting the later one overwrite the earlier", async () => {
    const route = await load();
    await route.POST(post({ upsert: [tab(PHONE_TAB, { createdAt: 2_000 })] }));
    // The desktop never saw the phone's tab and sends only its own.
    const merged = await tabsOf(await route.POST(post({ upsert: [tab(DESKTOP_TAB, { createdAt: 1_500 })] })));
    expect(merged.map((t) => [t.key, t.seq])).toEqual([[DESKTOP_TAB, 3], [PHONE_TAB, 2]]);
  });

  it("closes a tab for every device: a stale cache sending it again does not bring it back", async () => {
    const route = await load();
    await route.POST(post({ upsert: [tab(PHONE_TAB), tab(DESKTOP_TAB, { seq: 3 })] }));
    const afterClose = await tabsOf(await route.POST(post({ upsert: [tab(DESKTOP_TAB, { seq: 3 })], close: [PHONE_TAB] })));
    expect(afterClose.map((t) => t.key)).toEqual([DESKTOP_TAB]);
    // The phone was offline for the close and still lists the tab.
    const fromStalePhone = await tabsOf(await route.POST(post({ upsert: [tab(PHONE_TAB), tab(DESKTOP_TAB, { seq: 3 })] })));
    expect(fromStalePhone.map((t) => t.key)).toEqual([DESKTOP_TAB]);
  });

  it("keeps what is not a tab out of the file", async () => {
    const route = await load();
    const tabs = await tabsOf(await route.POST(post({
      upsert: [tab("agent:main:main"), tab("agent:main:telegram:direct:42"), tab("../../etc/passwd"), "junk", tab(PHONE_TAB)],
      close: ["agent:main:main", 7],
    })));
    expect(tabs.map((t) => t.key)).toEqual([PHONE_TAB]);
    expect(JSON.parse(fs.readFileSync(inventoryFile(), "utf8")).closed).toEqual([]);
  });

  describe("who may write", () => {
    it("refuses the agent's bearer: only the owner's own browser changes the strip", async () => {
      owner = false;
      const route = await load();
      const res = await route.POST(post({ upsert: [tab(PHONE_TAB)] }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: "owner_only" });
      expect(fs.existsSync(inventoryFile())).toBe(false);
      // Reading is the session's, as for every chat route.
      expect(await tabsOf(await route.GET(get()))).toEqual([]);
    });

    it("refuses a write from another site's page", async () => {
      const route = await load();
      const res = await route.POST(post({ upsert: [tab(PHONE_TAB)] }, { origin: "https://evil.example" }));
      expect(res.status).toBe(403);
      expect(fs.existsSync(inventoryFile())).toBe(false);
    });

    it("answers the session gate's own refusal on both methods", async () => {
      denied = NextResponse.json({ error: "Authentication required" }, { status: 401 });
      const route = await load();
      expect((await route.GET(get())).status).toBe(401);
      expect((await route.POST(post({ upsert: [tab(PHONE_TAB)] }))).status).toBe(401);
    });
  });

  describe("malformed requests", () => {
    it.each([
      ["not JSON", "{nope", 400],
      ["a list", [tab(PHONE_TAB)], 400],
      ["upsert that is not a list", { upsert: tab(PHONE_TAB) }, 400],
      ["close that is not a list", { close: PHONE_TAB }, 400],
      ["a body past the cap", JSON.stringify({ upsert: [tab(PHONE_TAB, { label: "x".repeat(70_000) })] }), 413],
    ])("refuses %s", async (_name, body, status) => {
      const route = await load();
      expect((await route.POST(post(body))).status).toBe(status);
      expect(fs.existsSync(inventoryFile())).toBe(false);
    });

    it("treats a damaged file as an empty strip and writes a whole one over it", async () => {
      fs.mkdirSync(path.join(root, "data"), { recursive: true });
      fs.writeFileSync(inventoryFile(), "{torn");
      const route = await load();
      expect(await tabsOf(await route.POST(post({ upsert: [tab(PHONE_TAB)] })))).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(inventoryFile(), "utf8")).tabs).toHaveLength(1);
    });
  });

  describe("conversations on the box that no list ever named", () => {
    it("lists a Hermes tab's transcript, named after the first thing the owner said in it", async () => {
      // A phone opened this tab before the list lived on the box, and has not
      // opened the chat since: its transcript is the only record of it.
      writeTranscript(HERMES_TAB, [
        { role: "user", text: "Plan my week in Lisbon please", timestamp: 5_000 },
        { role: "assistant", text: "Sure.", timestamp: 6_000 },
      ]);
      writeTranscript("desktop", [{ role: "user", text: "main thread", timestamp: 1 }]);
      writeTranscript("desktop-emptyfile000", []);
      const route = await load();
      expect(await tabsOf(await route.GET(get()))).toEqual([
        { key: HERMES_TAB, label: "Plan my week in Lisbon p…", createdAt: 5_000 },
      ]);
      // Adopted, so every later read is the same list without re-reading it.
      expect(JSON.parse(fs.readFileSync(inventoryFile(), "utf8")).tabs.map((t: { key: string }) => t.key)).toEqual([HERMES_TAB]);
    });

    it("lists OpenClaw's tab sessions — and only those — from each agent's store", async () => {
      writeAgentStore("main", {
        "agent:main:main": { sessionId: "s0", updatedAt: 10 },
        [PHONE_TAB]: { sessionId: "s1", updatedAt: 7_000 },
        "agent:main:telegram:direct:42": { sessionId: "s2", updatedAt: 8_000 },
        "agent:main:cron:nightly": { sessionId: "s3" },
      });
      // An agent the doctor has not migrated yet still lists its sessions in JSON.
      const legacy = path.join(openclawHome, "agents", "helper", "sessions");
      fs.mkdirSync(legacy, { recursive: true });
      fs.writeFileSync(path.join(legacy, "sessions.json"), JSON.stringify({
        "agent:helper:clawbox-00aa11bb22cc": { sessionId: "s9", updatedAt: 9_000, label: "Weekly report" },
        "agent:main:clawbox-ffffffffffff": { sessionId: "s8", updatedAt: 9_500 },
      }));
      const route = await load();
      const tabs = await tabsOf(await route.GET(get()));
      expect(tabs).toEqual([
        { key: PHONE_TAB, label: "", createdAt: 7_000, autoLabel: true, seq: 2 },
        { key: "agent:helper:clawbox-00aa11bb22cc", label: "Weekly report", createdAt: 9_000 },
      ]);
    });

    it("never lists a closed conversation again, even while its session lingers", async () => {
      writeTranscript(HERMES_TAB, [{ role: "user", text: "hello", timestamp: 5_000 }]);
      const route = await load();
      expect(await tabsOf(await route.GET(get()))).toHaveLength(1);
      // Closed — and the delete behind the close has not landed yet.
      expect(await tabsOf(await route.POST(post({ close: [HERMES_TAB] })))).toEqual([]);
      expect(await tabsOf(await route.GET(get()))).toEqual([]);
    });

    it("keeps the name a device gave a tab over one guessed from its transcript", async () => {
      writeTranscript(HERMES_TAB, [{ role: "user", text: "hello there", timestamp: 5_000 }]);
      const route = await load();
      const tabs = await tabsOf(await route.POST(post({ upsert: [tab(HERMES_TAB, { label: "Trip", autoLabel: false, createdAt: 4_000 })] })));
      expect(tabs).toEqual([{ key: HERMES_TAB, label: "Trip", createdAt: 4_000, seq: 2 }]);
    });
  });
});
