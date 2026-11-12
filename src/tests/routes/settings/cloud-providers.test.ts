import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/settings/cloud-providers — the owner's "Hide cloud AI providers"
 * switch (src/lib/cloud-providers.ts). Pinned: off on a normal box, on by
 * itself on an organisation box whose AI is an external engine, the owner's
 * own choice wins either way, and only the owner's own browser reads or moves it.
 */

type Who = { username: string; isOwner: boolean } | null;

const h = vi.hoisted(() => ({
  who: vi.fn(async (): Promise<{ username: string; isOwner: boolean } | null> => ({ username: "clawbox", isOwner: true })),
  sameOrigin: vi.fn(() => true),
}));

vi.mock("@/lib/owner-session", () => ({ personSession: h.who }));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));

let root: string;
let restoreEnv: () => void;
let GET: (req: Request) => Promise<Response>;
let POST: (req: Request) => Promise<Response>;

const ENGINE = {
  baseUrl: "http://127.0.0.1:18931/v1",
  modelId: "acme/echo-1",
  contextWindow: 131072,
  maxTokens: 4096,
  imageInput: false,
  harness: "openclaw",
  savedAt: "2026-11-12T00:00:00.000Z",
  previous: { store: {} },
};

const storePath = () => path.join(root, "data", "config.json");
const URL_ = "http://box.local/setup-api/settings/cloud-providers";
const get = () => GET(new Request(URL_));
const post = (body: unknown, raw?: string) =>
  POST(new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ?? JSON.stringify(body),
  }));
const writeStore = (state: Record<string, unknown>) => fs.writeFileSync(storePath(), JSON.stringify(state));
const stored = () => JSON.parse(fs.readFileSync(storePath(), "utf-8")).hide_cloud_providers;
const as = (who: Who) => h.who.mockResolvedValue(who);

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-cloud-providers-route-"));
  process.env.CLAWBOX_ROOT = root;
  ({ GET, POST } = await import("@/app/setup-api/settings/cloud-providers/route"));
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.rmSync(storePath(), { force: true });
  as({ username: "clawbox", isOwner: true });
  h.sameOrigin.mockReturnValue(true);
});

describe("GET", () => {
  it("a normal box hides nothing and leads with no local choice", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      canChange: true,
      hidden: false,
      setting: "auto",
      autoHidden: false,
      orgMode: false,
      localOnly: false,
      externalEngine: null,
      localModel: null,
    });
  });

  it("an external engine alone names the engine but hides nothing", async () => {
    writeStore({ external_engine: ENGINE, local_ai_model: "clawext/acme/echo-1" });
    const body = await (await get()).json();
    expect(body).toMatchObject({
      hidden: false,
      setting: "auto",
      externalEngine: { displayName: "echo-1", modelRef: "clawext/acme/echo-1" },
      localModel: "clawext/acme/echo-1",
    });
  });

  it("an organisation box whose AI is an external engine hides the cloud by itself", async () => {
    writeStore({ org_mode: true, external_engine: ENGINE });
    expect(await (await get()).json()).toMatchObject({ hidden: true, setting: "auto", autoHidden: true, orgMode: true });
  });

  it("organisation mode without an engine hides nothing", async () => {
    writeStore({ org_mode: true });
    expect(await (await get()).json()).toMatchObject({ hidden: false, autoHidden: false });
  });

  it("an engine record ClawBox did not write is no engine", async () => {
    writeStore({ org_mode: true, external_engine: { baseUrl: "not a url", modelId: "" } });
    expect(await (await get()).json()).toMatchObject({ hidden: false, externalEngine: null });
  });

  it("reports Local-only mode", async () => {
    writeStore({ local_only_mode: true, local_ai_model: "llamacpp/gemma" });
    expect(await (await get()).json()).toMatchObject({ hidden: false, localOnly: true, localModel: "llamacpp/gemma" });
  });

  it("the owner's choice wins over AUTO both ways", async () => {
    writeStore({ org_mode: true, external_engine: ENGINE, hide_cloud_providers: false });
    expect(await (await get()).json()).toMatchObject({ hidden: false, setting: "off", autoHidden: true });
    writeStore({ hide_cloud_providers: true });
    expect(await (await get()).json()).toMatchObject({ hidden: true, setting: "on", autoHidden: false });
  });

  it("a hand-edited value is AUTO", async () => {
    writeStore({ hide_cloud_providers: "yes" });
    expect(await (await get()).json()).toMatchObject({ hidden: false, setting: "auto" });
  });

  it("the owner may change it", async () => {
    expect((await (await get()).json()).canChange).toBe(true);
  });

  it("another user signed in on a home box reads it as the owner set it, and may not change it", async () => {
    writeStore({ hide_cloud_providers: true });
    as({ username: "alice", isOwner: false });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hidden: true, canChange: false });
  });

  it("says so when the settings file cannot be read, rather than reporting an unset switch", async () => {
    fs.writeFileSync(storePath(), "{ not json");
    const res = await get();
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("store_unreadable");
  });

  it("refuses no session (the agent's bearer)", async () => {
    as(null);
    const res = await get();
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
  });
});

describe("POST", () => {
  it("the owner turns it on and off; the answer is the new view", async () => {
    let res = await post({ hide: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ hidden: true, setting: "on" });
    expect(stored()).toBe(true);

    writeStore({ org_mode: true, external_engine: ENGINE, hide_cloud_providers: true });
    res = await post({ hide: false });
    expect(await res.json()).toMatchObject({ hidden: false, setting: "off", autoHidden: true });
    expect(stored()).toBe(false);
  });

  it.each([
    ["another user", { username: "alice", isOwner: false }],
    ["no session (the agent's bearer)", null],
  ] as const)("refuses %s and stores nothing", async (_label, who) => {
    as(who);
    const res = await post({ hide: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it("refuses another site's page riding the owner's cookie", async () => {
    h.sameOrigin.mockReturnValue(false);
    const res = await post({ hide: true });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(fs.existsSync(storePath())).toBe(false);
  });

  it.each([
    ["a string", { hide: "true" }, undefined],
    ["no field", {}, undefined],
    ["an array", [true], undefined],
    ["broken JSON", null, "{"],
  ])("refuses %s", async (_label, body, raw) => {
    const res = await post(body, raw);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("bad_body");
    expect(fs.existsSync(storePath())).toBe(false);
  });
});
