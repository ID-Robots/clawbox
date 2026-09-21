/**
 * The NDJSON an install route answers with, read once for every surface.
 *
 * Every install on this box streams rather than answering JSON — a cold Jetson
 * spends minutes building and downloading, and a request that said nothing for
 * that long is indistinguishable from a hang. The shape the llama.cpp install
 * route set and the voice, memory-model, Whisper and GGUF routes all keep:
 * `{status}` lines while it works, optionally with `completed`/`total` bytes so
 * a bar can be drawn, then ONE closing line — `{success: true}` or `{error}`.
 *
 * This lived inside LocalAiPanel while the panel had two install buttons. It is
 * a module now because four cards read the same stream, and because a torn
 * write, a missing trailing newline and a stream that ends with no verdict are
 * three mistakes nobody should make twice.
 *
 * Client-safe: streams and JSON, no node builtins.
 */

export interface InstallProgress {
  /** The line to show. Absent on a payload that only moved the bar. */
  status?: string;
  /** Bytes fetched so far, when the route can say. */
  completed?: number;
  /** Bytes in total, when the route can say. */
  total?: number;
}

export interface InstallOutcome {
  ok: boolean;
  error?: string;
}

/** `completed`/`total` as a whole percentage, or null when there is no bar to draw. */
export function progressPercent(progress: InstallProgress | null | undefined): number | null {
  if (!progress) return null;
  const { completed, total } = progress;
  if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) return null;
  const done = typeof completed === "number" && Number.isFinite(completed) ? completed : 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Consume one line. Answers the outcome when the line was the closing one,
 * `null` while the stream goes on — including for a line that is not JSON,
 * which is a torn write rather than a failure.
 */
function consume(line: string, onProgress: (p: InstallProgress) => void): InstallOutcome | null {
  if (!line) return null;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== "object") return null;

  const status = typeof payload.status === "string" ? payload.status : undefined;
  const completed = readNumber(payload.completed);
  const total = readNumber(payload.total);
  if (status !== undefined || completed !== undefined || total !== undefined) {
    onProgress({ status, completed, total });
  }
  if (typeof payload.error === "string") return { ok: false, error: payload.error };
  if (payload.success === true) return { ok: true };
  return null;
}

/**
 * Read an install stream to its verdict.
 *
 * A stream that ends with neither a success nor an error is a FAILURE: the
 * server went away mid-install, and reporting that as "done" would leave the
 * owner with a row that says installed over a box that is not.
 */
export async function readInstallStream(
  res: Response,
  onProgress: (progress: InstallProgress) => void,
): Promise<InstallOutcome> {
  const reader = res.body?.getReader();
  if (!reader) return { ok: false };
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const outcome = consume(line, onProgress);
      if (outcome) return outcome;
    }
    if (done) break;
  }
  // The closing line may arrive without its newline; it still decides the
  // outcome — dropping it turned a finished multi-minute install into an error.
  return consume(buffer.trim(), onProgress) ?? { ok: false };
}
