/**
 * /setup-api/project-backup — the Files app's GitHub backup (TASK-1358).
 * The backup itself is pinned with real git in
 * src/tests/unit/project-backup.test.ts; this holds the HTTP shape: who may
 * call it (the owner's cookie, and only from the box's own pages for a
 * write), what is validated before anything runs, and how a refusal travels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const m = vi.hoisted(() => ({
  identity: null as null | { username: string; isOwner: boolean },
  sameOrigin: true,
  backUpNow: vi.fn(),
  backupOverview: vi.fn(),
  disconnectFolder: vi.fn(),
  firstBackup: vi.fn(),
  folderBackupStatus: vi.fn(),
  runningStage: vi.fn(),
  setAutoBackup: vi.fn(),
  dismissSuggestion: vi.fn(),
}));

vi.mock("@/lib/route-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-auth")>();
  return { ...actual, sessionIdentity: async () => m.identity };
});
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: () => m.sameOrigin }));
vi.mock("@/lib/project-backup", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-backup")>();
  return {
    ProjectBackupError: actual.ProjectBackupError,
    backUpNow: m.backUpNow,
    backupOverview: m.backupOverview,
    disconnectFolder: m.disconnectFolder,
    firstBackup: m.firstBackup,
    folderBackupStatus: m.folderBackupStatus,
    runningStage: m.runningStage,
    setAutoBackup: m.setAutoBackup,
  };
});
vi.mock("@/lib/project-backup-store", () => ({ dismissSuggestion: m.dismissSuggestion }));

import { GET, POST } from "@/app/setup-api/project-backup/route";
import { ProjectBackupError } from "@/lib/project-backup";

const OWNER = { username: "clawbox", isOwner: true };
const OTHER = { username: "maria", isOwner: false };

const get = (query = "") => new NextRequest(new URL(`http://localhost/setup-api/project-backup${query}`));
const post = (body: unknown) =>
  new NextRequest(new URL("http://localhost/setup-api/project-backup"), {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

const everyAction = () => [m.backUpNow, m.backupOverview, m.disconnectFolder, m.firstBackup, m.folderBackupStatus, m.runningStage, m.setAutoBackup, m.dismissSuggestion];

beforeEach(() => {
  m.identity = OWNER;
  m.sameOrigin = true;
  m.backupOverview.mockResolvedValue({ github: { installed: true, connected: false, login: null }, folders: [], suggestionDismissedAt: null });
  m.folderBackupStatus.mockResolvedValue({ state: "not_set_up" });
  m.runningStage.mockReturnValue(null);
  m.firstBackup.mockResolvedValue({ ok: true, nothingChanged: false, files: 3, commit: "abc1234", leftOut: [], repo: "me/site" });
  m.backUpNow.mockResolvedValue({ ok: true, nothingChanged: true, files: 0, commit: null, leftOut: [] });
  m.setAutoBackup.mockResolvedValue({ auto: true });
  m.disconnectFolder.mockResolvedValue({ removedRemote: true });
  m.dismissSuggestion.mockResolvedValue(1234);
});

describe("who may call it", () => {
  it("answers a request without the owner's session 401, and runs nothing — the agent's bearer is not a session", async () => {
    m.identity = null;
    expect((await GET(get())).status).toBe(401);
    const res = await POST(post({ action: "backup_now", path: "projects/site" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "unauthenticated" });
    for (const fn of everyAction()) expect(fn).not.toHaveBeenCalled();
  });

  it("answers another ClawBox user 403 owner_only, read or write — this is the owner's GitHub login", async () => {
    m.identity = OTHER;
    const read = await GET(get("?path=projects/site"));
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({ code: "owner_only" });
    const write = await POST(post({ action: "first_backup", path: "projects/site" }));
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: "owner_only" });
    for (const fn of everyAction()) expect(fn).not.toHaveBeenCalled();
  });

  it("refuses a write fired from another site's page, even with the owner's cookie", async () => {
    m.sameOrigin = false;
    const res = await POST(post({ action: "first_backup", path: "projects/site" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "cross_origin" });
    expect(m.firstBackup).not.toHaveBeenCalled();
  });

  it("lets the owner read from anywhere the session works (a read changes nothing)", async () => {
    m.sameOrigin = false;
    expect((await GET(get())).status).toBe(200);
  });
});

describe("reading", () => {
  it("GET is the overview the Projects list reads", async () => {
    const res = await GET(get());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ github: { connected: false }, folders: [] });
    expect(m.backupOverview).toHaveBeenCalledOnce();
  });

  it("GET ?path= is one folder's state", async () => {
    await GET(get("?path=projects%2Fsite"));
    expect(m.folderBackupStatus).toHaveBeenCalledWith("projects/site");
  });

  it("GET ?path=&stage=1 is the progress line's poll, which never asks GitHub", async () => {
    m.runningStage.mockReturnValue("uploading");
    const res = await GET(get("?path=projects%2Fsite&stage=1"));
    expect(await res.json()).toEqual({ running: "uploading" });
    expect(m.folderBackupStatus).not.toHaveBeenCalled();
    expect(m.backupOverview).not.toHaveBeenCalled();
  });

  it("passes a refusal on with its status and code", async () => {
    m.folderBackupStatus.mockRejectedValue(new ProjectBackupError("protected", "no"));
    const res = await GET(get("?path=clawbox%2Fdata"));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "protected" });
  });
});

describe("writing", () => {
  it("refuses a body that is not a JSON object, and an action it does not know, before anything runs", async () => {
    for (const body of ["not json", "[1,2]", "null"]) {
      const res = await POST(post(body));
      expect(res.status, body).toBe(400);
    }
    const res = await POST(post({ action: "rm -rf", path: "projects/site" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid" });
    for (const fn of everyAction()) expect(fn).not.toHaveBeenCalled();
  });

  it("first_backup hands the path and the chosen name through", async () => {
    const res = await POST(post({ action: "first_backup", path: "projects/site", name: "site-2" }));
    expect(res.status).toBe(200);
    expect(m.firstBackup).toHaveBeenCalledWith("projects/site", { name: "site-2" });
    expect(await res.json()).toMatchObject({ ok: true, repo: "me/site", files: 3 });
  });

  it("a name already on GitHub travels back with the next free one to offer", async () => {
    m.firstBackup.mockRejectedValue(new ProjectBackupError("name_taken", "taken", { takenName: "site", suggestedName: "site-2" }));
    const res = await POST(post({ action: "first_backup", path: "projects/site", name: "site" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "name_taken", takenName: "site", suggestedName: "site-2" });
  });

  it("backup_now runs the backup; a rejected push is a 409 with its plain code", async () => {
    expect((await POST(post({ action: "backup_now", path: "work/lib" }))).status).toBe(200);
    expect(m.backUpNow).toHaveBeenCalledWith("work/lib");
    m.backUpNow.mockRejectedValue(new ProjectBackupError("remote_ahead", "moved on", { detail: "! [rejected] trunk -> trunk (fetch first)" }));
    const res = await POST(post({ action: "backup_now", path: "work/lib" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "remote_ahead", detail: expect.stringContaining("rejected") });
  });

  it("auto passes the switch's value through for the backup module to validate", async () => {
    await POST(post({ action: "auto", path: "projects/site", enabled: true }));
    expect(m.setAutoBackup).toHaveBeenCalledWith("projects/site", true);
    m.setAutoBackup.mockRejectedValue(new ProjectBackupError("invalid", "enabled must be true or false"));
    const res = await POST(post({ action: "auto", path: "projects/site", enabled: "yes" }));
    expect(res.status).toBe(400);
  });

  it("disconnect and dismiss_suggestion answer ok", async () => {
    expect(await (await POST(post({ action: "disconnect", path: "projects/site" }))).json()).toEqual({ ok: true, removedRemote: true });
    expect(await (await POST(post({ action: "dismiss_suggestion" }))).json()).toEqual({ ok: true, dismissedAt: 1234 });
  });

  it("an unexpected failure is a generic 500 that leaks nothing it was not meant to", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    m.backUpNow.mockRejectedValue(new Error("EACCES /home/clawbox/secret/path"));
    const res = await POST(post({ action: "backup_now", path: "projects/site" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "The backup did not finish", code: "failed" });
  });
});
