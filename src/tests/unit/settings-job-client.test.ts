import { afterEach, describe, expect, it, vi } from "vitest";
import { settingsJobFetch, settingsJobOf } from "@/lib/settings-job-client";
import type { BackgroundTaskView } from "@/lib/background-task-client";

/**
 * `settingsJobFetch` (TASK-2148): a Settings action asked of the box as a job
 * — `background: true` in the JSON body, `?background=1` for a body-less
 * request — followed to its end, and answered as the Response its route would
 * have answered in-request, so the caller's own handling reads it unchanged.
 */

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function task(state: string, result: Record<string, unknown> | null, error: string | null = null) {
  return { id: "j1", kind: "channel-setup", group: "channel-setup", state, steps: [], result, error, meta: {} };
}

/** A box that starts j1 and answers its record from `states`, one per read. */
function stubBox(states: Array<ReturnType<typeof task>>, start: Response = json({ taskId: "j1", started: true }, 202)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    if (url.startsWith("/setup-api/background-jobs/tasks?id=j1")) return json({ task: states.shift() ?? task("running", null) });
    return start.clone();
  }));
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("settingsJobFetch", () => {
  it("asks for a job, follows it, and answers the route's own answer — status and body", async () => {
    const calls = stubBox([task("running", null), task("succeeded", { success: true, warning: "Saved; not serving yet.", httpStatus: 502 })]);
    const started = vi.fn();
    const res = await settingsJobFetch("/setup-api/telegram/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ botToken: "1:abc" }),
    }, { onStarted: started });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ botToken: "1:abc", background: true });
    expect(started).toHaveBeenCalledWith("j1");
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ success: true, warning: "Saved; not serving yet.", taskId: "j1" });
  });

  it("asks a body-less request with ?background=1", async () => {
    const calls = stubBox([task("succeeded", { success: true, httpStatus: 200 })]);
    const res = await settingsJobFetch("/setup-api/email/configure", { method: "DELETE" });
    expect(calls[0].url).toBe("/setup-api/email/configure?background=1");
    expect(res.status).toBe(200);
  });

  it("answers a failed job as its route's failure: its status, its sentence", async () => {
    stubBox([task("failed", { error: "Invalid bot token format", httpStatus: 400 }, "Invalid bot token format")]);
    const res = await settingsJobFetch("/x", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "Invalid bot token format" });
  });

  it("keeps a failure the route answered 200 (success: false) as the caller expects it", async () => {
    stubBox([task("failed", { success: false, error: "The bot cannot read messages.", httpStatus: 200 }, "The bot cannot read messages.")]);
    const res = await settingsJobFetch("/x", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: false });
  });

  it("a job that ended with no status of its own is a 500, never a success", async () => {
    stubBox([task("failed", null, "The ClawBox web server restarted while this was running.")]);
    const res = await settingsJobFetch("/x", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "The ClawBox web server restarted while this was running." });
  });

  it("hands back an answer the route gave in-request (a refusal said at once) as it is", async () => {
    const calls = stubBox([], json({ error: "Setting up Telegram is still running on this box.", code: "channel_change_running" }, 409));
    const res = await settingsJobFetch("/x", { method: "POST", body: JSON.stringify({}) });
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(1);
  });

  it("rejects with an AbortError when its reader leaves — the job goes on on the box", async () => {
    stubBox(Array.from({ length: 50 }, () => task("running", null)));
    const abort = new AbortController();
    const following = settingsJobFetch("/x", { method: "POST", body: JSON.stringify({}), signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    abort.abort();
    await expect(following).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("settingsJobOf", () => {
  it("reads a settings job's subject and action, and nothing of another task", () => {
    const view = { id: "j1", kind: "channel-setup", group: "channel-setup", title: "Setting up Telegram", meta: { subject: "telegram", action: "configure", label: "Telegram" }, state: "running", steps: [{ id: "apply", state: "running" }], status: "Saving…", error: null, result: null, startedAt: 1, finishedAt: null } as unknown as BackgroundTaskView;
    expect(settingsJobOf(view)).toMatchObject({ subject: "telegram", action: "configure", label: "Telegram", step: "apply", status: "Saving…" });
    expect(settingsJobOf({ ...view, kind: "llamacpp-install" } as BackgroundTaskView)).toBeNull();
    expect(settingsJobOf({ ...view, meta: { action: "configure" } } as BackgroundTaskView)).toBeNull();
  });
});
