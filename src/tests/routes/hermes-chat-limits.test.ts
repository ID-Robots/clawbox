import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TASK-2446 — the Hermes chat route holds every ClawBox user who is not the
 * owner to the owner's chat limits, counted on the same counter as the
 * OpenClaw relay (scripts/user-limits.js): a turn past the limit is answered
 * 429 `rate_limited` with the wait, before any profile, transcript or model is
 * touched. The owner is never counted; a bare /new is not a turn.
 */

/** Who the turn is from, and the owner's limits for everyone else. */
const who = vi.hoisted(() => ({
  key: "desktop-user-ivan",
  principal: { username: "ivan", isOwner: false } as { username: string; isOwner: boolean },
  limits: { uploadMaxMb: 100, homeQuotaMb: 10240, chatPerMinute: 2, chatPerHour: 0 },
}));
vi.mock("@/lib/user-limits-server", () => ({ readUserLimits: vi.fn(async () => who.limits) }));

const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const slashMock = vi.hoisted(() => vi.fn());
const clearMock = vi.hoisted(() => vi.fn());
const memberMock = vi.hoisted(() => vi.fn());
const profileMock = vi.hoisted(() => vi.fn());
/** Whose state.db each turn's reads were scoped to (undefined: the box's own). */
const stateHomes = vi.hoisted(() => [] as Array<string | null | undefined>);
/** The organisation switch as `readOrgMode` reads it, and the member's own profile folder. */
const org = vi.hoisted(() => ({ on: false, folder: "/h/.hermes/profiles/clawbox-staff-maria/workspace" }));
const recordReplyMock = vi.hoisted(() => vi.fn());
/** Real paths recorded as the member's (src/lib/chat-media-owners.ts). */
const owned = vi.hoisted(() => new Set<string>());

vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
vi.mock("@/lib/hermes-slash-exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-slash-exec")>()),
  runHermesSlashCommand: slashMock,
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock, clearTranscript: clearMock }));
vi.mock("@/lib/harness/hermes-turn-record", () => ({
  withHermesStateHome: (home: string | null | undefined, fn: () => unknown) => {
    stateHomes.push(home);
    return fn();
  },
  readHermesTurn: vi.fn(async () => null),
  readHermesUsageMarks: async () => new Set<string>(),
  readHermesBillingProvider: vi.fn(async () => ""),
}));
vi.mock("@/lib/harness/media-root", () => ({
  resolveInMediaRoot: vi.fn(async (p: string) => p),
  chatMediaRoot: vi.fn(async () => `/tmp/clawbox-staff-media-${process.pid}`),
}));
vi.mock("@/lib/hermes-model-options", () => ({
  getModelOptions: vi.fn(async () => null),
  cachedModelOptions: vi.fn(() => null),
  readCurrentFromCli: vi.fn(async () => ({ provider: "", model: "", reasoning: "" })),
  isAllowedProvider: vi.fn(() => true),
  isPairAllowed: vi.fn(() => true),
  shouldEnforcePairing: vi.fn(() => false),
}));
vi.mock("@/lib/org-mode-server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/org-mode-server")>()),
  orgMemberStrictOf: memberMock,
  readOrgMode: vi.fn(async () => org.on),
}));
vi.mock("@/lib/chat-media-owners", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-media-owners")>()),
  recordMediaOwner: vi.fn(),
  isMediaOwnedBy: vi.fn((username: string, real: string) => username === "maria" && owned.has(real)),
}));
vi.mock("@/lib/chat-reply-media", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chat-reply-media")>()),
  recordMemberReplyMedia: recordReplyMock,
}));
const guardLoadedMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-staff-profile", () => ({
  ensureStaffHermesProfile: profileMock,
  staffGuardLoaded: guardLoadedMock,
  staffHermesProfilePaths: vi.fn(() => ({ folder: org.folder })),
}));
vi.mock("@/lib/chat-scope-server", () => ({
  transcriptKeyFor: vi.fn(async () => ({ ok: true, key: who.key, principal: who.principal })),
  hermesSessionFor: vi.fn((_who: unknown, id: string) => id),
  noteHermesSession: vi.fn(),
}));

import { POST } from "@/app/setup-api/hermes/chat/route";
import { forgetChatRequests } from "@/lib/user-limits";

function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/setup-api/hermes/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

function fakeTurn() {
  return {
    sessionId: "20261111_100000_abcdef",
    model: "",
    provider: "",
    async run() {
      return { text: "Hello.", reasoning: "", status: "complete" };
    },
    close() {},
  };
}

beforeEach(() => {
  openTurnMock.mockReset();
  spawnMock.mockReset();
  appendMock.mockReset();
  slashMock.mockReset();
  clearMock.mockReset();
  clearMock.mockResolvedValue(undefined);
  // A home box: the user's turn runs on the box's own profile, in their own conversation.
  memberMock.mockReset();
  memberMock.mockResolvedValue(null);
  profileMock.mockReset();
  guardLoadedMock.mockReset();
  guardLoadedMock.mockResolvedValue(true);
  recordReplyMock.mockReset();
  recordReplyMock.mockReturnValue({ recorded: [], refused: [] });
  openTurnMock.mockResolvedValue(fakeTurn());
  who.key = "desktop-user-ivan";
  who.principal = { username: "ivan", isOwner: false };
  who.limits = { uploadMaxMb: 100, homeQuotaMb: 10240, chatPerMinute: 2, chatPerHour: 0 };
});

afterEach(() => forgetChatRequests());

describe("chat limits on the Hermes route", () => {
  it("runs a user's turns up to the limit, then answers 429 with the wait and runs nothing", async () => {
    expect((await POST(post({ message: "one" }))).status).toBe(200);
    expect((await POST(post({ message: "two" }))).status).toBe(200);
    expect(openTurnMock).toHaveBeenCalledTimes(2);
    appendMock.mockClear();
    const res = await POST(post({ message: "three" }));
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("retry-after"));
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
    expect(body.retryAfterSeconds).toBe(retry);
    expect(body.error).toBe(`You have reached your chat limit on this ClawBox: 2 messages a minute. Try again in ${retry} ${retry === 1 ? "second" : "seconds"}.`);
    expect(openTurnMock).toHaveBeenCalledTimes(2);
    expect(appendMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("counts each user on their own", async () => {
    who.limits = { ...who.limits, chatPerMinute: 1 };
    expect((await POST(post({ message: "ivan's" }))).status).toBe(200);
    expect((await POST(post({ message: "ivan's again" }))).status).toBe(429);
    who.key = "desktop-user-maria";
    who.principal = { username: "maria", isOwner: false };
    expect((await POST(post({ message: "maria's" }))).status).toBe(200);
  });

  it("never counts the owner", async () => {
    who.key = "desktop";
    who.principal = { username: "clawbox", isOwner: true };
    who.limits = { ...who.limits, chatPerMinute: 1 };
    for (let i = 0; i < 4; i++) expect((await POST(post({ message: `turn ${i}` }))).status).toBe(200);
  });

  it("does not count a typed /new with words either: the words come back as a turn of their own", async () => {
    who.limits = { ...who.limits, chatPerMinute: 1 };
    expect((await POST(post({ message: "/new what is on today?" }))).status).toBe(200);
    expect((await POST(post({ message: "what is on today?" }))).status).toBe(200);
    expect((await POST(post({ message: "and tomorrow?" }))).status).toBe(429);
  });

  it("counts a /new that names a file, even an empty entry: that is a turn of the model's", async () => {
    who.limits = { ...who.limits, chatPerMinute: 1 };
    expect((await POST(post({ message: "first" }))).status).toBe(200);
    const res = await POST(post({ message: "/new", documentPaths: [null] }));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("rate_limited");
  });

  it("does not count a bare /new, and admits everything when the owner turned the limits off", async () => {
    who.limits = { ...who.limits, chatPerMinute: 1 };
    expect((await POST(post({ message: "/new" }))).status).toBe(200);
    expect((await POST(post({ message: "first real turn" }))).status).toBe(200);
    expect((await POST(post({ message: "second" }))).status).toBe(429);
    who.limits = { ...who.limits, chatPerMinute: 0, chatPerHour: 0 };
    expect((await POST(post({ message: "unlimited" }))).status).toBe(200);
  });
});
