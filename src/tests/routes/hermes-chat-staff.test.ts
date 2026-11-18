import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mediaUrl } from "@/lib/chat-media";

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
  clearMock.mockReset();
  clearMock.mockResolvedValue(undefined);
  memberMock.mockReset();
  profileMock.mockReset();
  memberMock.mockResolvedValue({ username: "maria" });
  profileMock.mockResolvedValue(STAFF);
  stateHomes.length = 0;
  org.on = false;
  recordReplyMock.mockReset();
  owned.clear();
  recordReplyMock.mockReturnValue({ recorded: [], refused: [] });
  guardLoadedMock.mockReset();
  guardLoadedMock.mockResolvedValue(true);
  openTurnMock.mockResolvedValue(fakeTurn());
  slashMock.mockResolvedValue({ output: "ok", sessionId: "20261111_100000_abcdef", sessionModel: "", sessionProvider: "" });
});

describe("a member of staff's command", () => {
  it.each(["/model gpt-5", "/config set tools.profile full", "/restart", "/cron list", "/skills install x", "/new gpt-5", "/new hello there", "/reset", "/reset hello", "! ls"])(
    "%j is refused before it is recorded or run",
    async (message) => {
      const res = await POST(post({ message }));
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("staff_command_refused");
      // …and before anything of theirs is cleared (TASK-2520: /new and /reset
      // start a fresh session, but only the command they may send).
      expect(clearMock).not.toHaveBeenCalled();
      expect(appendMock).not.toHaveBeenCalled();
      expect(openTurnMock).not.toHaveBeenCalled();
      expect(slashMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("/new starts a fresh session of their own conversation", async () => {
    const res = await POST(post({ message: "/new", sessionId: "20261111_100000_abcdef" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "New session started.", harness: "hermes", freshSession: true });
    expect(clearMock.mock.calls).toEqual([["desktop-user-maria"]]);
    expect(slashMock).not.toHaveBeenCalled();
  });

  it("/new is refused like any turn of theirs while their profile is not ready, and clears nothing", async () => {
    profileMock.mockResolvedValue(null);
    const res = await POST(post({ message: "/new" }));
    expect(res.status).toBe(503);
    expect(clearMock).not.toHaveBeenCalled();
  });

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

describe("a member of staff's reply naming files of their own (TASK-2516)", () => {
  it("is recorded as written; a picture keeps its card only when it is theirs, and a document's card is in the transcript too", async () => {
    const own = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "staff-own-"));
    try {
      const chart = path.join(own, "chart.png");
      const stale = path.join(own, "old.png");
      const doc = path.join(own, "report.docx");
      const oldDoc = path.join(own, "old.docx");
      const oldChart = path.join(own, "last-week.png");
      const elsewhere = path.join(own, "..", `${path.basename(own)}-elsewhere.docx`);
      for (const file of [chart, stale, doc, oldDoc, oldChart, elsewhere]) fs.writeFileSync(file, "x");
      org.on = true;
      org.folder = own;
      // The recorder's verdict: the chart and the document are this turn's, the old picture is not.
      // An earlier turn's document is theirs already; a file outside their folders never is.
      recordReplyMock.mockImplementation(() => {
        owned.add(chart);
        owned.add(doc);
        return { recorded: [chart, doc], refused: [{ path: stale, reason: "not_this_turn" }, { path: oldDoc, reason: "not_this_turn" }, { path: oldChart, reason: "not_this_turn" }] };
      });
      owned.add(oldDoc);
      owned.add(oldChart); // a picture of theirs from an earlier turn
      owned.add(path.resolve(elsewhere));
      openTurnMock.mockResolvedValue({
        ...fakeTurn(),
        async run() {
          return {
            text: `Here they are.\nMEDIA:${chart}\nMEDIA:${stale}\nMEDIA:${doc}\nMEDIA:${oldDoc}\nMEDIA:${oldChart}\nMEDIA:${elsewhere}\nMEDIA:notes/plan.docx\nMEDIA:https://example.com/brief.pdf\n\`\`\`\nMEDIA:${elsewhere}\n\`\`\``,
            reasoning: "",
            status: "complete",
          };
        },
      });
      const res = await POST(post({ message: "Draw the chart and write the report." }));
      expect(res.status).toBe(200);
      // Judged on the reply AS WRITTEN — its picture lines too, which the caption loses.
      expect(recordReplyMock).toHaveBeenCalledWith(expect.objectContaining({ username: "maria", ownFolder: own, text: expect.stringContaining(`MEDIA:${chart}`) }));
      const { text } = await res.json();
      expect(text).toContain(`MEDIA:${chart}`);
      expect(text).toContain(`MEDIA:${doc}`);
      expect(text).toContain(`MEDIA:${oldDoc}`); // theirs from before: still served
      expect(text).toContain(`MEDIA:${oldChart}`); // …a picture too, though reclaiming took its line
      expect(text).toContain("MEDIA:https://example.com/brief.pdf"); // not a file of this box
      // No card that would be a 404: a picture not recorded, a file outside
      // their folders (named in fenced code it stays text), a relative path.
      expect(text).not.toContain(stale);
      expect(text).not.toContain("MEDIA:notes/plan.docx");
      expect(text.split(`MEDIA:${elsewhere}`)).toHaveLength(2);
      expect(text).toContain(`\`\`\`\nMEDIA:${elsewhere}\n\`\`\``);
      const stored = appendMock.mock.calls.map((call) => call[0]).find((r) => r.role === "assistant");
      expect(stored.media).toEqual([mediaUrl(chart), mediaUrl(oldChart)]);
      expect(stored.files).toEqual([mediaUrl(doc), mediaUrl(oldDoc), mediaUrl("https://example.com/brief.pdf")]);
    } finally {
      fs.rmSync(own, { recursive: true, force: true });
    }
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
