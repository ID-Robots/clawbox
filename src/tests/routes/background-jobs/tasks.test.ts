import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/owner-session", () => ({ hasPersonSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => ({ requireSession: vi.fn() }));

import { GET as followGET } from "@/app/setup-api/background-jobs/tasks/follow/route";
import { GET, POST } from "@/app/setup-api/background-jobs/tasks/route";
import { resetBackgroundTasksForTests, startBackgroundTask } from "@/lib/background-tasks";
import { hasPersonSession } from "@/lib/owner-session";
import { requireSession } from "@/lib/route-auth";

// The list the desktop's corner card polls and a reopened Settings reads, the
// stream a panel re-attaches through, and the dismiss the card's X sends.

let root: string;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

function startDemo(kind = "demo", gate = deferred()) {
  const started = startBackgroundTask({
    kind,
    title: "Demo install",
    status: "Starting…",
    steps: [{ id: "a", label: "A" }],
    async run(task) {
      task.step("a");
      for (let i = 0; i < 60; i += 1) task.log(`line ${i}`);
      await gate.promise;
      return { status: "Installed." };
    },
  });
  if (!started.started) throw new Error("not started");
  return { id: started.task.id, gate };
}

function sameOrigin(body: unknown): Request {
  return new Request("http://box/setup-api/background-jobs/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://box", Host: "box" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "bg-tasks-route-"));
  vi.stubEnv("CLAWBOX_ROOT", root);
  resetBackgroundTasksForTests();
  (requireSession as Mock).mockResolvedValue(null);
  (hasPersonSession as Mock).mockResolvedValue(true);
});

afterEach(() => {
  resetBackgroundTasksForTests();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /setup-api/background-jobs/tasks", () => {
  it("needs a session", async () => {
    (requireSession as Mock).mockResolvedValue(new Response(null, { status: 401 }));
    expect((await GET(new Request("http://box/setup-api/background-jobs/tasks"))).status).toBe(401);
  });

  it("lists the tasks with only the tail of each log, and narrows by kind", async () => {
    const { id, gate } = startDemo("demo");
    startDemo("other");
    await new Promise((r) => setImmediate(r));
    const all = await (await GET(new Request("http://box/setup-api/background-jobs/tasks"))).json();
    expect(all.tasks).toHaveLength(2);
    const demo = all.tasks.find((t: { id: string }) => t.id === id);
    expect(demo).toMatchObject({ kind: "demo", state: "running", title: "Demo install" });
    expect(demo.log.length).toBeLessThanOrEqual(40);
    expect(demo.log.at(-1)).toBe("line 59");

    const narrowed = await (await GET(new Request("http://box/setup-api/background-jobs/tasks?kind=demo"))).json();
    expect(narrowed.tasks.map((t: { id: string }) => t.id)).toEqual([id]);

    const one = await (await GET(new Request(`http://box/setup-api/background-jobs/tasks?id=${id}`))).json();
    // The whole ring: the first headline and the sixty lines after it.
    expect(one.task.log.length).toBe(61);
    gate.resolve();
  });

  it("answers 404 for an unknown task", async () => {
    expect((await GET(new Request("http://box/setup-api/background-jobs/tasks?id=nope"))).status).toBe(404);
  });
});

describe("POST /setup-api/background-jobs/tasks (dismiss)", () => {
  it("is a person's browser's, from this box's own pages", async () => {
    (hasPersonSession as Mock).mockResolvedValue(false);
    expect((await POST(sameOrigin({ id: "x", action: "dismiss" }))).status).toBe(403);
  });

  it("refuses a malformed body", async () => {
    expect((await POST(sameOrigin(null))).status).toBe(400);
    expect((await POST(sameOrigin({ id: 1, action: "dismiss" }))).status).toBe(400);
    expect((await POST(sameOrigin({ id: "x", action: "stop" }))).status).toBe(400);
  });

  it("dismisses an ended task, refuses a running one, 404s an unknown one", async () => {
    const { id, gate } = startDemo();
    expect((await POST(sameOrigin({ id, action: "dismiss" }))).status).toBe(409);
    gate.resolve();
    await vi.waitFor(async () => {
      const one = await (await GET(new Request(`http://box/setup-api/background-jobs/tasks?id=${id}`))).json();
      expect(one.task.state).toBe("succeeded");
    });
    const res = await POST(sameOrigin({ id, action: "dismiss" }));
    expect(res.status).toBe(200);
    expect((await res.json()).task.dismissed).toBe(true);
    expect((await POST(sameOrigin({ id: "nope", action: "dismiss" }))).status).toBe(404);
  });
});

describe("POST /setup-api/background-jobs/tasks (cancel)", () => {
  function startStoppable() {
    const started = startBackgroundTask({
      kind: "fetch",
      title: "Downloading",
      cancellable: true,
      run: (task) => new Promise((_, reject) => task.signal.addEventListener("abort", () => reject(new Error("stopped")))),
    });
    if (!started.started) throw new Error("not started");
    return started.task.id;
  }

  it("is a person's browser's, from this box's own pages — never the agent's bearer", async () => {
    const id = startStoppable();
    (hasPersonSession as Mock).mockResolvedValue(false);
    expect((await POST(sameOrigin({ id, action: "cancel" }))).status).toBe(403);
    (hasPersonSession as Mock).mockResolvedValue(true);
    const crossSite = new Request("http://box/setup-api/background-jobs/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://evil.example", Host: "box" },
      body: JSON.stringify({ id, action: "cancel" }),
    });
    expect((await POST(crossSite)).status).toBe(403);
    const one = await (await GET(new Request(`http://box/setup-api/background-jobs/tasks?id=${id}`))).json();
    expect(one.task.state).toBe("running");
    expect(one.task.cancelRequested).toBe(false);
  });

  it("stops a cancellable task, which then ends cancelled", async () => {
    const id = startStoppable();
    await new Promise((r) => setImmediate(r));
    const res = await POST(sameOrigin({ id, action: "cancel" }));
    expect(res.status).toBe(200);
    expect((await res.json()).task.cancelRequested).toBe(true);
    await vi.waitFor(async () => {
      const one = await (await GET(new Request(`http://box/setup-api/background-jobs/tasks?id=${id}`))).json();
      expect(one.task.state).toBe("cancelled");
    });
  });

  it("refuses a task that cannot stop safely, one that has ended, and an unknown one", async () => {
    const { id, gate } = startDemo();
    const fixed = await POST(sameOrigin({ id, action: "cancel" }));
    expect(fixed.status).toBe(409);
    expect((await fixed.json()).code).toBe("not_cancellable");
    gate.resolve();
    await vi.waitFor(async () => {
      const one = await (await GET(new Request(`http://box/setup-api/background-jobs/tasks?id=${id}`))).json();
      expect(one.task.state).toBe("succeeded");
    });
    const ended = await POST(sameOrigin({ id, action: "cancel" }));
    expect(ended.status).toBe(409);
    expect((await ended.json()).code).toBe("not_running");
    expect((await POST(sameOrigin({ id: "nope", action: "cancel" }))).status).toBe(404);
  });
});

describe("GET /setup-api/background-jobs/tasks/follow", () => {
  it("re-attaches to a running task as the install routes' NDJSON, to its verdict", async () => {
    const { id, gate } = startDemo();
    const res = await followGET(new Request(`http://box/setup-api/background-jobs/tasks/follow?id=${id}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/x-ndjson");
    gate.resolve();
    const lines = (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[0]).toMatchObject({ taskId: id, kind: "demo" });
    expect(lines.at(-1)).toEqual({ status: "Installed.", success: true, taskId: id });
  });

  it("answers 404 for an unknown or missing id", async () => {
    expect((await followGET(new Request("http://box/setup-api/background-jobs/tasks/follow?id=nope"))).status).toBe(404);
    expect((await followGET(new Request("http://box/setup-api/background-jobs/tasks/follow"))).status).toBe(404);
  });
});
