/**
 * The owner's own Anthropic access, as the box actually reads it.
 *
 * Two things are worth a real filesystem here rather than a mock:
 *
 *  - WHERE a `claude` login lives. Which of the two files holds the answer
 *    depends on the CLI's version, so both are asked — and getting this wrong
 *    in the permissive direction would tell an owner runs will work when they
 *    will not, while getting it wrong in the strict direction hides a login
 *    they made in the Terminal app an hour ago. The paths are Claude Code's
 *    defaults on purpose: an `anthropic` run does NOT set CLAUDE_CONFIG_DIR,
 *    so these are the files that run will use.
 *  - That a stored key never leaves through anything but its one reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  const homedir = () => process.env.CLAWBOX_TEST_HOME ?? actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
});

const configGet = vi.hoisted(() => vi.fn());
const configSet = vi.hoisted(() => vi.fn());
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: configGet,
  set: configSet,
}));

// The key now lives in the ACCOUNT POOL (src/lib/anthropic-accounts.ts, pinned
// on its own in anthropic-accounts.test.ts); here only the delegation is.
const pool = vi.hoisted(() => ({
  readAccounts: vi.fn(),
  addApiKeyAccount: vi.fn(),
  replaceCredential: vi.fn(),
  removeAccount: vi.fn(),
  poolHasCredential: vi.fn(),
}));
vi.mock("@/lib/anthropic-accounts", () => pool);

import {
  MAX_ANTHROPIC_KEY_CHARS,
  _resetAnthropicLoginCache,
  clearAnthropicKey,
  getAnthropicConnection,
  hasAnthropicKey,
  hasAnthropicLogin,
  looksLikeAnthropicKey,
  setAnthropicKey,
  verifyAnthropicKey,
} from "@/lib/coding-anthropic";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CLAWBOX_TEST_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-home-"));
  process.env.CLAWBOX_TEST_HOME = home;
  configGet.mockReset().mockResolvedValue(undefined);
  configSet.mockReset().mockResolvedValue(undefined);
  pool.readAccounts.mockReset().mockResolvedValue([]);
  pool.addApiKeyAccount.mockReset().mockResolvedValue({ id: "aaaaaaaa" });
  pool.replaceCredential.mockReset().mockResolvedValue({ id: "aaaaaaaa" });
  pool.removeAccount.mockReset().mockResolvedValue(undefined);
  pool.poolHasCredential.mockReset().mockResolvedValue({ any: false, hasKey: false, hasLogin: false, hasOAuth: false, first: null });
  // Each case gets its own home; the cache must not answer for the last one's.
  _resetAnthropicLoginCache();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.CLAWBOX_TEST_HOME;
  else process.env.CLAWBOX_TEST_HOME = previousHome;
  vi.unstubAllGlobals();
});

describe("finding a `claude` login", () => {
  it("is false on a home where nobody has signed in", () => {
    expect(hasAnthropicLogin()).toBe(false);
  });

  it("finds the credential file the CLI writes on Linux", () => {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "x" } }));
    expect(hasAnthropicLogin()).toBe(true);
  });

  it("does not read an EMPTY credential file as a login", () => {
    // A zero-byte file is what an interrupted sign-in leaves behind; calling
    // it a login would promise runs that cannot authenticate.
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "");
    expect(hasAnthropicLogin()).toBe(false);
  });

  it("finds the account block in Claude Code's own config", () => {
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "owner@example.com" } }));
    expect(hasAnthropicLogin()).toBe(true);
  });

  it("does not read a config WITHOUT an account as a login", () => {
    // Every box that has ever run claude-ds has one of these — it is where
    // the trust answers are seeded — so treating its mere existence as a
    // login would report the whole fleet as connected.
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
    expect(hasAnthropicLogin()).toBe(false);
  });

  it("notices a sign-in made after an earlier read said there was none", () => {
    // The verdict is cached to keep a five-second status poll off a whole-file
    // read, keyed on the file's size and mtime — so a login the owner has just
    // made must show up at the next poll, not after a timer.
    //
    // The first read has to go through the CACHED path, which means the file
    // must already exist: with no config at all the stat throws and nothing is
    // cached, so this case would pass whatever the cache key did.
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: {} }));
    expect(hasAnthropicLogin()).toBe(false);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "o@e.com" } }));
    expect(hasAnthropicLogin()).toBe(true);
  });

  it("notices one that left the file exactly as long as it was", () => {
    // The other half of the key. The case above changes the file's LENGTH, so
    // it would pass on size alone; a config rewritten to the same length is
    // caught only by the mtime. Set explicitly rather than left to the clock:
    // two writes in one millisecond are not a defect this test should fail on.
    const file = path.join(home, ".claude.json");
    fs.writeFileSync(file, JSON.stringify({ oauthAccountX: { emailAddress: "o@e.com" } }));
    const before = fs.statSync(file);
    expect(hasAnthropicLogin()).toBe(false);

    fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "oo@e.com" } }));
    const after = fs.statSync(file);
    expect(after.size).toBe(before.size);
    const moved = new Date(before.mtimeMs + 1_000);
    fs.utimesSync(file, moved, moved);

    expect(hasAnthropicLogin()).toBe(true);
  });

  it("does not throw on a config that is not JSON at all", () => {
    fs.writeFileSync(path.join(home, ".claude.json"), "{{{ not json");
    expect(hasAnthropicLogin()).toBe(false);
  });
});

describe("the stored key", () => {
  it("accepts a real-shaped key and refuses everything else", () => {
    expect(looksLikeAnthropicKey(KEY)).toBe(true);
    expect(looksLikeAnthropicKey("hunter2")).toBe(false);
    expect(looksLikeAnthropicKey("sk-ant-short")).toBe(false);
    // Whitespace would break the header it ends up in.
    expect(looksLikeAnthropicKey(`sk-ant-api03 ${"x".repeat(40)}`)).toBe(false);
  });

  it("refuses a key past the cap — the helper's own bound, not the route's", async () => {
    // The route rejects an oversized body before `setAnthropicKey` is reached,
    // so its boundary test would still pass if this bound were lost. Checked
    // here, where the helper is the only thing standing between the value and
    // the store.
    const atCap = `sk-ant-${"x".repeat(MAX_ANTHROPIC_KEY_CHARS - "sk-ant-".length)}`;
    expect(atCap.length).toBe(MAX_ANTHROPIC_KEY_CHARS);
    expect(looksLikeAnthropicKey(atCap)).toBe(true);
    expect(looksLikeAnthropicKey(`${atCap}x`)).toBe(false);
    await expect(setAnthropicKey(`${atCap}x`)).rejects.toThrow();
    expect(pool.addApiKeyAccount).not.toHaveBeenCalled();
    expect(pool.replaceCredential).not.toHaveBeenCalled();
  });

  it("stores a trimmed key as the FIRST account, and never in data/config.json", async () => {
    await setAnthropicKey(`  ${KEY}  `);
    // First in the order: the key this form saved has always been the one runs used.
    expect(pool.addApiKeyAccount).toHaveBeenCalledWith({ key: KEY, first: true });
    expect(configSet).not.toHaveBeenCalled();
    pool.addApiKeyAccount.mockClear();
    await expect(setAnthropicKey("hunter2")).rejects.toThrow(/sk-ant-/);
    expect(pool.addApiKeyAccount).not.toHaveBeenCalled();
  });

  it("replaces the key of an existing key account rather than adding a second one", async () => {
    pool.readAccounts.mockResolvedValue([{ id: "11111111", kind: "login" }, { id: "22222222", kind: "api_key" }]);
    await setAnthropicKey(KEY);
    expect(pool.replaceCredential).toHaveBeenCalledWith("22222222", { kind: "api_key", key: KEY });
    expect(pool.addApiKeyAccount).not.toHaveBeenCalled();
  });

  it("knows whether a key account exists", async () => {
    expect(await hasAnthropicKey()).toBe(false);
    pool.readAccounts.mockResolvedValue([{ id: "22222222", kind: "api_key" }]);
    expect(await hasAnthropicKey()).toBe(true);
  });

  it("clears by removing the key account — and never the owner's own sign-in", async () => {
    pool.readAccounts.mockResolvedValue([{ id: "11111111", kind: "login" }, { id: "22222222", kind: "api_key" }]);
    await clearAnthropicKey();
    expect(pool.removeAccount).toHaveBeenCalledWith("22222222");
    expect(pool.removeAccount).toHaveBeenCalledTimes(1);
    pool.removeAccount.mockClear();
    pool.readAccounts.mockResolvedValue([{ id: "11111111", kind: "login" }]);
    await clearAnthropicKey();
    expect(pool.removeAccount).not.toHaveBeenCalled();
  });
});

describe("the connection, as a whole", () => {
  it("names the kind of the account a run would use now", async () => {
    pool.poolHasCredential.mockResolvedValue({ any: true, hasKey: true, hasLogin: true, hasOAuth: false, first: "api_key" });
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "o@e.com" } }));
    expect(await getAnthropicConnection()).toEqual({ connected: true, hasKey: true, hasLogin: true, source: "key" });
    pool.poolHasCredential.mockResolvedValue({ any: true, hasKey: false, hasLogin: false, hasOAuth: true, first: "oauth" });
    expect((await getAnthropicConnection()).source).toBe("oauth");
  });

  it("is not connected when there is neither", async () => {
    expect(await getAnthropicConnection()).toEqual({ connected: false, hasKey: false, hasLogin: false, source: null });
  });

  it("still reports a sign-in that is plainly there when the pool cannot be read", async () => {
    pool.poolHasCredential.mockRejectedValue(new Error("store unreadable"));
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "o@e.com" } }));
    expect(await getAnthropicConnection()).toEqual({ connected: true, hasKey: false, hasLogin: true, source: "login" });
  });
});

describe("checking a key against Anthropic", () => {
  it("is 'ok' when the account answers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 200 })));
    expect(await verifyAnthropicKey(KEY)).toBe("ok");
  });

  it("is 'rejected' only for a credential refusal", async () => {
    for (const status of [401, 403]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
      expect(await verifyAnthropicKey(KEY)).toBe("rejected");
    }
  });

  it("is 'unreachable' for anything else, so an offline box can still save a key", async () => {
    // 429 and 500 say nothing about whether the credential is good, and this
    // appliance is regularly behind a captive portal.
    for (const status of [429, 500, 502]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status })));
      expect(await verifyAnthropicKey(KEY)).toBe("unreachable");
    }
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ENOTFOUND")));
    expect(await verifyAnthropicKey(KEY)).toBe("unreachable");
  });
});
