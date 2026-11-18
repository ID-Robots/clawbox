import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/preferences on an organisation box (src/lib/org-mode.ts,
 * src/lib/user-preferences.ts): a member of staff's desktop saves its icon
 * grid, its app list and its wallpaper for THEM — never over the owner's — and
 * reads the box's preferences with their own on top. The owner, the agent's
 * bearer and every user on a home box read and write the box's, as before.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn(async (): Promise<{ username: string; isOwner: boolean } | null> => null),
  person: vi.fn(async () => true),
}));

vi.mock("@/lib/route-auth", () => ({
  requireSession: vi.fn(async () => null),
  sessionIdentity: h.who,
}));
vi.mock("@/lib/owner-session", () => ({ hasPersonSession: h.person }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/language-persona", () => ({
  DEFERRED_LANGUAGE_KEY: "ui_language_persona_pending",
  personaFilesFor: vi.fn(() => []),
  personaWritesAllowed: vi.fn(async () => false),
  writeLanguagePersona: vi.fn(async () => undefined),
}));

let root: string;
let restoreEnv: () => void;
let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

const storePath = () => path.join(root, "data", "config.json");
const store = (): Record<string, unknown> => JSON.parse(fs.readFileSync(storePath(), "utf-8"));
const writeStore = (value: Record<string, unknown>) => fs.writeFileSync(storePath(), JSON.stringify(value));
const as = (who: Who) => h.who.mockResolvedValue(who);
const read = async (query: string) => (await GET(new Request(`http://box.local/setup-api/preferences?${query}`))).json();
const write = (body: unknown) => POST(new Request("http://box.local/setup-api/preferences", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
}));

const ALICE = { username: "alice", isOwner: false };
const OWNER = { username: "clawbox", isOwner: true };

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-prefs-org-"));
  process.env.CLAWBOX_ROOT = root;
  ({ GET, POST } = await import("@/app/setup-api/preferences/route"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  writeStore({ org_mode: true, "pref:wp_id": "aurora", "pref:icon_grid": { files: [0, 0] }, "pref:desktop_apps": ["clawbox", "files", "terminal"] });
  as(ALICE);
  h.person.mockResolvedValue(true);
});

describe("a member of staff on an organisation box", () => {
  it("saves their desktop for themselves and leaves the owner's untouched", async () => {
    const res = await write({ wp_id: "dunes", icon_grid: { files: [1, 2] }, desktop_apps: ["clawbox", "files", "settings"] });
    expect(res.status).toBe(200);
    const after = store();
    expect(after["pref:wp_id"]).toBe("aurora");
    expect(after["pref:icon_grid"]).toEqual({ files: [0, 0] });
    expect(after["pref:desktop_apps"]).toEqual(["clawbox", "files", "terminal"]);
    expect(after.prefs_by_user).toEqual({ alice: { wp_id: "dunes", icon_grid: { files: [1, 2] }, desktop_apps: ["clawbox", "files", "settings"] } });
  });

  it("reads the box's preferences with their own on top", async () => {
    await write({ wp_id: "dunes" });
    expect(await read("keys=wp_id,desktop_apps")).toEqual({ wp_id: "dunes", desktop_apps: ["clawbox", "files", "terminal"] });
    expect(await read("all=1")).toMatchObject({ wp_id: "dunes", icon_grid: { files: [0, 0] } });
  });

  it("is never served to the owner, another user or the agent's bearer", async () => {
    await write({ wp_id: "dunes" });
    as(OWNER);
    expect((await read("keys=wp_id")).wp_id).toBe("aurora");
    as({ username: "bob", isOwner: false });
    expect((await read("keys=wp_id")).wp_id).toBe("aurora");
    as(null);
    expect((await read("all=1")).wp_id).toBe("aurora");
  });

  it("keeps their language their own too, out of the persona and the box default", async () => {
    await write({ ui_language: "bg", wp_id: "dunes" });
    const after = store();
    expect(after["pref:ui_language"]).toBeUndefined();
    expect(after.ui_language_by_user).toEqual({ alice: "bg" });
    expect((after.prefs_by_user as Record<string, Record<string, unknown>>).alice.ui_language).toBeUndefined();
    expect((await read("keys=ui_language")).ui_language).toBe("bg");
  });

  it("may not change the installed apps", async () => {
    const res = await write({ installed_apps: ["x"] });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "owner_only" });
    expect(store()["pref:installed_apps"]).toBeUndefined();
  });

  it("is still held to the preference rules", async () => {
    expect((await write({ "wp_<script>": 1 })).status).toBe(400);
    expect(store().prefs_by_user).toBeUndefined();
  });
});

describe("the owner, and every user on a home box", () => {
  it("the owner on an organisation box writes the box's preferences, as ever", async () => {
    as(OWNER);
    await write({ wp_id: "dunes" });
    expect(store()["pref:wp_id"]).toBe("dunes");
    expect(store().prefs_by_user).toBeUndefined();
  });

  it("a user on a home box writes the box's preferences, as ever", async () => {
    writeStore({ "pref:wp_id": "aurora" });
    await write({ wp_id: "dunes" });
    expect(store()["pref:wp_id"]).toBe("dunes");
    expect(store().prefs_by_user).toBeUndefined();
  });

  it("a member's saved preferences are not served once the box is a home box again", async () => {
    await write({ wp_id: "dunes" });
    writeStore({ ...store(), org_mode: false });
    expect((await read("keys=wp_id")).wp_id).toBe("aurora");
  });
});

describe("removing the user", () => {
  it("forgets their preferences", async () => {
    await write({ wp_id: "dunes" });
    const { forgetUserPreferences } = await import("@/lib/user-preferences");
    await forgetUserPreferences("alice");
    expect(store().prefs_by_user).toBeUndefined();
  });
});
