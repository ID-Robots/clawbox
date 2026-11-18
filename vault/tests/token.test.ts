// The extension's token queue (src/extension/token.ts): a 401 for the old token
// never removes a token that pairing stored meanwhile.
import { describe, expect, test } from "bun:test";
import { TokenStore, type TokenStorage } from "../src/extension/token";

/** chrome.storage-like: get answers what was stored when it was CALLED, but late. */
function slowStorage(initial: string | undefined) {
  let value = initial;
  let gate: Promise<void> | null = null;
  let open = () => {};
  const storage: TokenStorage = {
    async get() {
      const snapshot = value;
      if (gate) await gate;
      return { token: snapshot };
    },
    async set(items) {
      value = items.token;
    },
    async remove() {
      value = undefined;
    },
  };
  return {
    storage,
    value: () => value,
    hold: () => {
      gate = new Promise<void>((r) => (open = r));
    },
    release: () => {
      gate = null;
      open();
    },
  };
}

describe("the extension's token", () => {
  test("a pairing that overlaps the old token's 401 keeps its new token", async () => {
    const s = slowStorage("old-token");
    const tokens = new TokenStore(s.storage);
    s.hold();
    const drop = tokens.dropIfCurrent("old-token"); // has read "old-token", not yet removed it
    await Bun.sleep(5);
    const pair = tokens.set("new-token"); // pairing stores its token meanwhile
    await Bun.sleep(5);
    s.release();
    expect(await drop).toBe(true);
    await pair;
    expect(s.value()).toBe("new-token");
    expect(await tokens.get()).toBe("new-token");
  });

  test("a 401 for a token already replaced removes nothing", async () => {
    const s = slowStorage("new-token");
    const tokens = new TokenStore(s.storage);
    expect(await tokens.dropIfCurrent("old-token")).toBe(false);
    expect(s.value()).toBe("new-token");
    expect(await tokens.dropIfCurrent("new-token")).toBe(true);
    expect(await tokens.get()).toBeNull();
  });

  test("a failed write does not stop the queue", async () => {
    const s = slowStorage(undefined);
    const tokens = new TokenStore({ ...s.storage, set: async () => Promise.reject(new Error("quota")) });
    await expect(tokens.set("x")).rejects.toThrow("quota");
    await tokens.clear();
    expect(await tokens.get()).toBeNull();
  });
});
