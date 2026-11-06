import { describe, expect, it } from "vitest";
import { createRequire } from "module";
import {
  chatKeyUser,
  defaultTranscriptKeyFor,
  hermesUserMainKey,
  isUserChatKey,
  mainChatKeyFor,
  mayUseChatKey,
  openclawUserMainKey,
  userTabKeyFor,
} from "@/lib/chat-scope";
import { isChatTabKey, isOwnerChatTabKey } from "@/lib/chat-tabs";

// Every ClawBox user's chat is a set of session keys only they may use: their
// own main conversation and tabs, never the owner's, never each other's. The
// gateway relay (production-server.js) is CommonJS and keeps its own copy of
// the OpenClaw half, so both copies are run over the same table here.

const requireCjs = createRequire(import.meta.url);
const cjs = requireCjs("../../../scripts/chat-scope.js") as {
  agentIdOfKey(key: string): string;
  openclawUserMainKey(main: string, username: string): string;
  chatKeyUser(key: unknown): string | null;
  userMayUseKey(username: string, key: unknown): boolean;
};

const OWNER = { username: "clawbox", isOwner: true };
const ALICE = { username: "alice", isOwner: false };
const BOB = { username: "bob", isOwner: false };

describe("per-user main session keys", () => {
  it("gives each user their own main conversation under the gateway's agent", () => {
    expect(openclawUserMainKey("agent:main:main", "alice")).toBe("agent:main:clawbox-user-alice");
    expect(openclawUserMainKey("agent:roboclaw:main", "alice")).toBe("agent:roboclaw:clawbox-user-alice");
    expect(openclawUserMainKey("main", "alice")).toBe("agent:main:clawbox-user-alice");
    expect(hermesUserMainKey("alice")).toBe("desktop-user-alice");
  });

  it("keeps the owner on the harness's own main, and never hands a user the owner's", () => {
    expect(mainChatKeyFor(OWNER, "agent:main:main")).toBe("agent:main:main");
    expect(mainChatKeyFor(ALICE, "agent:main:main")).toBe("agent:main:clawbox-user-alice");
    expect(mainChatKeyFor(OWNER, "desktop")).toBe("desktop");
    expect(mainChatKeyFor(ALICE, "desktop")).toBe("desktop-user-alice");
    expect(defaultTranscriptKeyFor(null)).toBe("desktop");
    expect(defaultTranscriptKeyFor(OWNER)).toBe("desktop");
    expect(defaultTranscriptKeyFor(ALICE)).toBe("desktop-user-alice");
  });

  it("refuses to mint a key for something that is not a username", () => {
    expect(() => openclawUserMainKey("agent:main:main", "Alice")).toThrow();
    expect(() => openclawUserMainKey("agent:main:main", "a:b")).toThrow();
    expect(() => hermesUserMainKey("../etc")).toThrow();
  });
});

describe("tabs beside a user's main", () => {
  const id = "0123456789ab";

  it("are the user's own, in both harnesses", () => {
    const openclaw = userTabKeyFor("agent:main:clawbox-user-alice", id);
    const hermes = userTabKeyFor("desktop-user-alice", id);
    expect(openclaw).toBe(`agent:main:clawbox-utab-${id}-alice`);
    expect(hermes).toBe(`desktop-utab-${id}-alice`);
    expect(chatKeyUser(openclaw)).toBe("alice");
    expect(chatKeyUser(hermes)).toBe("alice");
    expect(isChatTabKey(openclaw)).toBe(true);
    expect(isChatTabKey(hermes)).toBe(true);
    // …and never an owner's tab shape.
    expect(isOwnerChatTabKey(openclaw)).toBe(false);
    expect(isOwnerChatTabKey(hermes)).toBe(false);
  });

  it("are not minted beside the owner's main (the adapters mint the owner's shapes)", () => {
    expect(userTabKeyFor("agent:main:main", id)).toBeNull();
    expect(userTabKeyFor("desktop", id)).toBeNull();
    expect(userTabKeyFor("agent:main:clawbox-user-alice", "not-hex")).toBeNull();
  });

  it("name exactly one user even when a username contains '-' and hex", () => {
    // `bob-0123456789ab` is a valid username; with the id first, bob's tab
    // can never be that user's main key, nor the other way round.
    const bobTab = userTabKeyFor("agent:main:clawbox-user-bob", id)!;
    const trickyMain = openclawUserMainKey("agent:main:main", `bob-${id}`);
    expect(bobTab).not.toBe(trickyMain);
    expect(chatKeyUser(bobTab)).toBe("bob");
    expect(chatKeyUser(trickyMain)).toBe(`bob-${id}`);
  });
});

describe("who may use a key", () => {
  const table: Array<[string, string | null]> = [
    ["agent:main:main", null],
    ["main", null],
    ["desktop", null],
    ["agent:main:clawbox-0123456789ab", null],
    ["desktop-0123456789ab", null],
    ["agent:main:telegram:direct:42", null],
    ["agent:main:clawbox-user-alice", "alice"],
    ["AGENT:MAIN:CLAWBOX-USER-ALICE", "alice"],
    ["agent:main:clawbox-utab-0123456789ab-alice", "alice"],
    ["desktop-user-alice", "alice"],
    ["desktop-utab-0123456789ab-alice", "alice"],
    ["agent:main:clawbox-user-bob", "bob"],
    ["agent:main:clawbox-user-", null],
    ["agent:main:clawbox-user-Alice!", null],
  ];

  it.each(table)("%s belongs to %s", (key, user) => {
    expect(chatKeyUser(key)).toBe(user);
    expect(isUserChatKey(key)).toBe(user !== null);
  });

  it("lets a user reach their own keys and nobody else's", () => {
    expect(mayUseChatKey(ALICE, "agent:main:clawbox-user-alice")).toBe(true);
    expect(mayUseChatKey(ALICE, "desktop-utab-0123456789ab-alice")).toBe(true);
    expect(mayUseChatKey(ALICE, "agent:main:main")).toBe(false);
    expect(mayUseChatKey(ALICE, "desktop")).toBe(false);
    expect(mayUseChatKey(ALICE, "agent:main:clawbox-0123456789ab")).toBe(false);
    expect(mayUseChatKey(ALICE, "agent:main:clawbox-user-bob")).toBe(false);
    expect(mayUseChatKey(BOB, "agent:main:clawbox-user-alice")).toBe(false);
    expect(mayUseChatKey(ALICE, "")).toBe(false);
    expect(mayUseChatKey(ALICE, undefined)).toBe(false);
  });

  it("lets the owner reach their own and the box's sessions, never a user's", () => {
    expect(mayUseChatKey(OWNER, "agent:main:main")).toBe(true);
    expect(mayUseChatKey(OWNER, "desktop-0123456789ab")).toBe(true);
    expect(mayUseChatKey(OWNER, "agent:main:clawbox-user-alice")).toBe(false);
    expect(mayUseChatKey(OWNER, "desktop-user-alice")).toBe(false);
  });

  it("is the same rule in the relay's CommonJS copy", () => {
    for (const [key, user] of table) {
      if (key.startsWith("desktop")) continue; // the relay is the OpenClaw socket only
      expect(cjs.chatKeyUser(key), key).toBe(user);
      expect(cjs.userMayUseKey("alice", key), key).toBe(user === "alice");
    }
    expect(cjs.openclawUserMainKey("agent:roboclaw:main", "alice")).toBe(openclawUserMainKey("agent:roboclaw:main", "alice"));
    expect(cjs.agentIdOfKey("agent:Roboclaw:main")).toBe("roboclaw");
    expect(() => cjs.openclawUserMainKey("agent:main:main", "a:b")).toThrow();
  });
});
