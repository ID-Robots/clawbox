/**
 * src/lib/provider-auth-tasks.ts — connecting an AI provider and signing out
 * of one as background tasks of the box (TASK-2148): the steps a card and a
 * reopened Settings read, the restart waited out on the box rather than in
 * the window, one provider change at a time, and the same ask answered by the
 * task already running instead of a second one.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gateway = vi.hoisted(() => ({ waitForGatewayBack: vi.fn() }));
vi.mock("@/lib/gateway-hot-apply", () => gateway);
const status = vi.hoisted(() => ({ readProviderStatus: vi.fn() }));
vi.mock("@/lib/provider-status", () => status);
// Hermes' own list of who is signed in (GET /setup-api/hermes/models).
const hermesAuth = vi.hoisted(() => ({ hermesStillSignedIn: vi.fn() }));
vi.mock("@/lib/provider-sign-out-hermes", () => hermesAuth);

import { getBackgroundTask, resetBackgroundTasksForTests, type BackgroundTaskView } from "@/lib/background-tasks";
import {
  ASSISTANT_RESTARTING_NOTICE,
  PROVIDER_GATEWAY_WAIT_MS,
  providerAuthBusyMessage,
  providerAuthMetaOf,
  providerAuthStartResponse,
  runningProviderAuthTask,
  startProviderSignInTask,
  startProviderSignOutTask,
  type ProviderAuthStart,
  type ProviderSaveOutcome,
} from "@/lib/provider-auth-tasks";

let root: string;
let savedRoot: string | undefined;

function rows(state: string, id = "openai") {
  return { harness: "openclaw", providers: [{ id, label: "OpenAI", state, isDefault: false, enabled: true, section: "ai" }], defaultProvider: null, unrunnable: [], degraded: false };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function taskOf(start: ProviderAuthStart): BackgroundTaskView {
  if (!start.ok) throw new Error("refused");
  return start.task;
}

async function ended(id: string): Promise<BackgroundTaskView> {
  await vi.waitFor(() => expect(getBackgroundTask(id)?.state).not.toBe("running"));
  return getBackgroundTask(id)!;
}

function signIn(save: () => Promise<ProviderSaveOutcome>, extra: Partial<Parameters<typeof startProviderSignInTask>[0]> = {}) {
  return startProviderSignInTask({ provider: "openai", label: "OpenAI", save, ...extra });
}

beforeEach(() => {
  savedRoot = process.env.CLAWBOX_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "provider-auth-tasks-"));
  process.env.CLAWBOX_ROOT = root;
  resetBackgroundTasksForTests();
  vi.clearAllMocks();
  gateway.waitForGatewayBack.mockResolvedValue(true);
  status.readProviderStatus.mockResolvedValue(rows("connected"));
  hermesAuth.hermesStillSignedIn.mockResolvedValue(false);
});

afterEach(() => {
  resetBackgroundTasksForTests();
  if (savedRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a provider sign-in task", () => {
  it("saves, reads the row back and ends with the save's answer, connected and verified", async () => {
    const start = signIn(async () => ({ ok: true, body: { success: true, model: "openai/gpt-5" } }));
    const task = taskOf(start);
    expect(start).toMatchObject({ ok: true, started: true });
    expect(task).toMatchObject({
      kind: "provider-sign-in",
      group: "provider-auth",
      title: "Connecting OpenAI",
      meta: { subject: "openai", action: "sign-in", label: "OpenAI" },
      cancellable: false,
    });
    const done = await ended(task.id);
    expect(done.state).toBe("succeeded");
    expect(done.result).toEqual({
      success: true,
      model: "openai/gpt-5",
      gatewayRestarting: false,
      status: "Connected to OpenAI.",
      verified: true,
    });
    // No restart was started, so none was waited for.
    expect(gateway.waitForGatewayBack).not.toHaveBeenCalled();
    expect(done.steps.map((s) => s.state)).toEqual(["done", "done", "done"]);
  });

  it("waits out the restart the save started before it reads the row back, on the box", async () => {
    const back = deferred<boolean>();
    gateway.waitForGatewayBack.mockReturnValue(back.promise);
    const task = taskOf(signIn(async () => ({
      ok: true,
      body: { success: true, gatewayRestarting: true, restartingNotice: "Saved. Restarting." },
    })));
    await vi.waitFor(() => expect(getBackgroundTask(task.id)?.steps.find((s) => s.state === "running")?.id).toBe("restart"));
    expect(gateway.waitForGatewayBack).toHaveBeenCalledWith(PROVIDER_GATEWAY_WAIT_MS);
    expect(status.readProviderStatus).not.toHaveBeenCalled();
    back.resolve(true);
    const done = await ended(task.id);
    expect(done.result).toMatchObject({ success: true, gatewayRestarting: false, verified: true });
    // The notice is for a gateway that was NOT back; this one was.
    expect(done.result).not.toHaveProperty("warning");
    expect(done.result).not.toHaveProperty("restartingNotice");
  });

  it("folds the restart's notice into the warning when the gateway is slower than the wait — still a success", async () => {
    gateway.waitForGatewayBack.mockResolvedValue(false);
    const task = taskOf(signIn(async () => ({
      ok: true,
      body: { success: true, warning: "Pick the model again in an open chat.", gatewayRestarting: true },
    })));
    const done = await ended(task.id);
    expect(done.state).toBe("succeeded");
    expect(done.result?.warning).toBe(`Pick the model again in an open chat. ${ASSISTANT_RESTARTING_NOTICE}`);
  });

  it("waits out a row the box is still probing, and does not claim a connection the box does not show", async () => {
    status.readProviderStatus
      .mockResolvedValueOnce(rows("checking"))
      .mockResolvedValueOnce(rows("needs-reauth"));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const task = taskOf(signIn(async () => ({ ok: true, body: { success: true } })));
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
        expect(getBackgroundTask(task.id)?.state).toBe("succeeded");
      });
      expect(getBackgroundTask(task.id)?.result).toMatchObject({ verified: false, status: "Saved the OpenAI sign-in." });
      expect(status.readProviderStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails with the save's own sentence and keeps its code for the client", async () => {
    const task = taskOf(signIn(async () => ({
      ok: false,
      httpStatus: 503,
      body: { error: "Local AI is not running.", code: "local_ai_runtime_unavailable" },
    })));
    const done = await ended(task.id);
    expect(done.state).toBe("failed");
    expect(done.error).toBe("Local AI is not running.");
    expect(done.result).toEqual({ error: "Local AI is not running.", code: "local_ai_runtime_unavailable", httpStatus: 503 });
    expect(status.readProviderStatus).not.toHaveBeenCalled();
  });

  it("tells its own record how it ended before the task ends, and a record that cannot be written fails nothing", async () => {
    const ends: unknown[] = [];
    const ok = taskOf(signIn(async () => ({ ok: true, body: { success: true } }), {
      onEnd: (end) => {
        ends.push(end);
        expect(getBackgroundTask(ok.id)?.state).toBe("running");
      },
    }));
    await ended(ok.id);
    expect(ends).toEqual([{ ok: true, result: expect.objectContaining({ success: true }) }]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = taskOf(signIn(async () => { throw new Error("Couldn't configure ClawBox AI on this device."); }, {
      onEnd: () => { throw new Error("disk full"); },
    }));
    const done = await ended(broken.id);
    expect(done).toMatchObject({ state: "failed", error: "Couldn't configure ClawBox AI on this device." });
    warn.mockRestore();
  });
});

describe("one provider change at a time", () => {
  it("answers the running task to the same ask, and starts no second save", async () => {
    const gate = deferred<ProviderSaveOutcome>();
    const save = vi.fn(() => gate.promise);
    const first = signIn(save);
    const again = signIn(save);
    expect(again).toMatchObject({ ok: true, started: false });
    expect(taskOf(again).id).toBe(taskOf(first).id);
    expect(runningProviderAuthTask()?.id).toBe(taskOf(first).id);
    gate.resolve({ ok: true, body: { success: true } });
    await ended(taskOf(first).id);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("follows the running sign-in only for the SAME ask: another key for the same provider is refused, not folded in", async () => {
    const gate = deferred<ProviderSaveOutcome>();
    const first = startProviderSignInTask({ provider: "openai", label: "OpenAI", ask: { apiKey: "sk-one", model: "gpt-5" }, save: () => gate.promise });
    const same = startProviderSignInTask({ provider: "openai", label: "OpenAI", ask: { model: "gpt-5", apiKey: "sk-one" }, save: vi.fn() });
    expect(same).toMatchObject({ ok: true, started: false });
    const other = startProviderSignInTask({ provider: "openai", label: "OpenAI", ask: { apiKey: "sk-two", model: "gpt-5" }, save: vi.fn() });
    expect(other).toEqual({ ok: false, running: expect.objectContaining({ id: taskOf(first).id }) });
    // The record names the ask by a keyed fingerprint, never by the key.
    const meta = taskOf(first).meta ?? {};
    expect(meta.ask).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(getBackgroundTask(taskOf(first).id))).not.toContain("sk-one");
    gate.resolve({ ok: true, body: { success: true } });
    await ended(taskOf(first).id);
  });

  it("refuses any other provider change while one runs, and the answer names it", async () => {
    const gate = deferred<ProviderSaveOutcome>();
    const first = taskOf(signIn(() => gate.promise));
    const signOut = vi.fn();
    const other = startProviderSignOutTask({ provider: "xai", label: "xAI", harness: "openclaw", signOut });
    expect(other).toEqual({ ok: false, running: expect.objectContaining({ id: first.id }) });
    const otherSignIn = startProviderSignInTask({ provider: "xai", label: "xAI", save: vi.fn() });
    expect(otherSignIn.ok).toBe(false);
    // Even the same provider the other way.
    expect(startProviderSignOutTask({ provider: "openai", label: "OpenAI", harness: "openclaw", signOut }).ok).toBe(false);
    if (other.ok) throw new Error("started");
    expect(providerAuthBusyMessage(other.running)).toBe("OpenAI is being connected right now. Try again when it has finished.");

    const busy = providerAuthStartResponse(other);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({
      error: "OpenAI is being connected right now. Try again when it has finished.",
      code: "provider_change_running",
      kind: "provider_change_running",
      taskId: first.id,
    });
    gate.resolve({ ok: true, body: { success: true } });
    await ended(first.id);
    expect(signOut).not.toHaveBeenCalled();
    // Free again once it has ended.
    expect(startProviderSignOutTask({ provider: "xai", label: "xAI", harness: "openclaw", signOut: async () => ({ ok: true, changed: true, gatewayRestarting: false }) }).ok).toBe(true);
  });

  it("answers a start 202 with the task to follow", async () => {
    const start = signIn(async () => ({ ok: true, body: { success: true } }));
    const res = providerAuthStartResponse(start);
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ taskId: taskOf(start).id, started: true, task: { kind: "provider-sign-in" } });
    await ended(taskOf(start).id);
  });
});

describe("a provider sign-out task", () => {
  it("signs out, waits out OpenClaw's restart, and ends with what happened", async () => {
    status.readProviderStatus.mockResolvedValue(rows("disconnected"));
    const signOut = vi.fn(async () => ({ ok: true as const, changed: true, gatewayRestarting: true }));
    const task = taskOf(startProviderSignOutTask({ provider: "openai", label: "OpenAI", harness: "openclaw", signOut }));
    expect(task).toMatchObject({ kind: "provider-sign-out", title: "Signing out of OpenAI", meta: { subject: "openai", action: "sign-out" } });
    const done = await ended(task.id);
    expect(signOut).toHaveBeenCalledWith("openai");
    expect(gateway.waitForGatewayBack).toHaveBeenCalledWith(PROVIDER_GATEWAY_WAIT_MS);
    expect(done.result).toEqual({
      signedOut: true,
      provider: "openai",
      changed: true,
      gatewayRestarting: false,
      status: "Signed out of OpenAI.",
      verified: true,
    });
    // OpenClaw's answer is its own: Hermes is never asked.
    expect(hermesAuth.hermesStillSignedIn).not.toHaveBeenCalled();
  });

  it("fails with the sign-out's refusal and its kind", async () => {
    const task = taskOf(startProviderSignOutTask({
      provider: "openai",
      label: "OpenAI",
      harness: "openclaw",
      signOut: async () => ({ ok: false, kind: "still_signed_in", error: "The OpenAI sign-in could not be removed." }),
    }));
    const done = await ended(task.id);
    expect(done).toMatchObject({ state: "failed", error: "The OpenAI sign-in could not be removed.", result: { kind: "still_signed_in" } });
    expect(gateway.waitForGatewayBack).not.toHaveBeenCalled();
  });

  it("does not wait for an OpenClaw gateway on Hermes", async () => {
    const task = taskOf(startProviderSignOutTask({
      provider: "openrouter",
      label: "OpenRouter",
      harness: "hermes",
      signOut: async () => ({ ok: true, changed: true, gatewayRestarting: true }),
    }));
    expect((await ended(task.id)).state).toBe("succeeded");
    expect(gateway.waitForGatewayBack).not.toHaveBeenCalled();
  });

  const hermesSignOut = (provider = "openrouter", label = "OpenRouter") => taskOf(startProviderSignOutTask({
    provider,
    label,
    harness: "hermes",
    signOut: async () => ({ ok: true, changed: true, gatewayRestarting: false }),
  }));

  it("on Hermes, verified only once Hermes' own list no longer has the provider signed in", async () => {
    status.readProviderStatus.mockResolvedValue(rows("disconnected", "openrouter"));
    const done = await ended(hermesSignOut().id);
    expect(done).toMatchObject({ state: "succeeded", result: { signedOut: true, provider: "openrouter", verified: true } });
    expect(done.result).not.toHaveProperty("warning");
    expect(hermesAuth.hermesStillSignedIn).toHaveBeenCalledWith("openrouter");
  });

  it("on Hermes, fails still_signed_in when Hermes still lists the provider signed in — the files being clean is not enough", async () => {
    // The box's own row already reads it signed out: the case a board caught.
    status.readProviderStatus.mockResolvedValue(rows("disconnected", "clawai"));
    hermesAuth.hermesStillSignedIn.mockResolvedValue(true);
    const done = await ended(hermesSignOut("clawai", "ClawBox AI").id);
    expect(done).toMatchObject({
      state: "failed",
      error: "ClawBox AI was not signed out: Hermes still lists it as signed in. Try again; if it stays, restart the box and sign out again.",
      result: { kind: "still_signed_in" },
    });
  });

  it("on Hermes, waits out a dashboard still coming back from the restart, then takes its word", async () => {
    hermesAuth.hermesStillSignedIn.mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValueOnce(true);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const task = hermesSignOut();
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
        expect(getBackgroundTask(task.id)?.state).toBe("failed");
      });
      expect(hermesAuth.hermesStillSignedIn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("on Hermes, a dashboard that never answers is not a failure, and not verified either", async () => {
    status.readProviderStatus.mockResolvedValue(rows("disconnected", "openrouter"));
    hermesAuth.hermesStillSignedIn.mockResolvedValue(null);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      const task = hermesSignOut();
      await vi.waitFor(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        expect(getBackgroundTask(task.id)?.state).toBe("succeeded");
      });
      expect(getBackgroundTask(task.id)?.result).toMatchObject({
        signedOut: true,
        verified: false,
        warning: "Hermes did not answer in time to confirm that OpenRouter is signed out; Settings shows it once Hermes is back.",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("providerAuthMetaOf", () => {
  it("reads a provider task's meta, and nothing else's", () => {
    expect(providerAuthMetaOf({ kind: "provider-sign-out", meta: { subject: "xai", action: "sign-out", label: "xAI" } }))
      .toEqual({ provider: "xai", action: "sign-out", label: "xAI" });
    expect(providerAuthMetaOf({ kind: "provider-sign-in", meta: { subject: "xai", action: "sign-in" } }))
      .toEqual({ provider: "xai", action: "sign-in", label: "xai" });
    expect(providerAuthMetaOf({ kind: "llamacpp-install", meta: { subject: "xai", action: "sign-in" } })).toBeNull();
    expect(providerAuthMetaOf({ kind: "channel-setup", meta: { subject: "telegram", action: "configure" } })).toBeNull();
    expect(providerAuthMetaOf({ kind: "provider-sign-in", meta: null })).toBeNull();
  });
});
