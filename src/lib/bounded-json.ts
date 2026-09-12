/**
 * A JSON object body, read under a byte cap.
 *
 * WHY IT EXISTS. `request.json()` buffers and parses whatever arrives, and
 * neither Next's config nor `production-server.js` puts a limit in front of a
 * route handler — so a caller past a route's own gate could make this appliance
 * hold and parse an arbitrary body before any field check looked at it. That
 * was found in review on `coding-agent/secrets`; this is that fix, lifted out
 * of the one route so the next small-body route does not have to re-derive it.
 *
 * TWO CHECKS, AND BOTH ARE NEEDED. `Content-Length` is free and answers before
 * a byte is read — but a chunked request declares none, so the header alone
 * bounds exactly the callers that were never the problem. The METER
 * (src/lib/bounded-body.ts, the same one the upload routes use) counts what
 * actually arrives and errors the source past the cap.
 *
 * WHY THE ANSWER IS A THREE-WAY. "Too long" and "not JSON" need different
 * statuses — one says "send less", the other "send something else" — and a
 * route that could not tell them apart would answer 400 to a request whose only
 * fault was its size.
 */

import { boundedBody } from "@/lib/bounded-body";

/** Too big, not an object this route can use, or the object itself. */
export type JsonBodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; reason: "too_long" | "invalid" };

/**
 * Does the request ANNOUNCE more than the cap?
 *
 * A header read and nothing else, so it is worth asking even on a path that
 * never touches the body — a DELETE with a query string reads no body at all,
 * which is why a stream cannot cost that path anything, but a request that says
 * it is sending megabytes has no business being answered. Exported because
 * those verbs call it on its own.
 */
export function declaredTooLong(request: Request, limit: number): boolean {
  const declared = Number(request.headers.get("content-length"));
  return Number.isFinite(declared) && declared > limit;
}

/** Read the body as a JSON object, metered. */
export async function readJsonObject(request: Request, limit: number, message = "That request body is too large."): Promise<JsonBodyResult> {
  if (declaredTooLong(request, limit)) return { ok: false, reason: "too_long" };
  if (!request.body) return { ok: false, reason: "invalid" };

  const bounded = boundedBody(request.body, { limit, message });
  let text: string;
  try {
    text = await new Response(bounded.stream).text();
  } catch {
    // The meter cut the source, or the connection dropped. Only the first is
    // the caller's fault, and `overflowed()` is what tells them apart — never
    // the message, for the reason bounded-body's own header gives.
    return { ok: false, reason: bounded.overflowed() ? "too_long" : "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // An ARRAY is not an object body: `typeof [] === "object"`, and a route that
  // let one through would read `body.name` as undefined and refuse for the
  // wrong reason.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "invalid" };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}
