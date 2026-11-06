import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A ClawBox AI sign-in that SUCCEEDED but could not do all of it must say so.
 *
 * The device-code finaliser calls `/setup-api/ai-models/configure` in-process
 * and read only `response.ok` from it, dropping the body — so the one warning
 * this path can produce (the deferred session sweep: ClawBox AI is a
 * `subscription` save, which takes the doctor stop) reached nobody. Settings
 * renders `saveWarning`, and the ClawBox AI login is the primary sign-in on
 * these boxes, so the path most likely to produce the sentence was the one
 * that could not show it.
 */

vi.mock("@/lib/clawai-connect", () => ({
  createClawAiUserCode: vi.fn(() => "ABCD-1234"),
  createClawAiDeviceId: vi.fn(() => "device-id-xyz"),
  CLAWAI_USER_CODE_LENGTH: 8,
  CLAWAI_CONFIGURING_TIMEOUT_MS: 3 * 60 * 1000,
  writeClawAiSession: vi.fn(),
  readClawAiSession: vi.fn(),
  clearClawAiSession: vi.fn(),
  isClawAiSessionExpired: vi.fn(() => false),
}));
vi.mock("@/app/setup-api/ai-models/configure/route", () => ({ POST: vi.fn() }));
vi.mock("@/lib/harness", () => ({ getActiveHarness: vi.fn(async () => "openclaw") }));
vi.mock("@/lib/hermes-clawai", () => ({
  applyClawaiToHermes: vi.fn(async () => ({})),
  ClawaiApplyError: class ClawaiApplyError extends Error {},
}));
vi.mock("@/lib/clawbox-ai-portal-tier", () => ({ fetchPortalTier: vi.fn() }));
// The sign-in restarts the gateway, and the configure answers before it is back
// (TASK-1535); the finaliser follows it before calling the session complete.
vi.mock("@/lib/gateway-hot-apply", () => ({ waitForGatewayBack: vi.fn(async () => true) }));
// The finaliser is the box's provider sign-in task (TASK-2148), which reads the
// row back once the gateway is.
vi.mock("@/lib/provider-status", () => ({
  readProviderStatus: vi.fn(async () => ({
    harness: "openclaw",
    providers: [{ id: "clawai", label: "ClawBox AI", state: "connected", isDefault: true, enabled: true, section: "ai" }],
    defaultProvider: "clawai",
    unrunnable: [],
    degraded: false,
  })),
}));

import { readClawAiSession, writeClawAiSession } from "@/lib/clawai-connect";
import { POST as configurePost } from "@/app/setup-api/ai-models/configure/route";
import { waitForGatewayBack } from "@/lib/gateway-hot-apply";
import { getBackgroundTask, listBackgroundTasks, resetBackgroundTasksForTests, startBackgroundTask } from "@/lib/background-tasks";
import { PROVIDER_GATEWAY_WAIT_MS } from "@/lib/provider-auth-tasks";

const mockReadSession = vi.mocked(readClawAiSession);
const mockWriteSession = vi.mocked(writeClawAiSession);
const mockConfigure = vi.mocked(configurePost);

const TOKEN = "claw_device_code_token";
const SWEEP_WARNING =
  "Saved, but a chat that was already open keeps its previous model — pick the model again in its header.";

/** The session record this finaliser wrote once the configure landed. */
function completedSession(): { status?: string; warning?: unknown } | undefined {
  return mockWriteSession.mock.calls
    .map(([session]) => session as { status?: string; warning?: unknown })
    .filter((session) => session.status === "complete")
    .at(-1);
}

/** Drive the poll to the point where it finalises a claimed session. */
async function finalise() {
  mockReadSession.mockResolvedValue({
    device_id: "device-id-xyz",
    user_code: "ABCD-1234",
    status: "pending",
    createdAt: Date.now(),
    tier: "flash",
  } as never);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ status: "complete", access_token: TOKEN }),
    { status: 200 },
  )));
  const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
  const body = await (await POST()).json();
  // The finalise runs off the request lifecycle, as the box's task: wait for
  // it to have saved.
  await vi.waitFor(() => expect(mockConfigure).toHaveBeenCalled());
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return body as { status?: string; taskId?: string };
}

describe("the device-code finaliser carries the configure's warning", () => {
  // Each test its own box: the task registry persists to <root>/data.
  let root: string;
  let savedRoot: string | undefined;
  beforeEach(() => {
    savedRoot = process.env.CLAWBOX_ROOT;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawai-poll-warning-"));
    process.env.CLAWBOX_ROOT = root;
    vi.resetModules();
    vi.clearAllMocks();
    resetBackgroundTasksForTests();
    mockWriteSession.mockResolvedValue(undefined as never);
  });
  afterEach(() => {
    resetBackgroundTasksForTests();
    if (savedRoot === undefined) delete process.env.CLAWBOX_ROOT;
    else process.env.CLAWBOX_ROOT = savedRoot;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("records the warning a successful configure answered with", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true, warning: SWEEP_WARNING }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    await vi.waitFor(() => expect(completedSession()?.warning).toBe(SWEEP_WARNING));
  });

  it("records no warning when there was none", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    await vi.waitFor(() => expect(completedSession()?.status).toBe("complete"));
    expect(completedSession()?.warning).toBeNull();
  });

  it("keeps the session configuring until a restarted gateway is back, then completes without a notice", async () => {
    let back!: (ready: boolean) => void;
    vi.mocked(waitForGatewayBack).mockImplementationOnce(() => new Promise<boolean>((resolve) => { back = resolve; }));
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true, gatewayRestarting: true, restartingNotice: "Saved. The assistant is restarting." }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    // "complete" keeps meaning a box the owner can chat with.
    expect(completedSession()).toBeUndefined();
    back(true);
    await vi.waitFor(() => expect(completedSession()?.status).toBe("complete"));
    expect(completedSession()?.warning).toBeNull();
  });

  it("completes with the restarting notice when the gateway is slower than the wait", async () => {
    vi.mocked(waitForGatewayBack).mockResolvedValueOnce(false);
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({
        success: true,
        warning: SWEEP_WARNING,
        gatewayRestarting: true,
        restartingNotice: "Saved. The assistant is restarting.",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    await vi.waitFor(() => expect(completedSession()?.status).toBe("complete"));
    expect(completedSession()?.warning).toBe(`${SWEEP_WARNING} Saved. The assistant is restarting.`);
  });

  it("runs as the box's ClawBox AI sign-in task, named to the poll that started it", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const body = await finalise();

    expect(body.status).toBe("configuring");
    expect(body.taskId).toEqual(expect.any(String));
    await vi.waitFor(() => expect(getBackgroundTask(body.taskId!)?.state).toBe("succeeded"));
    expect(getBackgroundTask(body.taskId!)).toMatchObject({
      kind: "provider-sign-in",
      meta: { subject: "clawai", action: "sign-in", label: "ClawBox AI" },
      result: { success: true, verified: true, status: "Connected to ClawBox AI." },
    });
    // The session names its task, from inside it, before the ending is written.
    const named = mockWriteSession.mock.calls.findIndex(([session]) => (session as { taskId?: string }).taskId === body.taskId);
    const done = mockWriteSession.mock.calls.findIndex(([session]) => (session as { status?: string }).status === "complete");
    expect(named).toBeGreaterThanOrEqual(0);
    expect(named).toBeLessThan(done);
  });

  it("waits for the gateway for as long as the provider task waits — the configuring window no longer cuts it short", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true, gatewayRestarting: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    await vi.waitFor(() => expect(waitForGatewayBack).toHaveBeenCalledTimes(1));
    expect(vi.mocked(waitForGatewayBack).mock.calls[0][0]).toBe(PROVIDER_GATEWAY_WAIT_MS);
  });

  it("does not wait on a save the gateway applied live", async () => {
    mockConfigure.mockResolvedValue(new Response(
      JSON.stringify({ success: true }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await finalise();

    await vi.waitFor(() => expect(completedSession()?.status).toBe("complete"));
    expect(waitForGatewayBack).not.toHaveBeenCalled();
  });

  it("answers `configuring` past the three-minute window while the session's task still runs", async () => {
    let release!: () => void;
    const started = startBackgroundTask({
      kind: "provider-sign-in",
      group: "provider-auth",
      title: "Connecting ClawBox AI",
      meta: { subject: "clawai", action: "sign-in", label: "ClawBox AI" },
      run: () => new Promise((resolve) => { release = () => resolve({ success: true }); }),
    });
    if (!started.started) throw new Error("not started");
    mockReadSession.mockResolvedValue({
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      status: "configuring",
      createdAt: Date.now() - 10 * 60 * 1000,
      configuringStartedAt: Date.now() - 4 * 60 * 1000,
      taskId: started.task.id,
    } as never);

    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const res = await POST();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "configuring", taskId: started.task.id });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
  });

  it("answers how the task ended when the web server restarted under it and the session was never written", async () => {
    // A task that ended without its session being written — what a web server
    // that restarted under it leaves behind (the registry closes such a task
    // on its next read; here it simply fails).
    const started = startBackgroundTask({
      kind: "provider-sign-in",
      group: "provider-auth",
      title: "Connecting ClawBox AI",
      meta: { subject: "clawai", action: "sign-in", label: "ClawBox AI" },
      run: () => Promise.reject(new Error("The ClawBox web server restarted while this was running.")),
    });
    if (!started.started) throw new Error("not started");
    await vi.waitFor(() => expect(getBackgroundTask(started.task.id)?.state).toBe("failed"));
    const session = {
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      status: "configuring",
      createdAt: Date.now(),
      configuringStartedAt: Date.now(),
      taskId: started.task.id,
    };
    mockReadSession.mockResolvedValueOnce(session as never);
    mockReadSession.mockResolvedValueOnce({ ...session, status: "error", error: "The ClawBox web server restarted while this was running." } as never);

    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const body = await (await POST()).json();

    expect(body).toEqual({ status: "error", error: "The ClawBox web server restarted while this was running." });
    expect(mockWriteSession).toHaveBeenCalledWith(expect.objectContaining({ status: "error" }));
  });

  it("does not save a token over another provider change the box is running", async () => {
    let release!: () => void;
    const other = startBackgroundTask({
      kind: "provider-sign-out",
      group: "provider-auth",
      title: "Signing out of OpenAI",
      meta: { subject: "openai", action: "sign-out", label: "OpenAI" },
      run: () => new Promise((resolve) => { release = () => resolve({}); }),
    });
    if (!other.started) throw new Error("not started");
    mockReadSession.mockResolvedValue({
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      status: "pending",
      createdAt: Date.now(),
      tier: "flash",
    } as never);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "complete", access_token: TOKEN }), { status: 200 })));

    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const res = await POST();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: "error", error: expect.stringContaining("OpenAI is being signed out") });
    expect(mockConfigure).not.toHaveBeenCalled();
    expect(listBackgroundTasks({ kind: "provider-sign-in" })).toEqual([]);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
  });

  it("answers the warning to the poll that is waiting on it", async () => {
    mockReadSession.mockResolvedValue({
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      status: "complete",
      createdAt: Date.now(),
      warning: SWEEP_WARNING,
    } as never);

    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const body = await (await POST()).json();

    expect(body).toEqual({ status: "complete", warning: SWEEP_WARNING });
  });

  it("answers a plain complete when the save had nothing to warn about", async () => {
    mockReadSession.mockResolvedValue({
      device_id: "device-id-xyz",
      user_code: "ABCD-1234",
      status: "complete",
      createdAt: Date.now(),
    } as never);

    const { POST } = await import("@/app/setup-api/ai-models/clawai/poll/route");
    const body = await (await POST()).json();

    expect(body).toEqual({ status: "complete" });
  });
});
