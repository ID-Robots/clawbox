import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_ROOT = path.join(os.tmpdir(), `clawbox-config-tests-${process.pid}-${Date.now()}`);
const DATA_DIR = path.join(TEST_ROOT, "data");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");

let configStore: typeof import("@/lib/config-store");

beforeAll(async () => {
  process.env.CLAWBOX_ROOT = TEST_ROOT;
  await fs.mkdir(DATA_DIR, { recursive: true });
  vi.resetModules();
  configStore = await import("@/lib/config-store");
});

beforeEach(async () => {
  // Clean config file before each test
  await fs.rm(CONFIG_PATH, { force: true });
});

afterAll(async () => {
  delete process.env.CLAWBOX_ROOT;
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

describe("config-store", () => {
  describe("get", () => {
    it("returns undefined for missing key", async () => {
      const value = await configStore.get("nonexistent");
      expect(value).toBeUndefined();
    });

    it("returns undefined when config file does not exist", async () => {
      const value = await configStore.get("any_key");
      expect(value).toBeUndefined();
    });

    it("returns correct value for existing key", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ existing: "value" }), "utf-8");
      const value = await configStore.get("existing");
      expect(value).toBe("value");
    });

    it("returns complex objects correctly", async () => {
      const obj = { nested: { deep: { value: 123 } }, array: [1, 2, 3] };
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ complex: obj }), "utf-8");
      const value = await configStore.get("complex");
      expect(value).toEqual(obj);
    });

    it("handles boolean values", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ flag: true, other: false }), "utf-8");
      expect(await configStore.get("flag")).toBe(true);
      expect(await configStore.get("other")).toBe(false);
    });

    it("handles null values", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ nullKey: null }), "utf-8");
      expect(await configStore.get("nullKey")).toBeNull();
    });

    it("handles numeric values", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ num: 42, float: 3.14 }), "utf-8");
      expect(await configStore.get("num")).toBe(42);
      expect(await configStore.get("float")).toBe(3.14);
    });
  });

  describe("set", () => {
    it("creates new key-value pair", async () => {
      await configStore.set("newKey", "newValue");
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content.newKey).toBe("newValue");
    });

    it("updates existing key", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ key: "old" }), "utf-8");
      await configStore.set("key", "new");
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content.key).toBe("new");
    });

    it("deletes key when value is undefined", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ toDelete: "value", keep: "kept" }), "utf-8");
      await configStore.set("toDelete", undefined);
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content.toDelete).toBeUndefined();
      expect(content.keep).toBe("kept");
    });

    it("creates data directory if missing", async () => {
      await fs.rm(DATA_DIR, { recursive: true, force: true });
      await configStore.set("afterDelete", "value");
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content.afterDelete).toBe("value");
    });

    it("preserves other keys when setting a new one", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ a: 1, b: 2 }), "utf-8");
      await configStore.set("c", 3);
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content).toEqual({ a: 1, b: 2, c: 3 });
    });

    it("handles complex objects", async () => {
      const obj = { nested: { value: true }, arr: [1, 2, 3] };
      await configStore.set("complex", obj);
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content.complex).toEqual(obj);
    });

    it("serializes concurrent writes correctly", async () => {
      // Start multiple concurrent writes
      const writes = Promise.all([
        configStore.set("a", 1),
        configStore.set("b", 2),
        configStore.set("c", 3),
      ]);
      await writes;
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content).toEqual({ a: 1, b: 2, c: 3 });
    });
  });

  describe("setMany", () => {
    it("sets multiple keys atomically", async () => {
      await configStore.setMany({ x: 1, y: 2, z: 3 });
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content).toEqual({ x: 1, y: 2, z: 3 });
    });

    it("deletes keys with undefined values", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ a: 1, b: 2, c: 3 }), "utf-8");
      await configStore.setMany({ b: undefined, d: 4 });
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content).toEqual({ a: 1, c: 3, d: 4 });
    });

    it("preserves existing keys not in entries", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ existing: "keep" }), "utf-8");
      await configStore.setMany({ new: "value" });
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content).toEqual({ existing: "keep", new: "value" });
    });

    it("handles empty entries object", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ preserved: true }), "utf-8");
      await configStore.setMany({});
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content).toEqual({ preserved: true });
    });
  });

  describe("getAll", () => {
    it("returns full config object", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ a: 1, b: "two", c: true }), "utf-8");
      const config = await configStore.getAll();
      expect(config).toEqual({ a: 1, b: "two", c: true });
    });

    it("returns empty object for missing file", async () => {
      const config = await configStore.getAll();
      expect(config).toEqual({});
    });
  });

  describe("error handling", () => {
    it("returns empty object for corrupt JSON and creates backup", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      await fs.writeFile(CONFIG_PATH, "{ invalid json", "utf-8");

      const config = await configStore.getAll();
      expect(config).toEqual({});
      expect(consoleSpy).toHaveBeenCalled();

      // Check backup was created
      const files = await fs.readdir(DATA_DIR);
      const backupFiles = files.filter(f => f.includes(".corrupt."));
      expect(backupFiles.length).toBeGreaterThan(0);

      consoleSpy.mockRestore();
    });

    it("handles ENOENT gracefully", async () => {
      await fs.rm(CONFIG_PATH, { force: true });
      const value = await configStore.get("key");
      expect(value).toBeUndefined();
    });
  });

  describe("atomic writes", () => {
    it("uses temp file for atomic write", async () => {
      // Set up a spy to check temp file is used
      const originalWriteFile = fs.writeFile;
      const writeFileSpy = vi.spyOn(fs, "writeFile");

      await configStore.set("atomic", "test");

      // Check that writeFile was called with .tmp path
      const calls = writeFileSpy.mock.calls;
      const tmpWriteCall = calls.find(call =>
        typeof call[0] === "string" && call[0].endsWith(".tmp")
      );
      expect(tmpWriteCall).toBeDefined();

      writeFileSpy.mockRestore();
    });
  });

  describe("DATA_DIR and CONFIG_ROOT exports", () => {
    it("exports DATA_DIR constant", () => {
      expect(configStore.DATA_DIR).toBe(DATA_DIR);
    });

    it("exports CONFIG_ROOT constant", () => {
      expect(configStore.CONFIG_ROOT).toBe(TEST_ROOT);
    });
  });
});
