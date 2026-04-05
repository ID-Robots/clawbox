import fs from "fs/promises";
import fsSync from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-kv-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const KV_PATH = path.join(DATA_DIR, "kv.json");

let kvStore: typeof import("@/lib/kv-store");

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  kvStore = await import("@/lib/kv-store");
});

beforeEach(async () => {
  // Clean kv file before each test
  await fs.rm(KV_PATH, { force: true });
  // Also remove the tmp file in case a previous test left one
  await fs.rm(KV_PATH + ".tmp", { force: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("kv-store", () => {
  describe("kvGet", () => {
    it("returns null for missing key", () => {
      const value = kvStore.kvGet("nonexistent");
      expect(value).toBeNull();
    });

    it("returns null when kv file does not exist", () => {
      const value = kvStore.kvGet("any_key");
      expect(value).toBeNull();
    });

    it("returns correct value for existing key", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ greeting: "hello" }), "utf-8");
      const value = kvStore.kvGet("greeting");
      expect(value).toBe("hello");
    });

    it("returns null for key not present in file", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ a: "1" }), "utf-8");
      const value = kvStore.kvGet("b");
      expect(value).toBeNull();
    });

    it("handles empty object file", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({}), "utf-8");
      const value = kvStore.kvGet("key");
      expect(value).toBeNull();
    });
  });

  describe("kvSet", () => {
    it("creates new key-value pair", () => {
      kvStore.kvSet("newKey", "newValue");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content.newKey).toBe("newValue");
    });

    it("updates existing key", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ key: "old" }), "utf-8");
      kvStore.kvSet("key", "new");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content.key).toBe("new");
    });

    it("preserves other keys when setting a new one", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ a: "1", b: "2" }), "utf-8");
      kvStore.kvSet("c", "3");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ a: "1", b: "2", c: "3" });
    });

    it("can set empty string value", () => {
      kvStore.kvSet("empty", "");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content.empty).toBe("");
    });

    it("overwrites value when called multiple times for same key", () => {
      kvStore.kvSet("counter", "1");
      kvStore.kvSet("counter", "2");
      kvStore.kvSet("counter", "3");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content.counter).toBe("3");
    });

    it("uses atomic write via tmp file and rename", () => {
      const writeFileSyncSpy = vi.spyOn(fsSync, "writeFileSync");
      const renameSyncSpy = vi.spyOn(fsSync, "renameSync");

      kvStore.kvSet("atomic", "test");

      // Should write to .tmp file first
      expect(writeFileSyncSpy).toHaveBeenCalledWith(
        KV_PATH + ".tmp",
        expect.any(String),
      );
      // Then rename to the actual path
      expect(renameSyncSpy).toHaveBeenCalledWith(KV_PATH + ".tmp", KV_PATH);

      writeFileSyncSpy.mockRestore();
      renameSyncSpy.mockRestore();
    });
  });

  describe("kvDelete", () => {
    it("removes an existing key", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ a: "1", b: "2" }), "utf-8");
      kvStore.kvDelete("a");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ b: "2" });
    });

    it("does not throw when deleting a non-existent key", () => {
      kvStore.kvSet("only", "one");
      expect(() => kvStore.kvDelete("missing")).not.toThrow();
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ only: "one" });
    });

    it("produces empty object when last key is deleted", () => {
      kvStore.kvSet("sole", "value");
      kvStore.kvDelete("sole");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({});
    });

    it("preserves other keys", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ x: "1", y: "2", z: "3" }), "utf-8");
      kvStore.kvDelete("y");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ x: "1", z: "3" });
    });
  });

  describe("kvGetAll", () => {
    it("returns all key-value pairs", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ a: "1", b: "2", c: "3" }), "utf-8");
      const all = kvStore.kvGetAll();
      expect(all).toEqual({ a: "1", b: "2", c: "3" });
    });

    it("returns empty object for missing file", () => {
      const all = kvStore.kvGetAll();
      expect(all).toEqual({});
    });

    it("returns empty object when no prefix matches", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ "app:theme": "dark", "app:lang": "en" }), "utf-8");
      const result = kvStore.kvGetAll("user:");
      expect(result).toEqual({});
    });

    it("filters by prefix when provided", async () => {
      await fs.writeFile(
        KV_PATH,
        JSON.stringify({
          "ui:theme": "dark",
          "ui:sidebar": "open",
          "app:version": "1.0",
          "app:name": "test",
        }),
        "utf-8",
      );
      const uiEntries = kvStore.kvGetAll("ui:");
      expect(uiEntries).toEqual({ "ui:theme": "dark", "ui:sidebar": "open" });
    });

    it("returns all entries when prefix is empty string", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ a: "1", b: "2" }), "utf-8");
      // Empty string prefix matches everything since every string starts with ""
      const all = kvStore.kvGetAll("");
      expect(all).toEqual({ a: "1", b: "2" });
    });

    it("returns all entries when prefix is undefined", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ a: "1", b: "2" }), "utf-8");
      const all = kvStore.kvGetAll(undefined);
      expect(all).toEqual({ a: "1", b: "2" });
    });

    it("prefix matching is case-sensitive", async () => {
      await fs.writeFile(
        KV_PATH,
        JSON.stringify({ "App:name": "upper", "app:name": "lower" }),
        "utf-8",
      );
      const result = kvStore.kvGetAll("app:");
      expect(result).toEqual({ "app:name": "lower" });
    });
  });

  describe("kvSetMany", () => {
    it("sets multiple key-value pairs at once", () => {
      kvStore.kvSetMany({ a: "1", b: "2", c: "3" });
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ a: "1", b: "2", c: "3" });
    });

    it("preserves existing keys not in entries", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ existing: "keep" }), "utf-8");
      kvStore.kvSetMany({ added: "new" });
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ existing: "keep", added: "new" });
    });

    it("overwrites existing keys that appear in entries", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ a: "old", b: "keep" }), "utf-8");
      kvStore.kvSetMany({ a: "new", c: "added" });
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ a: "new", b: "keep", c: "added" });
    });

    it("handles empty entries object", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ preserved: "yes" }), "utf-8");
      kvStore.kvSetMany({});
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ preserved: "yes" });
    });

    it("creates file when it does not exist", () => {
      kvStore.kvSetMany({ brand: "new" });
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ brand: "new" });
    });
  });

  describe("kvClear", () => {
    it("removes all keys", async () => {
      await fs.writeFile(KV_PATH, JSON.stringify({ a: "1", b: "2", c: "3" }), "utf-8");
      kvStore.kvClear();
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({});
    });

    it("works when file does not exist", () => {
      expect(() => kvStore.kvClear()).not.toThrow();
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({});
    });

    it("file still exists after clear (just empty)", () => {
      kvStore.kvSet("temp", "data");
      kvStore.kvClear();
      expect(fsSync.existsSync(KV_PATH)).toBe(true);
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({});
    });
  });

  describe("error handling", () => {
    it("returns empty object for corrupt JSON", async () => {
      await fs.writeFile(KV_PATH, "{ invalid json !!!", "utf-8");
      const value = kvStore.kvGet("key");
      expect(value).toBeNull();
    });

    it("kvGetAll returns empty object for corrupt JSON", async () => {
      await fs.writeFile(KV_PATH, "not valid json", "utf-8");
      const all = kvStore.kvGetAll();
      expect(all).toEqual({});
    });

    it("kvSet recovers from corrupt file by starting fresh", async () => {
      await fs.writeFile(KV_PATH, "corrupted{{{", "utf-8");
      kvStore.kvSet("recovered", "yes");
      const content = JSON.parse(fsSync.readFileSync(KV_PATH, "utf-8"));
      expect(content).toEqual({ recovered: "yes" });
    });
  });

  describe("integration: round-trip operations", () => {
    it("set then get returns correct value", () => {
      kvStore.kvSet("roundtrip", "value");
      expect(kvStore.kvGet("roundtrip")).toBe("value");
    });

    it("set, delete, get returns null", () => {
      kvStore.kvSet("ephemeral", "temp");
      kvStore.kvDelete("ephemeral");
      expect(kvStore.kvGet("ephemeral")).toBeNull();
    });

    it("setMany then getAll returns all entries", () => {
      kvStore.kvSetMany({ m1: "v1", m2: "v2", m3: "v3" });
      const all = kvStore.kvGetAll();
      expect(all).toEqual({ m1: "v1", m2: "v2", m3: "v3" });
    });

    it("mixed operations produce correct state", () => {
      kvStore.kvSet("a", "1");
      kvStore.kvSet("b", "2");
      kvStore.kvSetMany({ c: "3", d: "4" });
      kvStore.kvDelete("b");
      kvStore.kvSet("a", "updated");

      expect(kvStore.kvGet("a")).toBe("updated");
      expect(kvStore.kvGet("b")).toBeNull();
      expect(kvStore.kvGet("c")).toBe("3");
      expect(kvStore.kvGet("d")).toBe("4");
      expect(kvStore.kvGetAll()).toEqual({ a: "updated", c: "3", d: "4" });
    });

    it("clear then set starts fresh", () => {
      kvStore.kvSetMany({ old1: "x", old2: "y" });
      kvStore.kvClear();
      kvStore.kvSet("fresh", "start");
      expect(kvStore.kvGetAll()).toEqual({ fresh: "start" });
    });
  });
});
