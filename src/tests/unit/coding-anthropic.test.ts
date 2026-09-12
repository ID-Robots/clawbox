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

import {
  clearAnthropicKey,
  getAnthropicConnection,
  getAnthropicKey,
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

  it("stores a trimmed key and refuses one that is not a key", async () => {
    await setAnthropicKey(`  ${KEY}  `);
    expect(configSet).toHaveBeenCalledWith("anthropic_api_key", KEY);
    configSet.mockClear();
    await expect(setAnthropicKey("hunter2")).rejects.toThrow(/sk-ant-/);
    expect(configSet).not.toHaveBeenCalled();
  });

  it("reads an absent or blank value as no key at all", async () => {
    expect(await getAnthropicKey()).toBeNull();
    configGet.mockResolvedValue("   ");
    expect(await getAnthropicKey()).toBeNull();
    configGet.mockResolvedValue(7);
    expect(await getAnthropicKey()).toBeNull();
  });

  it("clears by deleting the key, not by storing an empty string", async () => {
    await clearAnthropicKey();
    expect(configSet).toHaveBeenCalledWith("anthropic_api_key", undefined);
  });
});

describe("the connection, as a whole", () => {
  it("prefers the key over a login, because that is what the wrapper exports", async () => {
    configGet.mockResolvedValue(KEY);
    fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "o@e.com" } }));
    expect(await getAnthropicConnection()).toEqual({ connected: true, hasKey: true, hasLogin: true, source: "key" });
  });

  it("is not connected when there is neither", async () => {
    expect(await getAnthropicConnection()).toEqual({ connected: false, hasKey: false, hasLogin: false, source: null });
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
