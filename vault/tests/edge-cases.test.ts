// Races and edge cases of the service: two requests for one new name, a poll
// that is already gone or replaced, a body over the limit, a rename that must
// not half-happen, a fill detail that cannot be checked, a failed decrypt.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FillQueue } from "../src/server/fillqueue";
import { PassError } from "../src/server/pass";
import { createTempStore, type TempStore } from "./helpers/tempstore";
import { createTestVault, EXT_ORIGIN, pairExtension, type TestVault } from "./helpers/vault";

let store: TempStore;
let v: TestVault;
let ui = "";
let ext = "";

beforeAll(async () => {
  store = createTempStore();
  v = await createTestVault(store);
  ({ ui, ext } = await pairExtension(v));
}, 60_000);
afterAll(() => store?.cleanup());

const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

describe("the agent API", () => {
  test("of two generate requests for one new name, one stores and the other gets 409", async () => {
    const gen = () => v.request("/api/agent/generate", { token: v.mcpToken, body: { name: "race.example.com/me" } });
    const statuses = (await Promise.all([gen(), gen()])).map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    // overwrite=true still replaces it.
    expect((await v.request("/api/agent/generate", { token: v.mcpToken, body: { name: "race.example.com/me", overwrite: true } })).status).toBe(200);
  });

  test("a body over 64 KiB is refused with 413 before it is parsed", async () => {
    const res = await v.request("/api/agent/save", { token: v.mcpToken, raw: JSON.stringify({ name: "big.example.com/me", note: "x".repeat(70_000) }) });
    expect(res.status).toBe(413);
    expect(await v.catalog.exists("big.example.com/me")).toBe(false);
  });

  test("a fill detail is dropped when the entry can no longer be read to check it", async () => {
    await v.catalog.save({ name: "gone.example.com/me", password: "Gone-Secret-913" });
    const poll = v.request("/api/ext/commands?wait=2000", { token: ext, origin: EXT_ORIGIN }).then(json);
    await Bun.sleep(20);
    const fill = v.request("/api/agent/fill", { token: v.mcpToken, body: { url: "https://gone.example.com/login" } });
    const { commands } = (await poll) as { commands: Array<{ id: string }> };
    expect((await v.request("/api/ext/secret", { token: ext, origin: EXT_ORIGIN, body: { commandId: commands[0]!.id } })).status).toBe(200);
    await v.catalog.remove("gone.example.com/me");
    await v.request("/api/ext/result", { token: ext, origin: EXT_ORIGIN, body: { id: commands[0]!.id, status: "filled", detail: "typed into #password" } });
    expect(await json(await fill)).toEqual({ status: "filled", name: "gone.example.com/me" });
    expect(v.logs.join("\n")).toContain("fill detail for gone.example.com/me could not be checked");
  });
});

describe("saving from the app", () => {
  test("a new entry that names an original is refused before anything moves", async () => {
    await v.catalog.save({ name: "keep.example.com/me", password: "Keep-Secret-1" });
    const res = await v.request("/api/ui/entries", {
      token: ui,
      body: { name: "moved.example.com/me", originalName: "keep.example.com/me", create: true, password: "x-Secret-2" },
    });
    expect(res.status).toBe(400);
    expect(await v.catalog.exists("keep.example.com/me")).toBe(true);
    expect(await v.catalog.exists("moved.example.com/me")).toBe(false);
  });

  test("a rename onto a folder's name is refused and touches neither side", async () => {
    await v.catalog.save({ name: "a/owner", password: "A-Secret-1" });
    await v.catalog.save({ name: "b/owner", password: "B-Secret-1" });
    const res = await v.request("/api/ui/entries", { token: ui, body: { name: "b", originalName: "a/owner" } });
    expect(res.status).toBe(409);
    expect((await v.catalog.read("a/owner")).password).toBe("A-Secret-1");
    expect((await v.catalog.read("b/owner")).password).toBe("B-Secret-1");
    expect(await v.catalog.exists("b")).toBe(false);
  });
});

describe("the catalog", () => {
  test("a failed decrypt is not remembered: the next list reads the entry again", async () => {
    await v.catalog.save({ name: "plain-name", login: "carol", url: "https://plain.example.com", password: "Plain-Secret-5" });
    const store = v.catalog.store;
    const show = store.show.bind(store);
    store.show = async () => {
      throw new PassError("pass show failed (exit 2)", "failed");
    };
    try {
      expect((await v.catalog.list()).find((e) => e.name === "plain-name")?.login).toBe("");
    } finally {
      store.show = show;
    }
    expect((await v.catalog.list()).find((e) => e.name === "plain-name")?.login).toBe("carol");
  });
});

describe("the fill queue", () => {
  test("a poll whose caller is already gone takes nothing", async () => {
    const q = new FillQueue({ timeoutMs: 1_000 });
    await q.poll(0); // the browser has been seen, so the command is queued
    const pending = q.submit({ url: "https://x.example.com/", name: "x.example.com/me", entryUrl: "https://x.example.com", submit: false });
    const gone = new AbortController();
    gone.abort();
    expect(await q.poll(500, gone.signal)).toEqual([]);
    expect((await q.poll(500)).map((c) => c.name)).toEqual(["x.example.com/me"]);
    q.cancelAll("extension_offline");
    expect((await pending).status).toBe("extension_offline");
  });

  test("pairing a new browser ends the old one's open poll", async () => {
    const started = Date.now();
    const old = v.request("/api/ext/commands?wait=2000", { token: ext, origin: EXT_ORIGIN }).then(json);
    await Bun.sleep(20);
    ({ ext } = await pairExtension(v));
    expect(await old).toMatchObject({ commands: [] });
    expect(Date.now() - started).toBeLessThan(1_500);
  });
});
