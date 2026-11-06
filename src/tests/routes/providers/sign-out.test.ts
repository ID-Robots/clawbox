/**
 * POST /setup-api/providers/sign-out — "Sign out of <Provider>" on every
 * connected row. The owner's alone: middleware admits the MCP bearer to every
 * /setup-api/* path, so the route refuses it in-handler with the real cookie
 * verifier, the way providers/enabled does.
 *
 * The sign-out runs as a BACKGROUND TASK of the box (TASK-2148,
 * src/lib/provider-auth-tasks.ts): the route answers 202 with the task, and
 * the task's ending is the sign-out's answer. A refusal the box can tell at
 * once is still answered here, before any task. src/lib/provider-sign-out.ts
 * itself is tested in src/tests/unit/provider-sign-out.test.ts.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const signOut = vi.hoisted(() => ({
  signOutOfProvider: vi.fn(),
  resolveSignOutTarget: vi.fn(),
  signOutRefusal: vi.fn(),
}));
vi.mock("@/lib/provider-sign-out", () => signOut);
const gateway = vi.hoisted(() => ({ waitForGatewayBack: vi.fn() }));
vi.mock("@/lib/gateway-hot-apply", () => gateway);
const status = vi.hoisted(() => ({ readProviderStatus: vi.fn() }));
vi.mock("@/lib/provider-status", () => status);
const hermesAuth = vi.hoisted(() => ({ hermesStillSignedIn: vi.fn() }));
vi.mock("@/lib/provider-sign-out-hermes", () => hermesAuth);
// The real module's constants (the cookie verifier reads `DATA_DIR` at import)
// over an in-memory store.
vi.mock("@/lib/config-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/config-store")>()),
  get: vi.fn(async () => undefined),
  set: vi.fn(async () => undefined),
}));

const SESSION_SECRET = "a".repeat(64);

type Tasks = typeof import("@/lib/background-tasks");
let POST: (req: Request) => Promise<Response>;
let tasks: Tasks;
let restore: () => void;
let root: string;

function request(init: { cookie?: boolean; bearer?: string; body?: unknown; raw?: string } = {}): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (init.cookie) headers.cookie = `clawbox_session=${createSessionCookie(3600, SESSION_SECRET)}`;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  return new Request("http://localhost/setup-api/providers/sign-out", {
    method: "POST",
    headers,
    body: init.raw ?? JSON.stringify(init.body ?? { provider: "openrouter" }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function ended(id: string) {
  await vi.waitFor(() => expect(tasks.getBackgroundTask(id)?.state).not.toBe("running"));
  return tasks.getBackgroundTask(id)!;
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET", "CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-sign-out-route-"));
  process.env.CLAWBOX_ROOT = root;
  vi.resetModules();
  vi.clearAllMocks();
  process.env.SESSION_SECRET = SESSION_SECRET;
  signOut.resolveSignOutTarget.mockImplementation(async (provider: string) => ({
    ok: true, harness: "openclaw", edition: "openclaw", row: provider.trim(), label: "OpenRouter",
  }));
  signOut.signOutRefusal.mockResolvedValue(null);
  signOut.signOutOfProvider.mockResolvedValue({ ok: true, changed: true, gatewayRestarting: false });
  gateway.waitForGatewayBack.mockResolvedValue(true);
  status.readProviderStatus.mockResolvedValue({ harness: "openclaw", providers: [], defaultProvider: null, unrunnable: [], degraded: false });
  hermesAuth.hermesStillSignedIn.mockResolvedValue(false);
  tasks = await import("@/lib/background-tasks");
  tasks.resetBackgroundTasksForTests();
  ({ POST } = await import("@/app/setup-api/providers/sign-out/route"));
});

afterEach(() => {
  tasks.resetBackgroundTasksForTests();
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("POST /setup-api/providers/sign-out", () => {
  it("starts the sign-out as a task of the box, which ends with what happened", async () => {
    const res = await POST(request({ cookie: true, body: { provider: " openrouter " } }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ started: true, task: { kind: "provider-sign-out", state: "running" } });
    expect(body.task.meta).toEqual({ subject: "openrouter", action: "sign-out", label: "OpenRouter" });
    const task = await ended(body.taskId);
    expect(task.state).toBe("succeeded");
    expect(task.result).toMatchObject({
      signedOut: true,
      provider: "openrouter",
      changed: true,
      gatewayRestarting: false,
      status: "Signed out of OpenRouter.",
      verified: true,
    });
    expect(signOut.signOutOfProvider).toHaveBeenCalledWith("openrouter");
    // No restart was started, so none is waited for.
    expect(gateway.waitForGatewayBack).not.toHaveBeenCalled();
    expect(task.steps.map((s) => [s.id, s.state])).toEqual([["remove", "done"], ["restart", "done"], ["verify", "done"]]);
  });

  it("asked again for the same provider while it runs, answers the SAME task and starts no second sign-out", async () => {
    const gate = deferred<{ ok: true; changed: boolean; gatewayRestarting: boolean }>();
    signOut.signOutOfProvider.mockReturnValue(gate.promise);
    const first = await (await POST(request({ cookie: true }))).json();
    await vi.waitFor(() => expect(signOut.signOutOfProvider).toHaveBeenCalledTimes(1));
    const again = await POST(request({ cookie: true }));
    expect(again.status).toBe(202);
    expect(await again.json()).toMatchObject({ taskId: first.taskId, started: false });
    gate.resolve({ ok: true, changed: true, gatewayRestarting: false });
    await ended(first.taskId);
    expect(signOut.signOutOfProvider).toHaveBeenCalledTimes(1);
  });

  it("refuses while another provider change runs, naming it, and starts nothing", async () => {
    const gate = deferred<{ ok: true; changed: boolean; gatewayRestarting: boolean }>();
    signOut.signOutOfProvider.mockReturnValueOnce(gate.promise);
    const first = await (await POST(request({ cookie: true, body: { provider: "openrouter" } }))).json();
    signOut.resolveSignOutTarget.mockResolvedValueOnce({ ok: true, harness: "openclaw", edition: "openclaw", row: "xai", label: "xAI" });
    const res = await POST(request({ cookie: true, body: { provider: "xai" } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "provider_change_running",
      taskId: first.taskId,
      error: expect.stringContaining("OpenRouter is being signed out"),
    });
    gate.resolve({ ok: true, changed: true, gatewayRestarting: false });
    await ended(first.taskId);
    expect(signOut.signOutOfProvider).toHaveBeenCalledTimes(1);
  });

  it("waits out the restart behind the sign-out before it calls it done", async () => {
    signOut.signOutOfProvider.mockResolvedValue({ ok: true, changed: true, gatewayRestarting: true });
    const back = deferred<boolean>();
    gateway.waitForGatewayBack.mockReturnValue(back.promise);
    const { taskId } = await (await POST(request({ cookie: true }))).json();
    await vi.waitFor(() => {
      const task = tasks.getBackgroundTask(taskId)!;
      expect(task.steps.find((s) => s.state === "running")?.id).toBe("restart");
    });
    expect(tasks.getBackgroundTask(taskId)?.state).toBe("running");
    back.resolve(true);
    const task = await ended(taskId);
    expect(task.state).toBe("succeeded");
    expect(task.result).toMatchObject({ signedOut: true, gatewayRestarting: false });
    expect(task.result?.warning).toBeUndefined();
  });

  it("a restart slower than the wait is not a failure: the sign-out landed, and it says the assistant is still coming back", async () => {
    signOut.signOutOfProvider.mockResolvedValue({ ok: true, changed: true, gatewayRestarting: true });
    gateway.waitForGatewayBack.mockResolvedValue(false);
    const { taskId } = await (await POST(request({ cookie: true }))).json();
    const task = await ended(taskId);
    expect(task.state).toBe("succeeded");
    expect(task.result?.warning).toMatch(/still restarting/);
  });

  it("on Hermes there is no OpenClaw gateway to wait for", async () => {
    signOut.resolveSignOutTarget.mockResolvedValue({ ok: true, harness: "hermes", edition: "dual", row: "openrouter", label: "OpenRouter" });
    signOut.signOutOfProvider.mockResolvedValue({ ok: true, changed: true, gatewayRestarting: true });
    const { taskId } = await (await POST(request({ cookie: true }))).json();
    expect((await ended(taskId)).state).toBe("succeeded");
    expect(gateway.waitForGatewayBack).not.toHaveBeenCalled();
    expect(hermesAuth.hermesStillSignedIn).toHaveBeenCalledWith("openrouter");
  });

  it("on Hermes, the default is refused 409 is_default before any task — ClawBox AI's too", async () => {
    signOut.resolveSignOutTarget.mockResolvedValue({ ok: true, harness: "hermes", edition: "hermes", row: "clawai", label: "ClawBox AI" });
    const error = "ClawBox AI is the default provider. Make another provider the default first, then sign out of it.";
    signOut.signOutRefusal.mockResolvedValue({ kind: "is_default", error });
    const res = await POST(request({ cookie: true, body: { provider: "clawai" } }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error, kind: "is_default" });
    expect(signOut.signOutOfProvider).not.toHaveBeenCalled();
    expect(tasks.listBackgroundTasks()).toEqual([]);
  });

  it("on Hermes, a sign-out Hermes still lists signed in ends the task failed, never signed out", async () => {
    signOut.resolveSignOutTarget.mockResolvedValue({ ok: true, harness: "hermes", edition: "hermes", row: "openrouter", label: "OpenRouter" });
    hermesAuth.hermesStillSignedIn.mockResolvedValue(true);
    const res = await POST(request({ cookie: true }));
    expect(res.status).toBe(202);
    const task = await ended((await res.json()).taskId);
    expect(task).toMatchObject({ state: "failed", error: expect.stringMatching(/^OpenRouter was not signed out: Hermes still lists it as signed in/), result: { kind: "still_signed_in" } });
  });

  it("refuses the MCP bearer — what the agent holds — and no session, 403 owner_only, signing nothing out", async () => {
    for (const init of [{ bearer: "any-valid-looking-token-value" }, {}]) {
      const res = await POST(request(init));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ kind: "owner_only" });
    }
    expect(signOut.signOutOfProvider).not.toHaveBeenCalled();
    expect(tasks.listBackgroundTasks()).toEqual([]);
  });

  it("refuses a body that names no provider", async () => {
    for (const init of [{ raw: "{not json" }, { body: {} }, { body: { provider: 7 } }, { body: ["openai"] }, { raw: "\"openai\"" }]) {
      const res = await POST(request({ cookie: true, ...init }));
      expect(res.status, JSON.stringify(init)).toBe(400);
    }
    expect(signOut.signOutOfProvider).not.toHaveBeenCalled();
  });

  it("answers the refusals it can tell at once with their status, before any task", async () => {
    signOut.resolveSignOutTarget.mockResolvedValueOnce({ ok: false, kind: "unknown_provider", error: "refused: unknown_provider" });
    let res = await POST(request({ cookie: true }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "refused: unknown_provider", kind: "unknown_provider" });
    for (const kind of ["is_default", "default_unknown", "sign_in_in_progress"] as const) {
      signOut.signOutRefusal.mockResolvedValueOnce({ kind, error: `refused: ${kind}` });
      res = await POST(request({ cookie: true }));
      expect(res.status, kind).toBe(409);
      expect(await res.json()).toEqual({ error: `refused: ${kind}`, kind });
    }
    expect(signOut.signOutOfProvider).not.toHaveBeenCalled();
    expect(tasks.listBackgroundTasks()).toEqual([]);
  });

  it("a refusal only the work can find ends the task failed, with its sentence and kind", async () => {
    for (const kind of ["still_signed_in", "restart_refused", "is_default"] as const) {
      tasks.resetBackgroundTasksForTests();
      signOut.signOutOfProvider.mockResolvedValueOnce({ ok: false, kind, error: `refused: ${kind}` });
      const res = await POST(request({ cookie: true }));
      expect(res.status, kind).toBe(202);
      const task = await ended((await res.json()).taskId);
      expect(task.state, kind).toBe("failed");
      expect(task.error).toBe(`refused: ${kind}`);
      expect(task.result).toEqual({ kind });
    }
  });
});
