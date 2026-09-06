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

  describe("swap", () => {
    it("writes the new value and answers with the one it replaced", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ active_harness: "openclaw", keep: "kept" }), "utf-8");

      await expect(configStore.swap("active_harness", "hermes")).resolves.toBe("openclaw");
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content.active_harness).toBe("hermes");
      expect(content.keep).toBe("kept");
    });

    it("answers undefined for a key the store did not hold", async () => {
      await expect(configStore.swap("neverSet", "first")).resolves.toBeUndefined();
      expect(await configStore.get("neverSet")).toBe("first");
    });

    it("throws over a store it could not read, like `set`", async () => {
      // The invariant this shares with `set`: `swap` is a second write path
      // into the file holding the mailbox password and both bot tokens, and a
      // forgiving read would rebuild it from `{}` and REPLACE it with the one
      // key being written. Pinned here because the caller cannot see it.
      await fs.writeFile(CONFIG_PATH, "{ half written", "utf-8");

      await expect(configStore.swap("telegram_bot_token", "111:x")).rejects.toThrow();
      expect(await fs.readFile(CONFIG_PATH, "utf-8")).toBe("{ half written");
    });

    it("refuses `undefined` instead of quietly REMOVING the key", async () => {
      // `swap` replaces; it does not delete. `JSON.stringify` drops a key whose
      // value is `undefined`, so the rename would have written a config without
      // it — and the caller, handed the predecessor and no error, would read
      // that as a successful switch. `setActiveHarness` losing `active_harness`
      // that way leaves the box with no recorded harness while the route
      // reports the change made.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ active_harness: "hermes", keep: "kept" }), "utf-8");

      await expect(configStore.swap("active_harness", undefined)).rejects.toThrow(TypeError);
      const content = JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"));
      expect(content).toEqual({ active_harness: "hermes", keep: "kept" });
    });

    it("refuses every OTHER value JSON drops the same way", async () => {
      // `undefined` is not special — a function and a symbol are omitted by
      // `JSON.stringify` identically, with the identical outcome: the key gone
      // from the file, the predecessor returned, no error. The guard tests the
      // property, so this list is what the property covers rather than a second
      // enumeration to keep in step.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ active_harness: "hermes" }), "utf-8");

      await expect(configStore.swap("active_harness", () => "hermes")).rejects.toThrow(TypeError);
      await expect(configStore.swap("active_harness", Symbol("hermes"))).rejects.toThrow(TypeError);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ active_harness: "hermes" });
    });

    it("lets neither of two overlapping swaps read a predecessor the other replaced", async () => {
      // The property the whole fix rests on, and the one nothing else pins: the
      // read and the write are in the SAME event-loop turn, so the second call
      // cannot see the value the first one started from. Move this module to
      // `fs/promises` — a natural cleanup, since it is already `async` — and an
      // `await` appears between them, both swaps answer "openclaw", the route
      // concludes nothing moved and skips the reload. That is TASK-715 exactly.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ active_harness: "openclaw" }), "utf-8");

      // Deliberately NOT awaited in between.
      const first = configStore.swap("active_harness", "hermes");
      const second = configStore.swap("active_harness", "openclaw");

      expect(await first).toBe("openclaw");
      expect(await second).toBe("hermes");
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8")).active_harness).toBe("openclaw");
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
    it("returns empty object for corrupt JSON", async () => {
      await fs.writeFile(CONFIG_PATH, "{ invalid json", "utf-8");

      const config = await configStore.getAll();
      expect(config).toEqual({});
    });

    it("handles ENOENT gracefully", async () => {
      await fs.rm(CONFIG_PATH, { force: true });
      const value = await configStore.get("key");
      expect(value).toBeUndefined();
    });
  });

  describe("atomic writes", () => {
    it("writes config file directly", async () => {
      await configStore.set("atomic", "test");

      const raw = await fs.readFile(CONFIG_PATH, "utf-8");
      const config = JSON.parse(raw);
      expect(config.atomic).toBe("test");
    });
  });

  // JSON that parses fine and is not an object. `get` then indexed `null` and
  // threw a TypeError out of whichever route touched the store next — a 500
  // with nothing in it that names the file. Every reader here treats it as an
  // unreadable store instead.
  describe("a config.json that is not a JSON object", () => {
    it.each(["null", "42", '"a string"', "[1, 2]"])("reads %s as an unreadable store", async (raw) => {
      await fs.writeFile(CONFIG_PATH, raw, "utf-8");

      await expect(configStore.get("any_key")).resolves.toBeUndefined();
      await expect(configStore.getAll()).resolves.toEqual({});
      await expect(configStore.getKnown("any_key")).resolves.toEqual({ value: undefined, known: false });
    });
  });

  // A write reads the whole store first, and `writeConfig` renames into `data/`
  // — which needs write permission on the DIRECTORY, not on the file. So a
  // store nobody could read used to be REPLACED by the one key being saved,
  // under `success: true`, taking the mailbox password and both bot tokens with
  // it. A write over an unreadable store has to fail instead.
  describe("a write over a store that could not be read", () => {
    it("throws rather than replacing it", async () => {
      await fs.writeFile(CONFIG_PATH, "{ half written", "utf-8");

      await expect(configStore.set("telegram_bot_token", "111:x")).rejects.toThrow();
      await expect(configStore.setMany({ a: 1 })).rejects.toThrow();
      expect(await fs.readFile(CONFIG_PATH, "utf-8")).toBe("{ half written");
    });

    it("still writes the first key on a box that has never saved anything", async () => {
      await configStore.set("first", "value");

      expect(await configStore.get("first")).toBe("value");
    });
  });

  describe("getKnown", () => {
    it("says known for a store it could read, absent file included", async () => {
      await expect(configStore.getKnown("nothing")).resolves.toEqual({ value: undefined, known: true });

      await fs.writeFile(CONFIG_PATH, JSON.stringify({ present: "v" }), "utf-8");
      await expect(configStore.getKnown("present")).resolves.toEqual({ value: "v", known: true });
    });

    it("says known:false for a store it could not parse", async () => {
      await fs.writeFile(CONFIG_PATH, "{ half written", "utf-8");

      await expect(configStore.getKnown("present")).resolves.toEqual({ value: undefined, known: false });
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
