/**
 * GET /setup-api/prime-radiant/ingest/<id>/events — one ingest job's progress
 * as Server-Sent Events.
 *
 *   event: job    data: <IngestJob>               the job's tallies, on every change
 *   event: file   data: { seq, label, status, … } one file settled
 *   event: end    data: <IngestJob>               the job is over; the stream closes
 *
 * A running job replays its recent file events first, then streams live. A
 * job that is no longer running answers its final state and `end` at once,
 * so a client that reconnects after the end is never left waiting. A comment
 * line every 15 s keeps proxies from closing an idle stream. 404 for an id
 * this box has no job for. Read-only: never creates the state database.
 */
import { requireSession } from "@/lib/route-auth";
import { getIngestJob, safeJobId, subscribeIngest, type IngestEvent } from "@/lib/prime-radiant/ingest";
import { fail } from "@/lib/prime-radiant/route-helpers";

export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 15_000;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = await requireSession(req);
  if (denied) return denied;
  const id = safeJobId((await ctx.params).id);
  if (!id) return fail("not_found", "No such ingest job.", 404);
  const job = getIngestJob(id);
  if (!job) return fail("not_found", "No such ingest job.", 404);

  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
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
      const end = (final: unknown) => {
        send(frame("end", final));
        close();
      };

      if (job.status !== "running") {
        send(frame("job", job));
        end(job);
        return;
      }
      let unsubscribe: (() => void) | null = null;
      const onEvent = (e: IngestEvent) => {
        if (e.type === "job") {
          send(frame("job", e.job));
          if (e.job.status !== "running") end(e.job);
        } else {
          send(frame("file", { seq: e.seq, label: e.label, status: e.status, pages: e.pages, reason: e.reason }));
        }
      };
      unsubscribe = subscribeIngest(id, onEvent);
      if (!unsubscribe) {
        // It ended between the read above and the subscription.
        const final = getIngestJob(id) ?? job;
        send(frame("job", final));
        end(final);
        return;
      }
      const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
      heartbeat.unref?.();
      const onAbort = () => close();
      req.signal.addEventListener("abort", onAbort, { once: true });
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe?.();
        req.signal.removeEventListener("abort", onAbort);
      };
      if (closed) cleanup();
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
