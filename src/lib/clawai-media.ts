/**
 * The device half of the ClawBox AI proxy's SHARED media route. SERVER ONLY.
 *
 * Long-running media — a music track now, a video clip later — is one route on
 * the proxy, `<proxy>/media/<model>`, and one client here. It speaks the shape
 * OpenClaw's bundled `fal` provider already speaks to that same route on an
 * OpenClaw box (see `CLAWBOX_AI_MUSIC_PROVIDER`), so the proxy serves one
 * contract to both harnesses:
 *
 *   POST <proxy>/media/<model>   Authorization: Key <portal token>
 *        { prompt, lyrics?, instrumental? }
 *   → the result itself, or a queue handle
 *        { request_id, status_url, response_url }
 *     polled until `status` is COMPLETED, then the result fetched from
 *     `response_url`. The result names the file: `{ audio: { url, content_type } }`.
 *
 * The proxy holds the server-side provider key, the job and the per-plan weekly
 * cap; a spent cap is a 429 carrying {@link CLAWAI_MUSIC_LIMIT_CODE}. Accepting
 * both the immediate and the queued answer is deliberate: the proxy may answer
 * a short job inline and queue a long one, and the device must not care.
 *
 * VIDEO GENERATION IS DEFERRED. It is the same route with a video model id and
 * the same queue, and `fetchClawaiMediaFile` with a video kind; neither exists
 * until the proxy serves video and its own cost and cap are settled. Video
 * UNDERSTANDING is a different thing and needs none of this: it samples frames
 * and sends them to the vision model the box already uses
 * (src/lib/video-frames.ts).
 */
import { CLAWBOX_AI_MUSIC_MODEL_ID, clawboxAiMediaBaseUrl } from "@/lib/clawbox-ai-models";

/**
 * The proxy's refusal code for a spent weekly music cap.
 *
 * Deliberately NOT one of `CLAWAI_ALLOWANCE_CODES`: those are the chat and
 * coding-run allowances, worded in the chat bubble and the run's pause record,
 * and a music refusal reaches neither — it is answered here, by the route that
 * asked. Their reader cannot mistake this code for the weekly chat pool either:
 * `_` is a word character, so `\bweekly_limit_exceeded\b` finds no boundary
 * inside `music_weekly_limit_exceeded` (pinned in the tests).
 */
export const CLAWAI_MUSIC_LIMIT_CODE = "music_weekly_limit_exceeded";

/**
 * The whole job's wall-clock budget, polling included. A Lyria 3 Pro track
 * takes tens of seconds; four minutes is room for a queue ahead of it while
 * staying inside the 300 s Hermes gives one tool call (scripts/register-mcp.sh),
 * with the MCP tool's own budget sized between the two.
 */
export const CLAWAI_MEDIA_JOB_BUDGET_MS = 240_000;

/** How often a queued job is asked about. fal's own client polls on the same order. */
export const CLAWAI_MEDIA_POLL_MS = 5_000;

/**
 * The largest file accepted. OpenClaw's own default audio cap
 * (`agents.defaults.mediaMaxMb`), so a track either harness would keep is a
 * track this one keeps too.
 */
export const CLAWAI_MEDIA_MAX_BYTES = 16 * 1024 * 1024;

/** Why a media job did not produce a file — each has its own next step. */
export type ClawaiMediaFailure =
  /** The proxy does not serve this route or model yet. */
  | "not_served"
  /** The proxy refused the credential or the plan. */
  | "refused"
  /** The weekly cap is spent. */
  | "limit"
  /** The proxy or the upstream failed this job. */
  | "failed"
  /** The budget ran out first. */
  | "timeout";

export class ClawaiMediaError extends Error {
  constructor(
    readonly failure: ClawaiMediaFailure,
    message: string,
    /** ISO 8601 "frees up at" for a spent cap, when the proxy said. */
    readonly resetAt: string | null = null,
  ) {
    super(message);
    this.name = "ClawaiMediaError";
  }
}

/** Seams for the tests: the network, the clock and the wait. */
export interface ClawaiMediaDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
  pollMs?: number;
}

interface ResolvedDeps {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  deadline: number;
  pollMs: number;
}

function resolveDeps(deps: ClawaiMediaDeps): ResolvedDeps {
  const now = deps.now ?? Date.now;
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now,
    deadline: now() + (deps.budgetMs ?? CLAWAI_MEDIA_JOB_BUDGET_MS),
    pollMs: deps.pollMs ?? CLAWAI_MEDIA_POLL_MS,
  };
}

const RESET_AT_RE = /resetAt\\?"?\s*[:=]\s*\\?"?(\d{4}-\d{2}-\d{2}T[0-9:.]+(?:Z|[+-]\d{2}:?\d{2})?)/;

/** The proxy's sentence out of `{ error: { message } }` or `{ message }`, bounded. */
function proxyMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const message = typeof parsed.error === "object" && parsed.error !== null
      ? parsed.error.message
      : parsed.error ?? parsed.message ?? parsed.detail;
    return typeof message === "string" && message.trim() ? message.trim().slice(0, 300) : null;
  } catch {
    return null;
  }
}

/** A refused HTTP answer, as the failure it means. */
function failureFor(status: number, body: string): ClawaiMediaError {
  const said = proxyMessage(body);
  if (status === 429 && body.includes(CLAWAI_MUSIC_LIMIT_CODE)) {
    const at = RESET_AT_RE.exec(body)?.[1] ?? null;
    return new ClawaiMediaError(
      "limit",
      said ?? "This week's ClawBox AI music allowance is used up.",
      at && !Number.isNaN(Date.parse(at)) ? at : null,
    );
  }
  if (status === 401 || status === 403) {
    return new ClawaiMediaError("refused", said ?? "ClawBox AI refused this box's music request: the plan or the credential does not allow it.");
  }
  if (status === 404 || status === 405 || status === 501) {
    return new ClawaiMediaError("not_served", "The ClawBox AI proxy does not serve music yet.");
  }
  return new ClawaiMediaError("failed", said ?? `The ClawBox AI media route answered ${status}.`);
}

function remaining(deps: ResolvedDeps): number {
  return deps.deadline - deps.now();
}

/** One request inside the budget; a transport failure or an expired budget is a failure, never a throw of its own. */
async function request(url: string, init: RequestInit, deps: ResolvedDeps): Promise<Response> {
  const left = remaining(deps);
  if (left <= 0) throw new ClawaiMediaError("timeout", "The music track took too long to make.");
  try {
    return await deps.fetchImpl(url, { ...init, signal: AbortSignal.timeout(left) });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new ClawaiMediaError("timeout", "The music track took too long to make.");
    }
    throw new ClawaiMediaError("failed", "The ClawBox AI media route could not be reached.");
  }
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const body = await res.text().catch(() => "");
  if (!res.ok) throw failureFor(res.status, body);
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ClawaiMediaError("failed", "The ClawBox AI media route answered something this box could not read.");
}

/**
 * A queue URL the proxy handed back, or null when it is not on the proxy.
 *
 * The portal token rides on every poll, so a status or result URL on any other
 * origin is refused rather than followed: a proxy answer is not a licence to
 * mail the credential somewhere else.
 */
function sameOrigin(candidate: unknown, base: string): string | null {
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  try {
    const url = new URL(candidate.trim(), base);
    return url.origin === new URL(base).origin ? url.toString() : null;
  } catch {
    return null;
  }
}

/** fal's queue words; anything else that is not "done" or "failed" is still running. */
const DONE = new Set(["COMPLETED", "OK", "SUCCEEDED", "SUCCESS"]);
const FAILED = new Set(["FAILED", "ERROR", "CANCELLED", "CANCELED"]);

/**
 * Run one media job on the proxy and return its result object.
 *
 * The model id is the BARE one the proxy matches (`google/lyria-3-pro-preview`),
 * sent as path segments under `<proxy>/media`.
 */
export async function runClawaiMediaJob(
  options: { proxyUrl: string; token: string; model: string; input: Record<string, unknown> },
  deps: ClawaiMediaDeps = {},
): Promise<Record<string, unknown>> {
  const resolved = resolveDeps(deps);
  const base = clawboxAiMediaBaseUrl(options.proxyUrl);
  const modelPath = options.model.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const submitUrl = `${base}/${modelPath}`;
  const auth = { authorization: `Key ${options.token}` };

  const submitted = await readJson(await request(submitUrl, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify(options.input),
  }, resolved));

  const requestId = typeof submitted.request_id === "string" ? submitted.request_id : null;
  if (!requestId) return submitted;

  const statusUrl = sameOrigin(submitted.status_url ?? `${submitUrl}/requests/${encodeURIComponent(requestId)}/status`, base);
  const responseUrl = sameOrigin(submitted.response_url ?? `${submitUrl}/requests/${encodeURIComponent(requestId)}`, base);
  if (!statusUrl || !responseUrl) {
    throw new ClawaiMediaError("failed", "The ClawBox AI media route pointed this box away from itself; nothing was sent there.");
  }

  for (;;) {
    const wait = Math.min(resolved.pollMs, remaining(resolved));
    if (wait <= 0) throw new ClawaiMediaError("timeout", "The music track took too long to make.");
    await resolved.sleep(wait);
    const status = await readJson(await request(statusUrl, { headers: auth }, resolved));
    const word = typeof status.status === "string" ? status.status.trim().toUpperCase() : "";
    if (DONE.has(word)) break;
    if (FAILED.has(word)) {
      const said = proxyMessage(JSON.stringify(status));
      throw new ClawaiMediaError("failed", said ?? "ClawBox AI could not make that track.");
    }
  }
  return readJson(await request(responseUrl, { headers: auth }, resolved));
}

/** The audio formats a track may arrive in, told apart by their own bytes. */
const AUDIO_FORMATS: { extension: string; mime: string; matches: (b: Buffer) => boolean }[] = [
  { extension: ".mp3", mime: "audio/mpeg", matches: (b) => b.length > 3 && (b.toString("latin1", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  { extension: ".wav", mime: "audio/wav", matches: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WAVE" },
  { extension: ".ogg", mime: "audio/ogg", matches: (b) => b.length > 4 && b.toString("latin1", 0, 4) === "OggS" },
  { extension: ".flac", mime: "audio/flac", matches: (b) => b.length > 4 && b.toString("latin1", 0, 4) === "fLaC" },
  { extension: ".m4a", mime: "audio/mp4", matches: (b) => b.length > 12 && b.toString("latin1", 4, 8) === "ftyp" },
];

export interface ClawaiMediaFile {
  bytes: Buffer;
  mime: string;
  /** Earned from the bytes, never taken from a header or a file name. */
  extension: string;
}

/** The `{ url }` the result names its audio file by, in the shapes fal answers with. */
function audioUrlOf(result: Record<string, unknown>): string | null {
  for (const key of ["audio", "audio_file", "file"]) {
    const entry = result[key];
    if (typeof entry === "object" && entry !== null && typeof (entry as { url?: unknown }).url === "string") {
      return (entry as { url: string }).url;
    }
  }
  return typeof result.audio_url === "string" ? result.audio_url : null;
}

/**
 * Fetch the audio file a finished job names, and decide what it is.
 *
 * A `data:` URL is decoded in place; an `https:` URL is fetched WITHOUT the
 * portal token (a storage link carries its own signature, and the credential is
 * not the file host's business); anything else — `http:`, `file:`, a relative
 * path — is refused. The format is earned from the bytes, so a file named
 * `.mp3` that is not one never reaches the chat's player as one.
 */
export async function fetchClawaiMediaFile(
  result: Record<string, unknown>,
  deps: ClawaiMediaDeps = {},
): Promise<ClawaiMediaFile> {
  const resolved = resolveDeps(deps);
  const url = audioUrlOf(result);
  if (!url) throw new ClawaiMediaError("failed", "ClawBox AI finished the job but named no audio file.");

  let bytes: Buffer;
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    if (comma < 0 || !url.slice(0, comma).includes(";base64")) {
      throw new ClawaiMediaError("failed", "ClawBox AI answered with an audio file this box could not read.");
    }
    bytes = Buffer.from(url.slice(comma + 1), "base64");
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ClawaiMediaError("failed", "ClawBox AI answered with an audio link this box could not read.");
    }
    if (parsed.protocol !== "https:") {
      throw new ClawaiMediaError("failed", "ClawBox AI answered with an audio link that is not https; it was not fetched.");
    }
    // No redirects: a hop could leave https or land on this box's own network,
    // and a signed storage link answers where it points.
    const res = await request(parsed.toString(), { redirect: "error" }, resolved);
    if (!res.ok) throw new ClawaiMediaError("failed", `The finished track could not be downloaded (${res.status}).`);
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > CLAWAI_MEDIA_MAX_BYTES) {
      throw new ClawaiMediaError("failed", "The finished track is larger than this box keeps.");
    }
    bytes = Buffer.from(await res.arrayBuffer());
  }
  if (bytes.length > CLAWAI_MEDIA_MAX_BYTES) {
    throw new ClawaiMediaError("failed", "The finished track is larger than this box keeps.");
  }
  const format = AUDIO_FORMATS.find((candidate) => candidate.matches(bytes));
  if (!format) throw new ClawaiMediaError("failed", "ClawBox AI answered with a file that is not audio this box can play.");
  return { bytes, mime: format.mime, extension: format.extension };
}

/** What a music request may carry. The proxy drops what its model cannot honour. */
export interface ClawaiMusicRequest {
  prompt: string;
  lyrics?: string;
  instrumental?: boolean;
}

/** Make one track: the job on the shared route, then its file. */
export async function generateClawaiMusic(
  options: ClawaiMusicRequest & { proxyUrl: string; token: string },
  deps: ClawaiMediaDeps = {},
): Promise<ClawaiMediaFile> {
  const budgetMs = deps.budgetMs ?? CLAWAI_MEDIA_JOB_BUDGET_MS;
  const startedAt = (deps.now ?? Date.now)();
  const input: Record<string, unknown> = { prompt: options.prompt };
  if (options.lyrics) input.lyrics = options.lyrics;
  if (typeof options.instrumental === "boolean") input.instrumental = options.instrumental;
  const result = await runClawaiMediaJob(
    { proxyUrl: options.proxyUrl, token: options.token, model: CLAWBOX_AI_MUSIC_MODEL_ID, input },
    deps,
  );
  // The download shares the job's budget rather than starting a second one.
  const spent = (deps.now ?? Date.now)() - startedAt;
  return fetchClawaiMediaFile(result, { ...deps, budgetMs: Math.max(1, budgetMs - spent) });
}
