/**
 * sqlite-store falls back to the JSON config-store when bun:sqlite isn't
 * available. Vitest runs under Node, so the Bun import always fails and
 * we exercise the fallback path. That's exactly the same path production
 * takes (since the production server runs under Node too — see comment
 * at the top of src/lib/sqlite-store.ts).
 */
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-sqlite-store-tests-${process.pid}-${Date.now()}`);
const CONFIG_PATH = path.join(TEST_ROOT, "data", "config.json");

let store: typeof import("@/lib/sqlite-store");

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  vi.resetModules();
  store = await import("@/lib/sqlite-store");
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(CONFIG_PATH, { force: true });
});

describe("sqlite-store (Node fallback)", () => {
  it("get returns null for a missing key", async () => {
    expect(await store.sqliteGet("nope")).toBeNull();
  });

  it("set then get round-trips a string value", async () => {
    await store.sqliteSet("a", "alpha");
    expect(await store.sqliteGet("a")).toBe("alpha");
  });

  it("set overwrites a previous value", async () => {
    await store.sqliteSet("k", "first");
    await store.sqliteSet("k", "second");
    expect(await store.sqliteGet("k")).toBe("second");
  });

  it("delete removes a previously-set key", async () => {
    await store.sqliteSet("d", "to-go");
    await store.sqliteDelete("d");
    expect(await store.sqliteGet("d")).toBeNull();
  });

  it("delete on a missing key is a no-op", async () => {
    await expect(store.sqliteDelete("never-set")).resolves.not.toThrow();
  });

  it("entries land in the config-store under the sqlite-kv: prefix", async () => {
    await store.sqliteSet("scoped", "value");
    const raw = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
    expect(raw["sqlite-kv:scoped"]).toBe("value");
  });

  it("ignores non-string fallback values stored under the prefix", async () => {
    await fs.writeFile(
      CONFIG_PATH,
      JSON.stringify({ "sqlite-kv:legacy": { not: "a-string" } }),
    );
    expect(await store.sqliteGet("legacy")).toBeNull();
  });
});
