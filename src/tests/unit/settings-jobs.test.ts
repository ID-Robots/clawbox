/**
 * src/lib/settings-jobs.ts — the one shared helper for Settings actions that
 * are not instant (TASK-2148): a route's own handler run as a job of the box
 * when Settings asks `background: true`, ending with the handler's own answer
 * (status kept); the same ask answered by the running job, any other refused.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getBackgroundTask, resetBackgroundTasksForTests, type BackgroundTaskView } from "@/lib/background-tasks";
import { CHANNEL_SETUP_GROUP, CHANNEL_SETUP_KIND } from "@/lib/background-task-kinds";
import {
  askFingerprint,
  backgroundAskOf,
  outcomeOf,
  routeAsSettingsJob,
  settingsJobMetaOf,
  type RouteJobSpec,
} from "@/lib/settings-jobs";

let root: string;
let savedRoot: string | undefined;

beforeEach(() => {
  savedRoot = process.env.CLAWBOX_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-jobs-"));
  process.env.CLAWBOX_ROOT = root;
  resetBackgroundTasksForTests();
});

afterEach(() => {
  resetBackgroundTasksForTests();
  if (savedRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = savedRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function post(body: unknown, url = "http://box/setup-api/telegram/configure", method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}

function spec(handler: RouteJobSpec["handler"], over: Partial<RouteJobSpec> = {}): RouteJobSpec {
  return {
    path: "/setup-api/telegram/configure",
    kind: CHANNEL_SETUP_KIND,
    group: CHANNEL_SETUP_GROUP,
    busyCode: "channel_change_running",
    describe: () => ({
      subject: "telegram",
      action: "configure",
      label: "Telegram",
      title: "Setting up Telegram",
      status: "Saving the Telegram bot…",
      done: "Telegram is set up.",
    }),
    handler,
    ...over,
  };
}

async function ended(id: string): Promise<BackgroundTaskView> {
  await vi.waitFor(() => expect(getBackgroundTask(id)?.state).not.toBe("running"));
  return getBackgroundTask(id)!;
}

describe("routeAsSettingsJob", () => {
  it("leaves a request that does not ask for a job to the route", async () => {
    const handler = vi.fn();
    expect(await routeAsSettingsJob(post({ botToken: "1:abc" }), spec(handler))).toBeNull();
    expect(await routeAsSettingsJob(post("not json"), spec(handler))).toBeNull();
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the route's own handler as a job, with the same body, and ends with its answer", async () => {
    const handler = vi.fn(async (request: Request) => json({ success: true, echoed: await request.json() }));
    const res = await routeAsSettingsJob(post({ botToken: "1:abc", background: true }), spec(handler));
    expect(res?.status).toBe(202);
    const { taskId, task } = await res!.json();
    expect(task).toMatchObject({ kind: "channel-setup", group: "channel-setup", title: "Setting up Telegram" });
    expect(settingsJobMetaOf(task)).toEqual({ subject: "telegram", action: "configure", label: "Telegram", ask: expect.stringMatching(/^[0-9a-f]{32}$/) });
    const done = await ended(taskId);
    expect(done.state).toBe("succeeded");
    expect(done.result).toEqual({ success: true, echoed: { botToken: "1:abc" }, httpStatus: 200, status: "Telegram is set up." });
    // The secret it was asked with is not in the job's meta (only the
    // handler's own answer, echoed here on purpose, carries it).
    expect(JSON.stringify(task.meta)).not.toContain("1:abc");
  });

  it("keeps a success the route answered non-2xx, with its warning as the closing line", async () => {
    const handler = async () => json({ success: true, warning: "Saved; it will apply once the gateway is back." }, 502);
    const res = await routeAsSettingsJob(post({ botToken: "1:abc", background: true }), spec(handler));
    const done = await ended((await res!.json()).taskId);
    expect(done.state).toBe("succeeded");
    expect(done.result).toMatchObject({ httpStatus: 502, status: "Saved; it will apply once the gateway is back." });
  });

  it("fails with the route's own sentence and status — a 2xx that says success: false included", async () => {
    const refused = await routeAsSettingsJob(post({ botToken: "x", background: true }), spec(async () => json({ error: "Invalid bot token format" }, 400)));
    expect(await ended((await refused!.json()).taskId)).toMatchObject({
      state: "failed",
      error: "Invalid bot token format",
      result: { error: "Invalid bot token format", httpStatus: 400 },
    });
    resetBackgroundTasksForTests();
    const denied = await routeAsSettingsJob(post({ botToken: "y", background: true }), spec(async () => json({ success: false, error: "The bot cannot read messages." })));
    expect(await ended((await denied!.json()).taskId)).toMatchObject({ state: "failed", result: { success: false, httpStatus: 200 } });
  });

  it("never ends a card on a bare error code: its sentence, or the title with the code", async () => {
    const coded = async () => json({ error: "allowlist_unsupported", code: "allowlist_unsupported" }, 400);
    const named = await routeAsSettingsJob(post({ allowedUsers: ["1"], background: true }), spec(coded, {
      messages: { allowlist_unsupported: "This box's WhatsApp has no allowed-numbers list." },
    }));
    expect(await ended((await named!.json()).taskId)).toMatchObject({
      state: "failed",
      error: "This box's WhatsApp has no allowed-numbers list.",
      // The code stays in the result for the caller that translates it.
      result: { error: "allowlist_unsupported", code: "allowlist_unsupported", httpStatus: 400 },
    });
    resetBackgroundTasksForTests();
    const bare = await routeAsSettingsJob(post({ allowedUsers: ["2"], background: true }), spec(coded));
    expect((await ended((await bare!.json()).taskId)).error).toBe("Setting up Telegram did not finish (allowlist_unsupported).");
  });

  it("answers the same ask with the running job, and refuses another one of the group", async () => {
    let release!: () => void;
    const handler = vi.fn(() => new Promise<Response>((resolve) => { release = () => resolve(json({ success: true })); }));
    const first = await (await routeAsSettingsJob(post({ botToken: "1:abc", background: true }), spec(handler)))!.json();
    const again = await routeAsSettingsJob(post({ botToken: "1:abc", background: true }), spec(handler));
    expect(again?.status).toBe(202);
    expect(await again!.json()).toMatchObject({ taskId: first.taskId, started: false });
    const other = await routeAsSettingsJob(post({ botToken: "2:def", background: true }), spec(handler));
    expect(other?.status).toBe(409);
    expect(await other!.json()).toEqual({
      error: "Setting up Telegram is still running on this box. Try again when it has finished.",
      code: "channel_change_running",
      kind: "channel_change_running",
      taskId: first.taskId,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release();
    await ended(first.taskId);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("takes a body-less DELETE's ask from ?background=1 and calls the handler the same way", async () => {
    const handler = vi.fn(async (request: Request) => json({ success: true, method: request.method }));
    const res = await routeAsSettingsJob(
      post(undefined, "http://box/setup-api/email/configure?background=1", "DELETE"),
      spec(handler, { path: "/setup-api/email/configure", method: "DELETE" }),
    );
    const done = await ended((await res!.json()).taskId);
    expect(done.result).toMatchObject({ success: true, method: "DELETE" });
  });
});

describe("the pieces", () => {
  it("backgroundAskOf reads a copy, and only a JSON object that asks", async () => {
    const request = post({ a: 1, background: true });
    expect(await backgroundAskOf(request)).toEqual({ a: 1 });
    expect(await request.json()).toEqual({ a: 1, background: true });
    expect(await backgroundAskOf(post({ a: 1 }))).toBeNull();
    expect(await backgroundAskOf(post(["background"]))).toBeNull();
    expect(await backgroundAskOf(post(undefined, "http://box/x?background=1", "DELETE"))).toEqual({});
  });

  it("outcomeOf reads a success said beside a non-2xx, and a failure said beside a 2xx", async () => {
    expect(await outcomeOf(json({ success: true }, 502))).toMatchObject({ ok: true, httpStatus: 502 });
    expect(await outcomeOf(json({ success: false }))).toMatchObject({ ok: false, httpStatus: 200 });
    expect(await outcomeOf(json({ error: "no" }, 500))).toMatchObject({ ok: false });
    expect(await outcomeOf(new Response("<html>", { status: 200 }))).toMatchObject({ ok: true, body: {} });
  });

  it("askFingerprint ignores key order and differs for different values", () => {
    expect(askFingerprint({ a: 1, b: "x" })).toBe(askFingerprint({ b: "x", a: 1 }));
    expect(askFingerprint({ a: 1, b: "x" })).not.toBe(askFingerprint({ a: 1, b: "y" }));
  });
});
