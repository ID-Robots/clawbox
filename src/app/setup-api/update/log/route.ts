/**
 * GET /setup-api/update/log — the raw log of an update run (TASK-2428), as
 * Server-Sent Events from a byte offset, followed live like `tail -f`:
 *
 *   event: run    data: { id, startedAt, finished }  which run the bytes below belong to
 *   id: <run>:<offset>
 *   data: "<text>"                                   the log's next bytes, as a JSON string
 *   event: end    data: { id, outcome }              the run is over and everything was sent
 *   event: none   data: {}                           no update has written a log yet
 *
 * `?run=<id>` names a run (default: the newest), `?offset=<bytes>` where to
 * start. A reconnecting EventSource sends the last `id:` back as
 * `Last-Event-ID`, so a dropped connection and a web server that was replaced
 * in the middle of the update continue from the byte they stopped at; a page
 * opening a new stream on bytes it already has passes the same id as
 * `?after=<run>:<offset>`. Either is honoured only for the run it names (the
 * header first); any other run is sent from its start. A reloaded page has
 * nothing on screen and reads the run from byte 0. Following the newest run, a
 * newer one starting is announced with another `run` event, from byte 0.
 *
 * `?download=1` answers the whole log as a file instead.
 *
 * The bytes are the file's, which update-raw-log.ts redacted as it wrote them.
 * Owner-only: it is the box's own system output.
 */
import { requireSession, sessionIdentity } from "@/lib/route-auth";
import {
  UPDATE_LOG_ID_RE,
  latestUpdateLog,
  parseUpdateLogResumeId,
  readUpdateLogChunk,
  updateLogFile,
  updateLogInfo,
  type UpdateLogInfo,
} from "@/lib/update-raw-log";
import fs from "fs";
import { Readable } from "stream";

export const dynamic = "force-dynamic";

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;
const SESSION_RECHECK_MS = 5_000;
/** Per event: the client writes each into the terminal as it comes. */
const CHUNK_BYTES = 64 * 1024;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function parseOffset(value: string | null): number | null {
  if (value === null || value === "") return 0;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

async function download(runParam: string | null): Promise<Response> {
  const info = runParam ? await updateLogInfo(runParam) : await latestUpdateLog();
  const file = info ? updateLogFile(info.id) : null;
  if (!info || !file) return json(404, { error: "No update log", code: "not_found" });
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file);
  } catch {
    return json(404, { error: "No update log", code: "not_found" });
  }
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="clawbox-update-${info.id}.log"`,
      "Cache-Control": "no-store",
    },
  });
}

export async function GET(req: Request) {
  const denied = await requireSession(req, { ownerOnly: true });
  if (denied) return denied;

  const url = new URL(req.url);
  const runParam = url.searchParams.get("run");
  if (runParam !== null && !UPDATE_LOG_ID_RE.test(runParam)) {
    return json(400, { error: "Not an update log id", code: "bad_run" });
  }
  if (url.searchParams.get("download") === "1") return download(runParam);

  const queryOffset = parseOffset(url.searchParams.get("offset"));
  if (queryOffset === null) return json(400, { error: "offset must be a whole number of bytes", code: "bad_offset" });
  // The browser's reconnect says where it was in Last-Event-ID; a page that
  // opens a new stream on bytes it already has says it in `after`.
  const resume = parseUpdateLogResumeId(req.headers.get("last-event-id"))
    ?? parseUpdateLogResumeId(url.searchParams.get("after"));

  // A named run that is not on the box is a 404; the newest is waited for.
  if (runParam && !(await updateLogInfo(runParam))) {
    return json(404, { error: "No such update log", code: "not_found" });
  }
  const onSession = (await sessionIdentity(req)) !== null;

  const encoder = new TextEncoder();
  let cleanup = () => {};
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      stop = () => close();
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      // What is being sent: which run, and the next byte of it.
      let run: string | null = null;
      let offset = 0;
      let saidNone = false;

      const announce = (info: UpdateLogInfo, from: number) => {
        run = info.id;
        offset = Math.min(from, info.size);
        send(frame("run", { id: info.id, startedAt: info.startedAt, finished: info.finished }));
      };

      const pick = async (): Promise<UpdateLogInfo | null> =>
        runParam ? updateLogInfo(runParam) : latestUpdateLog();

      const step = async () => {
        timer = null;
        if (closed) return;
        try {
          const info = await pick();
          if (closed) return;
          if (!info) {
            if (!saidNone) {
              saidNone = true;
              send(frame("none", {}));
            }
          } else {
            if (run === null) {
              const from = resume && resume.run === info.id ? resume.offset : queryOffset;
              announce(info, from);
            } else if (run !== info.id) {
              // The newest run changed under a follower of "the newest".
              announce(info, 0);
            }
            // Everything there is, a chunk at a time — up to the recorded
            // size only (updateLogInfo says why).
            for (;;) {
              const chunk = await readUpdateLogChunk(info.id, offset, CHUNK_BYTES, info.size);
              if (closed) return;
              if (!chunk || chunk.next === offset) break;
              offset = chunk.next;
              send(`id: ${info.id}:${offset}\ndata: ${JSON.stringify(chunk.text)}\n\n`);
            }
            // Finished is read BEFORE the size it is compared with would let a
            // late write slip past: re-read it after the drain.
            const after = await updateLogInfo(info.id);
            if (closed) return;
            if (after && after.finished && offset >= after.size) {
              send(frame("end", { id: info.id, outcome: after.outcome ?? null }));
              close();
              return;
            }
          }
        } catch {
          // A read that failed is tried again on the next tick.
        }
        if (!closed) timer = setTimeout(() => void step(), POLL_MS);
      };

      send("retry: 3000\n\n");
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      heartbeat.unref?.();
      const sessionCheck = onSession
        ? setInterval(() => {
          void sessionIdentity(req).then((who) => { if (!who) close(); }, () => {});
        }, SESSION_RECHECK_MS)
        : null;
      sessionCheck?.unref?.();
      const onAbort = () => close();
      req.signal.addEventListener("abort", onAbort, { once: true });
      cleanup = () => {
        clearInterval(heartbeat);
        if (sessionCheck) clearInterval(sessionCheck);
        if (timer) clearTimeout(timer);
        req.signal.removeEventListener("abort", onAbort);
      };
      void step();
    },
    cancel() {
      // The reader went away: stop the follow loop too, not only its timers.
      stop();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform: the response compressor leaves a stream alone, so each
      // event reaches the page when it is sent rather than when a buffer fills.
      "Cache-Control": "no-store, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
