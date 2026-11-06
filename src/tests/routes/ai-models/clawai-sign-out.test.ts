/**
 * POST /setup-api/ai-models/clawai/sign-out — #1369's ClawBox AI sign-out,
 * now the provider sign-out for ClawBox AI on either harness: the owner's
 * alone (the MCP bearer gets the same 403 as no session), started as the
 * box's background task exactly as providers/sign-out starts it (TASK-2148).
 * src/lib/provider-sign-out.ts is tested in src/tests/unit/provider-sign-out.test.ts.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const signOut = vi.hoisted(() => ({
  CLAWAI_ROW: "clawai",
  signOutOfProvider: vi.fn(),
  resolveSignOutTarget: vi.fn(),
  signOutRefusal: vi.fn(),
}));
vi.mock("@/lib/provider-sign-out", () => signOut);
const hermesAuth = vi.hoisted(() => ({ hermesStillSignedIn: vi.fn(async () => false) }));
vi.mock("@/lib/provider-sign-out-hermes", () => hermesAuth);
const owner = vi.hoisted(() => ({ hasPersonSession: vi.fn() }));
vi.mock("@/lib/owner-session", () => owner);
vi.mock("@/lib/gateway-hot-apply", () => ({ waitForGatewayBack: vi.fn(async () => true) }));
vi.mock("@/lib/provider-status", () => ({
  readProviderStatus: vi.fn(async () => ({ harness: "openclaw", providers: [], defaultProvider: null, unrunnable: [], degraded: false })),
}));

let POST: (req: Request) => Promise<Response>;
let tasks: typeof import("@/lib/background-tasks");
let root: string;
let savedRoot: string | undefined;

const req = () => new Request("http://localhost/setup-api/ai-models/clawai/sign-out", { method: "POST", headers: { host: "localhost" } });

beforeEach(async () => {
  savedRoot = process.env.CLAWBOX_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawai-sign-out-route-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  vi.clearAllMocks();
  owner.hasPersonSession.mockResolvedValue(true);
  signOut.resolveSignOutTarget.mockResolvedValue({ ok: true, harness: "openclaw", edition: "openclaw", row: "clawai", label: "ClawBox AI" });
  signOut.signOutRefusal.mockResolvedValue(null);
  signOut.signOutOfProvider.mockResolvedValue({ ok: true, changed: true, gatewayRestarting: false });
  tasks = await import("@/lib/background-tasks");
  tasks.resetBackgroundTasksForTests();
  ({ POST } = await import("@/app/setup-api/ai-models/clawai/sign-out/route"));
});

afterEach(() => {
  tasks.resetBackgroundTasksForTests();
  if (savedRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /setup-api/ai-models/clawai/sign-out", () => {
  it("starts the ClawBox AI sign-out as a task for the owner, which ends with what happened", async () => {
    const res = await POST(req());
    expect(res.status).toBe(202);
    const { taskId } = await res.json();
    await vi.waitFor(() => expect(tasks.getBackgroundTask(taskId)?.state).toBe("succeeded"));
    expect(tasks.getBackgroundTask(taskId)?.result).toMatchObject({ signedOut: true, provider: "clawai", changed: true });
    expect(signOut.resolveSignOutTarget).toHaveBeenCalledWith("clawai");
    expect(signOut.signOutOfProvider).toHaveBeenCalledWith("clawai");
  });

  it("refuses anything but the owner's browser session 403 owner_only, and signs nothing out", async () => {
    owner.hasPersonSession.mockResolvedValue(false);
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: "owner_only" });
    expect(signOut.signOutOfProvider).not.toHaveBeenCalled();
  });

  it("answers a sign-in mid-write 409 at once; a credential still there or a refused restart fails the task with its kind", async () => {
    signOut.signOutRefusal.mockResolvedValueOnce({ kind: "sign_in_in_progress", error: "refused: sign_in_in_progress" });
    const refused = await POST(req());
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "refused: sign_in_in_progress", kind: "sign_in_in_progress" });
    for (const kind of ["still_signed_in", "restart_refused"] as const) {
      tasks.resetBackgroundTasksForTests();
      signOut.signOutOfProvider.mockResolvedValueOnce({ ok: false, kind, error: `refused: ${kind}` });
      const { taskId } = await (await POST(req())).json();
      await vi.waitFor(() => expect(tasks.getBackgroundTask(taskId)?.state).toBe("failed"));
      expect(tasks.getBackgroundTask(taskId)).toMatchObject({ error: `refused: ${kind}`, result: { kind } });
    }
  });

  it("on Hermes, ClawBox AI as the default is refused 409 is_default before any task", async () => {
    signOut.resolveSignOutTarget.mockResolvedValue({ ok: true, harness: "hermes", edition: "hermes", row: "clawai", label: "ClawBox AI" });
    const error = "ClawBox AI is the default provider. Make another provider the default first, then sign out of it.";
    signOut.signOutRefusal.mockResolvedValueOnce({ kind: "is_default", error });
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error, kind: "is_default" });
    expect(signOut.signOutOfProvider).not.toHaveBeenCalled();
    expect(tasks.listBackgroundTasks()).toEqual([]);
  });

  it("on Hermes, off the default: signed out once Hermes' own list says so, failed while it still lists it", async () => {
    signOut.resolveSignOutTarget.mockResolvedValue({ ok: true, harness: "hermes", edition: "hermes", row: "clawai", label: "ClawBox AI" });
    const ok = await (await POST(req())).json();
    await vi.waitFor(() => expect(tasks.getBackgroundTask(ok.taskId)?.state).toBe("succeeded"));
    expect(tasks.getBackgroundTask(ok.taskId)?.result).toMatchObject({ signedOut: true, provider: "clawai", verified: true });
    expect(hermesAuth.hermesStillSignedIn).toHaveBeenCalledWith("clawai");
    hermesAuth.hermesStillSignedIn.mockResolvedValueOnce(true);
    const stuck = await (await POST(req())).json();
    await vi.waitFor(() => expect(tasks.getBackgroundTask(stuck.taskId)?.state).toBe("failed"));
    expect(tasks.getBackgroundTask(stuck.taskId)).toMatchObject({ result: { kind: "still_signed_in" } });
  });
});
