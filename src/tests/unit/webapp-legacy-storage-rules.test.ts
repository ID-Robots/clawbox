/**
 * The rules of the webapp legacy-storage layer (TASK-1150): which old data is
 * whose, and where it lives now. Pure functions, shared by the boot
 * migration, the routes and the desktop — so one set of cases pins all three.
 */
import { describe, expect, it } from "vitest";
import {
  belongsToAnotherApp,
  detectLegacyStorageApis,
  extractStringTokens,
  isAttributedKey,
  isClawboxOwnedStorageKey,
  isLocalStorageKvKey,
  isValidLegacyKvKey,
  legacyKvListing,
  legacyKvNames,
  legacyKvStorageKey,
  localStorageKeyFromKv,
  localStorageKvKey,
} from "@/lib/webapp-legacy-storage-rules";

describe("detectLegacyStorageApis", () => {
  it("sees the v3.9 KV route and the origin's storage", () => {
    expect(detectLegacyStorageApis("fetch('/setup-api/kv?key=todo:items')")).toEqual({ kv: true, localStorage: false });
    expect(detectLegacyStorageApis("localStorage.getItem('x')")).toEqual({ kv: false, localStorage: true });
    expect(detectLegacyStorageApis("sessionStorage.setItem('x', 1)").localStorage).toBe(true);
  });

  it("does not mistake the bridge, or a different route, for them", () => {
    expect(detectLegacyStorageApis("window.clawboxKv.get('items')")).toEqual({ kv: false, localStorage: false });
    expect(detectLegacyStorageApis("fetch('/setup-api/kv-extra')").kv).toBe(false);
    expect(detectLegacyStorageApis("fetch('/setup-api/kvx')").kv).toBe(false);
  });
});

describe("extractStringTokens", () => {
  it("reads every quoted literal, template heads and URL key/prefix values", () => {
    const code = `
      const NS = 'todo';
      fetch("/setup-api/kv?key=todo:items");
      fetch('/setup-api/kv?prefix=' + encodeURIComponent('notes:'));
      fetch(\`/setup-api/kv?key=\${NS}:x\`);
      localStorage.setItem(\`session-\${n}\`, v);
      fetch('/setup-api/kv?prefix=habit%3A');
    `;
    const tokens = new Set(extractStringTokens(code));
    for (const t of ["todo", "/setup-api/kv?key=todo:items", "todo:items", "notes:", "session-", "habit:"]) {
      expect(tokens.has(t), t).toBe(true);
    }
  });

  it("skips what could name nothing: one character, an escape, an over-long literal", () => {
    const tokens = extractStringTokens(`'a' "it\\'s" '${"x".repeat(300)}' "ok"`);
    expect(tokens).toEqual(["ok"]);
  });

  it("keeps pairing quotes correctly after a long string, and stays linear on an unclosed one", () => {
    const long = "x".repeat(100_000);
    const code = `var img = '${long}'; var k = 'todo:items'; // don't\nvar j = "notes:list";`;
    const tokens = new Set(extractStringTokens(code));
    expect(tokens.has("todo:items")).toBe(true);
    expect(tokens.has("notes:list")).toBe(true);
    // Thousands of unclosed apostrophes on one huge line must not go quadratic.
    const hostile = "a'b ".repeat(200_000);
    const started = Date.now();
    extractStringTokens(hostile);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops at the cap", () => {
    const code = Array.from({ length: 50 }, (_, i) => `'tok${i}'`).join(";");
    expect(extractStringTokens(code, 10)).toHaveLength(10);
  });
});

describe("isAttributedKey", () => {
  const tokens = new Set(["todo:items", "notes:", "streaks", "session-", "pomodoro-settings", "a-"]);
  it("attributes a whole key, a separator-ended prefix, and a colon namespace", () => {
    expect(isAttributedKey("todo:items", tokens)).toBe(true);
    expect(isAttributedKey("notes:list", tokens)).toBe(true);
    expect(isAttributedKey("streaks:data", tokens)).toBe(true);
    expect(isAttributedKey("session-3", tokens)).toBe(true);
    expect(isAttributedKey("pomodoro-settings", tokens)).toBe(true);
  });

  it("attributes nothing the code does not name", () => {
    expect(isAttributedKey("todo:other", tokens)).toBe(false);
    expect(isAttributedKey("streaks-data", tokens)).toBe(false); // only ':' is a namespace
    expect(isAttributedKey("a-b", tokens)).toBe(false); // a prefix must be three characters or more
    expect(isAttributedKey("x", tokens)).toBe(false);
  });
});

describe("ownership", () => {
  it("never hands a webapp ClawBox's own keys", () => {
    for (const key of [
      "ui:pending-actions",
      "clawbox-winsize-files",
      "clawbox:hermes:chat",
      "clawbox-gateway-device-identity-v1",
      "clawai_tier_seen",
      "openclaw.control.settings.v1",
      "OpenClaw.anything",
      "hermes-x",
      "__proto__",
    ]) {
      expect(isClawboxOwnedStorageKey(key), key).toBe(true);
    }
    for (const key of ["todo:items", "pomodoro-settings", "user", "clawfoot"]) {
      expect(isClawboxOwnedStorageKey(key), key).toBe(false);
    }
  });

  it("leaves another installed app's namespace to that app", () => {
    const ids = new Set(["notes", "todo-list"]);
    expect(belongsToAnotherApp("notes:list", "todo-list", ids)).toBe(true);
    expect(belongsToAnotherApp("notes:list", "notes", ids)).toBe(false);
    expect(belongsToAnotherApp("todo:items", "todo-list", ids)).toBe(false);
    expect(belongsToAnotherApp("bare", "todo-list", ids)).toBe(false);
  });
});

describe("where a legacy key lives now", () => {
  it("keeps a key already in the app's namespace, nests every other", () => {
    expect(legacyKvStorageKey("notes", "notes:list")).toBe("notes:list");
    expect(legacyKvStorageKey("todo-list", "todo:items")).toBe("todo-list:todo:items");
    expect(legacyKvStorageKey("habits", "habits-theme")).toBe("habits:habits-theme");
  });

  it("knows each stored key by both names a legacy app may use", () => {
    expect(legacyKvNames("notes", "notes:list")).toEqual(["notes:list", "list"]);
    expect(legacyKvNames("notes", "todo:items")).toEqual([]);
  });

  it("lists by the prefix asked for, inside the namespace only, without the localStorage keys", () => {
    const data = {
      "todo-list:todo:items": "[1]",
      "todo-list:todo:done": "[2]",
      "todo-list:localStorage:x": "hidden",
      "todo:items": "old copy",
      "notes:list": "other app",
    };
    expect(legacyKvListing("todo-list", data, "todo:")).toEqual({ "todo:items": "[1]", "todo:done": "[2]" });
    expect(legacyKvListing("todo-list", data, "todo-list:")).toEqual({ "todo-list:todo:items": "[1]", "todo-list:todo:done": "[2]" });
    const all = legacyKvListing("todo-list", data, "");
    expect(all["todo:items"]).toBe("[1]");
    expect(all["notes:list"]).toBeUndefined();
    expect(Object.values(all)).not.toContain("hidden");
  });

  it("keeps localStorage keys under their own sub-namespace, round-tripping any key", () => {
    expect(localStorageKvKey("pomodoro", "settings")).toBe("pomodoro:localStorage:settings");
    for (const key of ["settings", "my todos", "ключ", "a/b?c", "x:y"]) {
      const stored = localStorageKvKey("pomodoro", key)!;
      expect(isValidLegacyKvKey(stored), key).toBe(true);
      expect(isLocalStorageKvKey("pomodoro", stored)).toBe(true);
      expect(localStorageKeyFromKv("pomodoro", stored)).toBe(key);
    }
    expect(localStorageKvKey("pomodoro", "")).toBeNull();
    expect(localStorageKvKey("pomodoro", "k".repeat(300))).toBeNull();
    expect(localStorageKeyFromKv("pomodoro", "pomodoro:settings")).toBeNull();
    expect(localStorageKeyFromKv("pomodoro", "other:localStorage:settings")).toBeNull();
  });
});
