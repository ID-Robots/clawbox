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

  describe("a key the object backing the store cannot hold", () => {
    // `config[key] = value` for `__proto__` reaches Object.prototype's own
    // setter instead of creating a property: nothing is stored, nothing
    // throws, and `writeConfig` renames a config WITHOUT the key over the one
    // that had it. The caller is told the write succeeded — `swap` even hands
    // back a "previous" value it read through the same accessor — which is the
    // false-success shape the value guard was added to remove, arriving on the
    // key side instead.
    it("swap refuses it rather than reporting a write that never happened", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ keep: "kept" }), "utf-8");
      await expect(configStore.swap("__proto__", { polluted: true })).rejects.toThrow(TypeError);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept" });
    });

    it("set refuses it", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ keep: "kept" }), "utf-8");
      await expect(configStore.set("__proto__", { polluted: true })).rejects.toThrow(TypeError);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept" });
    });

    it("setMany refuses the whole batch rather than landing half of it", async () => {
      // Refused before anything is written, so the caller's other entries are
      // not silently applied around the one that could never land.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ keep: "kept" }), "utf-8");
      // A COMPUTED key, deliberately: `{ __proto__: … }` in an object literal
      // sets the literal's prototype and creates no entry at all, so a batch
      // written that way would never reach the store's key guard and the case
      // would pass by testing nothing.
      await expect(
        configStore.setMany({ telegram_bot_token: "111:x", ["__proto__"]: { polluted: true } }),
      ).rejects.toThrow(TypeError);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept" });
    });
  });

  describe("a __proto__ the FILE already carries", () => {
    // Refusing to CREATE one is only half an invariant: a store that acquired
    // the key before this build — a hand-edit, a restored backup of an older
    // data/ — would otherwise re-emit it on every settings change with no
    // supported way out, and the read side would go on answering
    // Object.prototype for it.
    it("is dropped on the way in and does not come back out", async () => {
      await fs.writeFile(CONFIG_PATH, '{"__proto__":{"polluted":true},"keep":"kept"}', "utf-8");
      expect(await configStore.get("__proto__")).toBeUndefined();
      expect(await configStore.getAll()).toEqual({ keep: "kept" });
      expect((await configStore.getKnown("__proto__")).value).toBeUndefined();

      await configStore.set("keep", "still kept");
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "still kept" });
    });

    it("can still be deleted, because a delete is not a write", async () => {
      await fs.writeFile(CONFIG_PATH, '{"__proto__":{"polluted":true},"keep":"kept"}', "utf-8");
      await expect(configStore.set("__proto__", undefined)).resolves.toBeUndefined();
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept" });
    });
  });

  describe("a number JSON cannot write", () => {
    // `JSON.stringify(NaN)` is the string "null", so a non-finite number walks
    // straight through the `=== undefined` guard and the file ends up holding
    // `null` under a key the caller believes holds a number. Every reader then
    // sees "unset" where the caller stored a figure, and the write reported
    // success — the same false success, one type further in.
    it("swap refuses NaN and Infinity instead of storing null", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ clawai_credential_refused_at: 5 }), "utf-8");
      await expect(configStore.swap("clawai_credential_refused_at", NaN)).rejects.toThrow(TypeError);
      await expect(configStore.swap("clawai_credential_refused_at", Infinity)).rejects.toThrow(TypeError);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ clawai_credential_refused_at: 5 });
    });

    it("set and setMany refuse it too, nested as well as bare", async () => {
      // Nested as well, because an object one field deep is written as `null`
      // just as quietly as a bare figure.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ keep: "kept" }), "utf-8");
      await expect(configStore.set("setup_progress_step", { step: NaN })).rejects.toThrow(TypeError);
      await expect(configStore.setMany({ session_generation: -Infinity })).rejects.toThrow(TypeError);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept" });
    });
  });

  describe("a list with a member JSON cannot write", () => {
    it("is refused rather than stored with a null in it", async () => {
      // The other value JSON turns into `null`, and the one the top-level
      // `=== undefined` test cannot see: inside an ARRAY, `undefined`, a
      // function and a symbol are all written as a null MEMBER, so the list
      // keeps its length and one entry becomes nothing. A `map` that can yield
      // a hole — the approved-sender names, the disabled-provider list — would
      // land that under a key the caller believes holds names.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ keep: "kept" }), "utf-8");
      await expect(configStore.set("telegram_approved_names", ["a", undefined, "b"]))
        .rejects.toThrow(TypeError);
      await expect(configStore.swap("telegram_approved_names", [{ names: [Symbol("x")] }]))
        .rejects.toThrow(TypeError);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept" });
    });

    it("still stores a property JSON omits, because nothing is misreported there", async () => {
      // An OBJECT property whose value is `undefined` is left out of the file
      // and reads back as `undefined` — which is what the caller stored. The
      // guard is about values that come back as something ELSE.
      await configStore.set("email_account", { address: "a@b.c", fromName: undefined });
      expect(await configStore.get("email_account")).toEqual({ address: "a@b.c" });
    });
  });

  describe("a value JSON omits altogether", () => {
    it("is refused by all three writers, not just swap", async () => {
      // The key half of this fix has an exact twin on the value side: a
      // top-level function or symbol is dropped by `JSON.stringify`, so the
      // rename lands a config WITHOUT the key — the caller's stored value is
      // gone and the write answered success. `swap` refused it already, from
      // its own `=== undefined` test; `set` and `setMany` did not, so the three
      // writers were not the same guard.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ active_harness: "hermes" }), "utf-8");

      await expect(configStore.set("active_harness", () => "openclaw")).rejects.toThrow(TypeError);
      await expect(configStore.setMany({ active_harness: Symbol("openclaw") })).rejects.toThrow(TypeError);
      await expect(configStore.swap("active_harness", () => "openclaw")).rejects.toThrow(TypeError);

      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ active_harness: "hermes" });
    });

    it("still lets `undefined` mean delete, in both writers that take it", async () => {
      // The one value that must NOT throw: it is the documented removal, and
      // both writers filter it out before the guard.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ a: 1, b: 2 }), "utf-8");
      await configStore.set("a", undefined);
      await configStore.setMany({ b: undefined });
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({});
    });

    it("refuses a boxed non-finite number, which stringifies to null like the bare one", async () => {
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ keep: "kept" }), "utf-8");
      await expect(configStore.set("session_generation", new Number(NaN))).rejects.toThrow(TypeError);
      await expect(configStore.set("plan", { limit: new Number(Infinity) })).rejects.toThrow(TypeError);
      // A boxed FINITE number is written as the number it holds, and is fine.
      await configStore.set("session_generation", new Number(7));
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept", session_generation: 7 });
    });
  });

  describe("a value `toJSON` has already turned into null", () => {
    it("refuses an invalid Date in every writer, bare and nested", async () => {
      // `JSON.stringify` calls a value's own `toJSON` BEFORE the replacer, so
      // the guard is handed `null` and never sees the Date at all: the store
      // then holds `null` under a key the caller believes holds a time, and
      // every reader sees "unset" over a write that answered success.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ keep: "kept" }), "utf-8");

      await expect(configStore.set("clawai_credential_refused_at", new Date(NaN))).rejects.toThrow(TypeError);
      await expect(configStore.set("plan", { renewsAt: new Date(NaN) })).rejects.toThrow(TypeError);
      await expect(configStore.swap("clawai_credential_refused_at", new Date(NaN))).rejects.toThrow(TypeError);
      await expect(configStore.setMany({ clawai_credential_refused_at: new Date(NaN) })).rejects.toThrow(TypeError);

      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept" });
    });

    it("still stores a VALID Date as the string JSON makes of it, and a real null as null", async () => {
      // The guard is about a value that comes back as something ELSE. A date
      // that serialises is exactly what the caller asked to store, and `null`
      // itself is a value this store has always held.
      await configStore.set("password_configured_at", new Date("2026-09-07T12:00:00.000Z"));
      await configStore.set("clawai_plan_tier", null);
      expect(await configStore.get("password_configured_at")).toBe("2026-09-07T12:00:00.000Z");
      expect(await configStore.get("clawai_plan_tier")).toBeNull();
    });

    it("refuses any toJSON that answers null, not just Date's", async () => {
      // The class, not the corner: nothing about the failure is specific to
      // dates — any value whose `toJSON` answers null is written as null.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ keep: "kept" }), "utf-8");
      await expect(configStore.set("plan", { toJSON: () => null })).rejects.toThrow(TypeError);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ keep: "kept" });
    });

    it("refuses a value JSON omits entirely, whatever shape it arrives in", async () => {
      // The catch-all behind the named guards: a `toJSON` that answers
      // `undefined` drops the whole key, with none of the shapes the guards
      // recognise. `swap` said "use set()" for this, which stopped being advice
      // the moment `set` refused it too.
      await fs.writeFile(CONFIG_PATH, JSON.stringify({ active_harness: "hermes" }), "utf-8");
      await expect(configStore.swap("active_harness", { toJSON: () => undefined })).rejects.toThrow(
        /cannot hold a value JSON omits entirely/,
      );
      // And `undefined` itself still gets the advice that IS true for it.
      await expect(configStore.swap("active_harness", undefined)).rejects.toThrow(/use set\(\)/);
      expect(JSON.parse(await fs.readFile(CONFIG_PATH, "utf-8"))).toEqual({ active_harness: "hermes" });
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
