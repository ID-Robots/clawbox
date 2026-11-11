import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A member of staff's Hermes turn on an organisation box (TASK-2444,
 * TASK-2445): it runs on their own profile (`profile` on the dashboard's
 * session, `-p` on the CLI), in their own folder, with every approval answered
 * `deny`, on the box's model whatever the composer names — and a command other
 * than /new and /reasoning is refused before anything is recorded or run. The
 * owner's turns are exactly as before.
 */

const openTurnMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const appendMock = vi.hoisted(() => vi.fn());
const slashMock = vi.hoisted(() => vi.fn());
const memberMock = vi.hoisted(() => vi.fn());
const profileMock = vi.hoisted(() => vi.fn());
/** Whose state.db each turn's reads were scoped to (undefined: the box's own). */
const stateHomes = vi.hoisted(() => [] as Array<string | null | undefined>);

vi.mock("@/lib/hermes-dashboard-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-dashboard-turn")>()),
  openDashboardTurn: openTurnMock,
}));
vi.mock("@/lib/hermes-slash-exec", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-slash-exec")>()),
  runHermesSlashCommand: slashMock,
}));
vi.mock("child_process", () => ({ spawn: spawnMock }));
vi.mock("@/lib/harness/transcript-store", () => ({ appendTranscript: appendMock }));
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
}));
const guardLoadedMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/hermes-staff-profile", () => ({ ensureStaffHermesProfile: profileMock, staffGuardLoaded: guardLoadedMock }));
vi.mock("@/lib/chat-scope-server", () => ({
  transcriptKeyFor: vi.fn(async () => ({ ok: true, key: "desktop-user-maria", principal: { username: "maria", isOwner: false } })),
  hermesSessionFor: vi.fn((_who: unknown, id: string) => id),
  noteHermesSession: vi.fn(),
}));

import { POST } from "@/app/setup-api/hermes/chat/route";

const STAFF = { profile: "clawbox-staff-maria", home: "/h/.hermes/profiles/clawbox-staff-maria", folder: "/h/.hermes/profiles/clawbox-staff-maria/workspace" };

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
  memberMock.mockReset();
  profileMock.mockReset();
  memberMock.mockResolvedValue({ username: "maria" });
  profileMock.mockResolvedValue(STAFF);
  stateHomes.length = 0;
  guardLoadedMock.mockReset();
  guardLoadedMock.mockResolvedValue(true);
  openTurnMock.mockResolvedValue(fakeTurn());
  slashMock.mockResolvedValue({ output: "ok", sessionId: "20261111_100000_abcdef", sessionModel: "", sessionProvider: "" });
});

describe("a member of staff's command", () => {
  it.each(["/model gpt-5", "/config set tools.profile full", "/restart", "/cron list", "/skills install x", "/new gpt-5", "! ls"])(
    "%j is refused before it is recorded or run",
    async (message) => {
      const res = await POST(post({ message }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("staff_command_refused");
      expect(appendMock).not.toHaveBeenCalled();
      expect(openTurnMock).not.toHaveBeenCalled();
      expect(slashMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("/reasoning runs on their own profile", async () => {
    const res = await POST(post({ message: "/reasoning high" }));
    expect(res.status).toBe(200);
    expect(slashMock).toHaveBeenCalledWith(expect.objectContaining({ command: "/reasoning high", profile: "clawbox-staff-maria" }));
  });
});

describe("a member of staff's turn", () => {
  it("runs on their own profile and folder, denies every approval, and takes the box's model", async () => {
    const res = await POST(post({ message: "What does clause 4 of the attached contract say?", model: "claude-opus", provider: "anthropic" }));
    expect(res.status).toBe(200);
    expect(openTurnMock).toHaveBeenCalledTimes(1);
    const req = openTurnMock.mock.calls[0][0];
    expect(req).toMatchObject({ profile: "clawbox-staff-maria", cwd: STAFF.folder, denyApprovals: true });
    // The turn's record and billing are read from their profile's own store.
    expect(stateHomes).toEqual([STAFF.home]);
    expect(req.model).toBeUndefined();
    expect(req.provider).toBeUndefined();
  });

  it("falls back to the CLI on their own profile too", async () => {
    openTurnMock.mockResolvedValue(null);
    spawnMock.mockImplementation(() => {
      throw new Error("spawn stops here");
    });
    await POST(post({ message: "hello" })).catch(() => undefined);
    expect(spawnMock).toHaveBeenCalled();
    const argv = spawnMock.mock.calls[0][1] as string[];
    expect(argv.slice(0, 2)).toEqual(["--profile=clawbox-staff-maria", "chat"]);
  });

  it("is refused, fail closed, while the running dashboard has not loaded the staff guard", async () => {
    guardLoadedMock.mockResolvedValue(false);
    const res = await POST(post({ message: "hello" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("staff_profile_unavailable");
    expect(openTurnMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("runs on the CLI's fresh plugins when the dashboard cannot say what it loaded", async () => {
    guardLoadedMock.mockResolvedValue(null);
    const res = await POST(post({ message: "hello" }));
    expect(res.status).toBe(200);
  });

  it("is refused, fail closed, when their profile cannot be prepared", async () => {
    profileMock.mockResolvedValue(null);
    const res = await POST(post({ message: "hello" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("staff_profile_unavailable");
    expect(openTurnMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("a box whose organisation switch cannot be read", () => {
  it("refuses a non-owner's turn rather than run it on the owner's profile", async () => {
    memberMock.mockResolvedValue("unknown");
    const res = await POST(post({ message: "hello" }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe("org_mode_unknown");
    expect(appendMock).not.toHaveBeenCalled();
    expect(openTurnMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("the owner (and a home box's user)", () => {
  beforeEach(() => {
    memberMock.mockResolvedValue(null);
  });

  it("keeps every command and runs on the launch profile", async () => {
    await POST(post({ message: "/model gpt-5" }));
    expect(slashMock).toHaveBeenCalledTimes(1);
    expect(slashMock.mock.calls[0][0].profile).toBeUndefined();
    expect(profileMock).not.toHaveBeenCalled();
  });

  it("keeps the model they pick and the approvals the box answers", async () => {
    await POST(post({ message: "hello", model: "claude-opus", provider: "anthropic" }));
    const req = openTurnMock.mock.calls[0][0];
    expect(req.profile).toBeUndefined();
    expect(req.denyApprovals).toBeUndefined();
    expect(stateHomes.every((h) => h == null)).toBe(true);
    expect(req.model).toBe("claude-opus");
  });
});
