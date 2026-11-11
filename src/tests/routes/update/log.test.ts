/**
 * GET /setup-api/update/log (TASK-2428): the raw update log from a byte
 * offset, followed live, resumed after a dropped connection or a replaced web
 * server from the event id the browser sends back, and downloadable whole.
 * The log files are written by the real update-raw-log module into the
 * session fixture's root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import {
  closeUpdateLog,
  openUpdateLog,
  resetUpdateLogForTests,
  updateLogDir,
  writeUpdateLog,
} from "@/lib/update-raw-log";

type Get = (req: Request) => Promise<Response>;

interface SseEvent { event: string; id?: string; data: unknown }

let session: SessionFixture;
let GET: Get;

function request(query = "", headers: Record<string, string> = {}, signal?: AbortSignal): Request {
  return new Request(`http://localhost/setup-api/update/log${query}`, {
    headers: { Cookie: session.cookie, ...headers },
    signal,
  });
}

/** Events off the stream until `done` says stop (or the stream ends); then the connection is dropped. */
async function events(res: Response, done: (seen: SseEvent[]) => boolean, abort?: AbortController, timeoutMs = 5_000): Promise<SseEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const seen: SseEvent[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined; timeout: true }>((resolve) => setTimeout(() => resolve({ done: true, value: undefined, timeout: true }), Math.max(1, deadline - Date.now()))),
    ]);
    if ("timeout" in next) break;
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const ev: SseEvent = { event: "message", data: undefined };
      let data: string | null = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) ev.event = line.slice(7);
        else if (line.startsWith("id: ")) ev.id = line.slice(4);
        else if (line.startsWith("data: ")) data = line.slice(6);
      }
      if (data === null) continue;
      ev.data = JSON.parse(data);
      seen.push(ev);
    }
    if (done(seen)) break;
  }
  abort?.abort();
  await reader.cancel().catch(() => {});
  return seen;
}

const text = (seen: SseEvent[]) => seen.filter((e) => e.event === "message").map((e) => e.data as string).join("");
const ended = (seen: SseEvent[]) => seen.some((e) => e.event === "end");

function fileOf(id: string): string {
  return fs.readFileSync(path.join(updateLogDir(), `${id}.log`), "utf8");
}

async function finishedRun(lines: string[]): Promise<string> {
  const id = (await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" }))!;
  for (const line of lines) await writeUpdateLog(line);
  await closeUpdateLog("completed");
  return id;
}

beforeEach(async () => {
  session = installSessionFixture();
  await resetUpdateLogForTests();
  ({ GET } = await import("@/app/setup-api/update/log/route"));
});

afterEach(async () => {
  await resetUpdateLogForTests();
  const root = session.root;
  session.cleanup();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /setup-api/update/log", () => {
  it("needs the owner's session", async () => {
    const res = await GET(new Request("http://localhost/setup-api/update/log"));
    expect(res.status).toBe(401);
  });

  it("streams a finished run from byte 0 — exactly the file, ANSI and all — then says it ended", async () => {
    const id = await finishedRun(["\x1b[32mok\x1b[0m line one\n", "50%\r100%\n", "Обновено ✓\n"]);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const seen = await events(res, ended);
    expect(seen[0]).toMatchObject({ event: "run", data: { id, finished: true } });
    expect(text(seen)).toBe(fileOf(id));
    const last = seen.filter((e) => e.event === "message").at(-1)!;
    expect(last.id).toBe(`${id}:${Buffer.byteLength(fileOf(id))}`);
    expect(seen.at(-1)).toMatchObject({ event: "end", data: { id, outcome: "completed" } });
  });

  it("resumes from the offset in Last-Event-ID — a reconnect, or a server that was replaced — and sends the rest only", async () => {
    const id = await finishedRun(["first half\n", "second half\n"]);
    const whole = fileOf(id);
    const cut = Buffer.byteLength(whole.slice(0, whole.indexOf("second half")));
    const seen = await events(await GET(request("", { "Last-Event-ID": `${id}:${cut}` })), ended);
    expect(text(seen)).toBe(whole.slice(whole.indexOf("second half")));
  });

  it("takes the same resume point as ?after= from a page that already has the bytes, and ignores one for another run", async () => {
    const id = await finishedRun(["first half\n", "second half\n"]);
    const whole = fileOf(id);
    const cut = Buffer.byteLength(whole.slice(0, whole.indexOf("second half")));
    const resumed = await events(await GET(request(`?after=${encodeURIComponent(`${id}:${cut}`)}`)), ended);
    expect(text(resumed)).toBe(whole.slice(whole.indexOf("second half")));
    const other = await events(await GET(request("", { "Last-Event-ID": `20200101T000000000Z-dead:${cut}` })), ended);
    expect(text(other)).toBe(whole);
  });

  it("starts at ?offset= and refuses one that is not a byte count", async () => {
    const id = await finishedRun(["0123456789\n"]);
    const whole = fileOf(id);
    const seen = await events(await GET(request("?offset=5")), ended);
    expect(text(seen)).toBe(Buffer.from(whole).subarray(5).toString("utf8"));
    expect((await GET(request("?offset=-1"))).status).toBe(400);
    expect((await GET(request("?offset=abc"))).status).toBe(400);
  });

  it("follows a run that is still being written, like tail -f, until it ends", async () => {
    const id = (await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" }))!;
    await writeUpdateLog("step one\n");
    const abort = new AbortController();
    const res = await GET(request("", {}, abort.signal));
    const reading = events(res, ended, abort, 8_000);
    await new Promise((resolve) => setTimeout(resolve, 700));
    await writeUpdateLog("step two\n");
    await new Promise((resolve) => setTimeout(resolve, 700));
    await closeUpdateLog("failed", "gateway did not start");
    const seen = await reading;
    expect(seen[0]).toMatchObject({ event: "run", data: { id, finished: false } });
    expect(text(seen)).toBe(fileOf(id));
    expect(text(seen)).toContain("step two\n");
    expect(seen.at(-1)).toMatchObject({ event: "end", data: { outcome: "failed" } });
  });

  it("reads a named run with ?run=, and the newest by default", async () => {
    const first = await finishedRun(["old run\n"]);
    const abort = new AbortController();
    const second = (await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" }))!;
    await writeUpdateLog("new run, line 1\n");
    const res = await GET(request(`?run=${first}`, {}, abort.signal));
    const old = await events(res, ended, abort);
    expect(text(old)).toBe(fileOf(first));
    const live = new AbortController();
    const reading = events(await GET(request("", {}, live.signal)), ended, live, 8_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await closeUpdateLog("completed");
    const seen = await reading;
    expect(seen[0]).toMatchObject({ event: "run", data: { id: second } });
    expect(text(seen)).toBe(fileOf(second));
  });

  it("says when no update has written a log, and keeps waiting for one", async () => {
    const abort = new AbortController();
    const reading = events(await GET(request("", {}, abort.signal)), (seen) => seen.some((e) => e.event === "message"), abort, 8_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const id = (await openUpdateLog({ fresh: true, flow: "update", title: "ClawBox update" }))!;
    const seen = await reading;
    expect(seen[0]).toMatchObject({ event: "none" });
    expect(seen[1]).toMatchObject({ event: "run", data: { id } });
    expect(text(seen)).toContain("ClawBox update");
  });

  it("downloads the whole log as a file", async () => {
    const id = await finishedRun(["\x1b[31mred\x1b[0m\n"]);
    const res = await GET(request("?download=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="clawbox-update-${id}.log"`);
    expect(await res.text()).toBe(fileOf(id));
    expect((await GET(request(`?download=1&run=${id}`))).status).toBe(200);
  });

  it("answers 400 for a run id that is not one and 404 for a run it has no log of", async () => {
    expect((await GET(request("?run=../../etc/passwd"))).status).toBe(400);
    expect((await GET(request("?run=20200101T000000000Z-dead"))).status).toBe(404);
    expect((await GET(request("?download=1"))).status).toBe(404);
  });
});
