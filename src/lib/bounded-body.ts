/**
 * A request body metered as it arrives, cut off past a limit.
 *
 * Counting the bytes as they pass rather than trusting Content-Length: a
 * chunked upload declares no length at all, so a header check bounds only the
 * callers that were never the problem. Erroring the transform cancels the
 * source, so someone pushing gigabytes stops being read one chunk after the
 * cap instead of at the end of their upload.
 *
 * The overflow is reported by the flag rather than by matching on what the
 * consumer rethrows, because what a multipart parser or a `pipeline` makes of
 * a cancelled source is its own business and not something to pin an HTTP
 * status on: `Readable.fromWeb` surfaces the transform's error as an ordinary
 * stream error and `pipeline` as a plain rejection, and the route in front
 * has to tell "the caller sent too much" from "the disk write failed" by
 * asking `overflowed()`, never by reading the message.
 *
 * The limit is a number or a function of the bytes ALREADY passed through:
 * a fixed cap for a route that knows its ceiling up front (the transcription
 * route's 8 MB), a re-measured one for a route whose ceiling is the disk's
 * free space, which other writers move while the upload runs. The function
 * is asked on every chunk; it is the policy's job to make that cheap.
 */
export type BodyLimit = number | ((bytesPassed: number) => number);

export interface BoundedBody {
  stream: ReadableStream<Uint8Array>;
  /** True once a chunk crossed the limit and the stream was errored. */
  overflowed: () => boolean;
  /** Bytes passed downstream so far (the overflowing chunk is not counted). */
  bytes: () => number;
}

export function boundedBody(
  body: ReadableStream<Uint8Array>,
  opts: { limit: BodyLimit; message?: string },
): BoundedBody {
  const limitOf = typeof opts.limit === "function" ? opts.limit : () => opts.limit as number;
  const message = opts.message ?? "request body exceeds its size limit";
  let total = 0;
  let over = false;
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // The ceiling is asked with what has ALREADY gone through, so a policy
        // that measures the disk sees the bytes that are (near enough) on it
        // and adds the room that is left; `>` rather than `>=` so a body that
        // is exactly the limit is accepted whole.
        const ceiling = limitOf(total);
        if (total + chunk.byteLength > ceiling) {
          over = true;
          controller.error(new Error(message));
          return;
        }
        total += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  return { stream, overflowed: () => over, bytes: () => total };
}
