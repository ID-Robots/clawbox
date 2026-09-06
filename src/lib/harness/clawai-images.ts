import fsp from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import { CLAWBOX_AI_IMAGE_MODEL_ID } from "@/lib/clawbox-ai-models";
import { mediaUrl } from "@/lib/chat-media";
import {
  CLAWBOX_AI_PROXY_URL,
  clawaiCredentialRefused,
  clawaiCredentialGeneration,
  noteClawaiCredentialRefused,
  proxyRefusedClawaiCredential,
  resetClawaiCredentialRefusals,
  resolveClawaiToken,
} from "./credentials";
import { chatGeneratedImageDir, GENERATED_IMAGE_RETENTION, pruneMediaDir } from "./media-root";
import type { FetchLike } from "./transport";

/**
 * Making a picture with the ClawBox AI proxy. SERVER ONLY.
 *
 * WHY THE BOX CALLS THIS AND NOT THE AGENT. On OpenClaw a picture is drawn by
 * the AGENT reaching for its own image tool — a bundled plugin wired up through
 * `agents.defaults.imageGenerationModel`. On Hermes the equivalent slot is
 * EMPTY, and the distinction matters: upstream Hermes DOES have an
 * image-generation provider mechanism — `agent/image_gen_registry.py` dispatches
 * every `image_generate` call to whatever `image_gen.provider` names, and
 * `hermes_cli/plugins.py` discovers user backends from
 * `~/.hermes/plugins/image_gen/<name>/` — it just ships with nothing in it. So a
 * request for a picture reached no provider at all: the agent looked for a tool
 * that was not registered, and the turn ran until it timed out.
 *
 * The proxy was never the blocker either — it serves image generation to the
 * same device token voice input already spends. What was missing was a CALLER,
 * and this module is one: the box asks directly, so the composer works on a box
 * whose slot is empty, which is every stock Hermes box.
 *
 * THE OTHER HALF IS A SEPARATE FIX. Filling that plugin slot makes the AGENT
 * able to draw, in every channel it answers on rather than only in this chat.
 * The two compose rather than compete — `imageGenerationTrigger` is the one
 * expression deciding which of them a given box should offer.
 *
 * The credential is resolved through `resolveClawaiToken`, which knows both
 * editions' stores, so nothing here is Hermes-specific. What IS edition-
 * specific is who pulls the trigger, and that is a capability
 * (`imageGenerationTrigger`), not a branch in this file.
 *
 * THE CONTRACT, observed against production from a linked box on 2026-08-24
 * rather than taken from the OpenAI API the proxy resembles:
 *
 *   POST {CLAWBOX_AI_PROXY_URL}/images/generations
 *     Authorization: Bearer <device token>
 *     { "model": "gpt-image-1-mini", "prompt": "…", "n": 1, "size": "1024x1024" }
 *   → 200 { "created": 1787604969, "background": "opaque", "output_format": "png",
 *           "quality": "medium", "size": "1024x1024",
 *           "data": [ { "b64_json": "<base64 PNG>" } ],
 *           "usage": { "input_tokens": 17, "output_tokens": 1056, … } }
 *
 * BASE64, NEVER A URL. The `data[]` entry carries `b64_json` and no `url`
 * field, so there is nothing for the browser to load even if it were allowed
 * to: the bytes have to be written into this box's own media tree and served
 * back through `/setup-api/chat/media`. That is also the only shape that
 * survives a refresh, which is what the durable transcript needs.
 *
 * Failures come back structured, and are worth reading rather than guessing at:
 *
 *   400 { error: { code: "model_not_supported", type: "invalid_request_error", message } }
 *   401 { error: { code: "missing_token",       type: "auth_error", message } }
 *   403 { error: { code: "invalid_token",       type: "auth_error", message } }
 *
 * None of those messages is relayed verbatim — see `messageForStatus`.
 */

/** The images endpoint, derived from the one proxy constant both editions use. */
export const CLAWBOX_AI_IMAGES_ENDPOINT = `${CLAWBOX_AI_PROXY_URL}/images/generations`;

/**
 * One picture per request.
 *
 * The proxy advertises `maxImagesPerRequest: 4`, and every one of them is
 * billed against a daily allowance that is 1/day on the Free plan. Asking for
 * four would spend a Free user's entire day on a single prompt, so the device
 * asks for what it can show: one bubble, one picture.
 */
const IMAGES_PER_REQUEST = 1;

/**
 * The one size asked for.
 *
 * The proxy echoes `size: "1024x1024"` as its own default and the chat renders
 * into a square thumbnail, so naming it states what we expect back rather than
 * expressing a preference — a proxy that changed its default would otherwise
 * silently change the shape of every picture in the transcript.
 */
const IMAGE_SIZE = "1024x1024";

/**
 * How long one generation may take.
 *
 * Measured at 15.6 s for a 1024×1024 against production from the bench box, so
 * this is roughly eight times the observed cost — generous for a busy proxy and
 * still nothing like a hang. The number that matters is the one it replaces: a
 * request for a picture on Hermes used to sit until the agent's own 600-second
 * turn timeout, which is the failure this task exists to end.
 */
const UPSTREAM_TIMEOUT_MS = 120_000;

/** The discovery GET is a metadata read; a proxy that cannot answer it in 8 s is down. */
const PROBE_TIMEOUT_MS = 8_000;

/**
 * A picture is ~1.4 MB at 1024×1024, and base64 inflates it by a third. The cap
 * is the same 25 MB `/setup-api/chat/media` refuses to serve past, so nothing
 * can be written here that the reader would then reject.
 */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
/** The JSON envelope around it: base64 is 4 bytes per 3, plus the wrapper. */
const MAX_RESPONSE_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64 * 1024;

// Retention for pictures this box generated is longer than the 7 days staged
// uploads get, because these are the OUTPUT of a conversation rather than its
// input: an attachment still exists on the machine it was uploaded from, and a
// generated picture exists only here. The numbers live in
// `GENERATED_IMAGE_RETENTION` because the agent path copies its own pictures
// into the same directory and has to sweep it by the same rule.

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * A failure with an HTTP status and a sentence written for a customer.
 *
 * `status` is what the ROUTE should answer, decided here because this module is
 * the only place that knows which upstream condition produced it.
 */
export class ClawaiImageError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ClawaiImageError";
  }
}

export interface ClawaiImageResult {
  /** Absolute path on the box, under the edition's chat media root. */
  path: string;
  /** `/setup-api/chat/media?path=…` — what a bubble and a transcript record hold. */
  media: string;
}

/* ---------------------------------------------------------------------------
 * Is there a working image route on the other end of this credential?
 * ------------------------------------------------------------------------ */

/**
 * Successes are cached for ten minutes, failures for one.
 *
 * Asymmetric on purpose. A box that CAN draw does not stop being able to
 * mid-conversation, so re-asking often buys nothing; a box that cannot is
 * usually one whose uplink is coming back, and the customer is watching for the
 * button to appear. Both are far shorter than the process lifetime the
 * `--image` flag probe uses, because that one asks about an installed binary
 * and this one asks about the internet.
 */
const PROBE_TTL_OK_MS = 10 * 60_000;
const PROBE_TTL_FAIL_MS = 60_000;

let probeCache: { promise: Promise<boolean>; expiresAt: number } | null = null;

/**
 * Does the proxy serve image generation, for the model this box would ask for?
 *
 * A PROBED fact, for the reason every other fact in the capability table is
 * probed: the alternative is a button computed from a credential, and a
 * credential is not an ability. The proxy's own discovery endpoint answers
 * exactly this question —
 *
 *   GET {proxy}/images/generations
 *   → 200 { "status": "ok", "service": "ClawBox AI Image Generation",
 *           "defaultModel": "gpt-image-1-mini",
 *           "models": ["gpt-image-1-mini", "gpt-image-2"],
 *           "modelTiers": { … }, "maxImagesPerRequest": 4,
 *           "dailyImageLimits": { … }, "streaming": false, "onDevice": false }
 *
 * — and it costs no generation and no allowance to ask. Verified from the bench
 * box on 2026-08-24 at 0.32 s round trip.
 *
 * THE MODEL LIST IS CHECKED, not merely the status. The proxy matches the BARE
 * id against an allowlist and answers a miss with 400 "Model not supported for
 * image generation", so a route that is up but no longer serving
 * `CLAWBOX_AI_IMAGE_MODEL_ID` is a dead button just as surely as one that is
 * down. `defaultModel` is the fallback for a proxy too old to list them.
 *
 * WHAT THIS DELIBERATELY DOES NOT ANSWER. The discovery GET is UNAUTHENTICATED
 * — verified: it returns the same 200 with no token and with a wrong one — so
 * it cannot tell a live credential from a revoked one. That half of the answer
 * is `hasClawaiToken`, and the two are combined by the capability rather than
 * conflated here. A token that is present but MIGHT be stale therefore still
 * shows the button: hiding it on every box whose token might be stale would
 * hide it on every box.
 *
 * A token the proxy HAS NAMED as the problem is a different fact, and this does
 * answer it. Once a generate came back 401/403 with the proxy's own
 * `invalid_token` / `missing_token`, the button is an offer to draw that ends
 * in an error bubble every time, so it goes away — until the device is
 * re-linked, or fifteen minutes pass, whichever comes first. The timer is
 * there so a box the portal healed without a re-link gets its button back on
 * its own; the consequence, stated plainly, is that a still-dead credential
 * shows the button again every fifteen minutes and one press re-hides it.
 * Might-be-stale stays a button; proven-dead does not.
 *
 * Fails CLOSED. Anything other than a clean, parseable, model-listing 200 is
 * false, because a wrong `true` is an offer to draw that ends in an error
 * bubble — the same lie the microphone used to tell.
 */
export async function clawaiImageRouteReachable(fetchImpl: FetchLike = fetch): Promise<boolean> {
  // Ahead of the probe cache, not behind it: a 403 that lands a second after a
  // successful probe would otherwise keep the button for the ten minutes that
  // answer is good for, which is the whole window a customer spends pressing
  // it. It costs nothing — no request, and no credential read.
  if (clawaiCredentialRefused() !== null) return false;
  const now = Date.now();
  if (probeCache && now < probeCache.expiresAt) return probeCache.promise;
  // Seeded with the SHORT ttl so concurrent callers during the probe share one
  // request; the real expiry is stamped on below, once the answer is known.
  const entry: { promise: Promise<boolean>; expiresAt: number } = {
    promise: Promise.resolve(false),
    expiresAt: now + PROBE_TTL_FAIL_MS,
  };
  entry.promise = (async () => {
    const reachable = await askProxyForImageModels(fetchImpl);
    entry.expiresAt = Date.now() + (reachable ? PROBE_TTL_OK_MS : PROBE_TTL_FAIL_MS);
    return reachable;
  })();
  probeCache = entry;
  return entry.promise;
}

/**
 * Test seam: forget every remembered answer so the next call asks again —
 * including the shared credential refusal, which is what makes the status
 * table below able to walk 401 and 403 without poisoning the cases after them.
 */
export function resetClawaiImageProbe(): void {
  probeCache = null;
  resetClawaiCredentialRefusals();
}

async function askProxyForImageModels(fetchImpl: FetchLike): Promise<boolean> {
  let res: Response;
  try {
    res = await fetchImpl(CLAWBOX_AI_IMAGES_ENDPOINT, {
      method: "GET",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return false;
  }
  if (!res.ok) return false;
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return false;
  }
  if (!payload || typeof payload !== "object") return false;
  const body = payload as { models?: unknown; defaultModel?: unknown };
  if (Array.isArray(body.models)) {
    return body.models.some((id) => id === CLAWBOX_AI_IMAGE_MODEL_ID);
  }
  return body.defaultModel === CLAWBOX_AI_IMAGE_MODEL_ID;
}

/* ---------------------------------------------------------------------------
 * Making one
 * ------------------------------------------------------------------------ */

/**
 * Ask the proxy for a picture and write it into this box's chat media tree.
 *
 * Rejects with a `ClawaiImageError` carrying a status and a customer-readable
 * sentence, never with the upstream's own words — see `messageForStatus`.
 */
export async function generateClawaiImage(
  prompt: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<ClawaiImageResult> {
  const { bytes, extension } = await generateClawaiImageBytes(prompt, options);
  return writeGeneratedImage(bytes, extension);
}

/**
 * The picture as BYTES, without the chat media tree.
 *
 * The network half of `generateClawaiImage`, split out for the callers whose
 * picture is not a chat picture: the coding-agent media route writes into the
 * run's own folder, and putting the file into the media tree first only to move
 * it out again would expose it — briefly — to the transcript reader and to that
 * tree's 30-day sweep. The failure contract is the same `ClawaiImageError`.
 */
export async function generateClawaiImageBytes(
  prompt: string,
  options: { signal?: AbortSignal; fetchImpl?: FetchLike } = {},
): Promise<{ bytes: Buffer; extension: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const token = await resolveClawaiToken();
  if (!token) {
    // Actionable, and the same sentence shape voice input uses for the same
    // state: this is the one failure here the customer can actually fix.
    throw new ClawaiImageError(
      503,
      "This ClawBox is not linked to ClawBox AI yet, so it cannot generate pictures.",
    );
  }

  const refused = clawaiCredentialRefused();
  if (refused !== null) {
    // Refused WITHOUT asking again. The customer is still told, in the same
    // words and with the same status as the request that established this, so
    // nothing is hidden — what stops is the traffic. Beta sent one POST per
    // trigger, per process, for as long as the box stayed up, every one of them
    // a 403 that was knowable in advance. (The fleet-wide 15k/day on TASK-727
    // is the sum of every image caller on the box; how much of it came through
    // here rather than through the agent's own image tool was not separated.)
    const [status, message] = messageForStatus(refused);
    throw new ClawaiImageError(status, message);
  }

  // Snapshotted BEFORE the request. A re-link that lands while this is in
  // flight makes the answer a verdict on a credential the box no longer holds.
  const generation = clawaiCredentialGeneration();

  let res: Response;
  try {
    // CodeQL `js/file-access-to-http` ("file data in outbound network request")
    // flags this, and it is a false positive here — the same one it raises on
    // every credentialed call in this codebase, including the transcription
    // route next door, which is dismissed on beta for this reason.
    //
    // What the rule models is exfiltration: file CONTENT leaving the box, or
    // file content choosing WHERE a request goes. Neither happens. The only
    // file-derived value is the device's own ClawBox AI token, and it travels
    // in the `Authorization` header of the one service it was minted for — that
    // is the authorised use of a credential, not a disclosure of it. The
    // destination is a module constant; nothing read from disk can influence
    // it, so there is no SSRF to be had either. The prompt comes from the
    // request, not from a file.
    //
    // Deliberately not restructured to quiet the scanner: a credential has to
    // be read from somewhere and put in a header, and rearranging that to break
    // the taint path would hide the pattern rather than change it.
    res = await fetchImpl(CLAWBOX_AI_IMAGES_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CLAWBOX_AI_IMAGE_MODEL_ID,
        prompt,
        n: IMAGES_PER_REQUEST,
        size: IMAGE_SIZE,
      }),
      // A customer who closed the tab must not leave a PAID generation running,
      // and a wedged proxy must not pin the composer in "drawing" indefinitely.
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)])
        : AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (err) {
    if (options.signal?.aborted) throw new ClawaiImageError(499, "Stopped.", err);
    const timedOut =
      err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new ClawaiImageError(
      504,
      timedOut
        ? "Generating the picture took too long. Please try again."
        : "Could not reach ClawBox AI to generate the picture.",
      err,
    );
  }

  if (!res.ok) {
    // A credential the proxy itself names as the problem is the one failure
    // here that CANNOT come right on its own, so it is remembered rather than
    // re-tried. It has to be the PROXY saying so: a bare 401/403 on the wire
    // can come from an edge rule, a rate-limit page, an interception proxy or
    // a plan gate, and remembering one of those would hide the button and tell
    // a customer with a perfectly good credential to re-pair the device.
    if (await proxyRefusedClawaiCredential(res)) await noteClawaiCredentialRefused(res.status, generation);
    // The STATUS decides what is SAID, never the body. An upstream error body is allowed to
    // quote the request that caused it, and this request carried a bearer
    // token — the same reason the transcription route relays a status and
    // nothing else.
    const [status, message] = messageForStatus(res.status);
    throw new ClawaiImageError(status, message);
  }

  const raw = await readBounded(res);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (err) {
    throw new ClawaiImageError(502, "ClawBox AI returned an unreadable response.", err);
  }
  const encoded = firstImagePayload(payload);
  if (!encoded) {
    throw new ClawaiImageError(502, "ClawBox AI returned no picture.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new ClawaiImageError(502, "ClawBox AI returned a picture this box cannot store.");
  }
  const extension = imageExtension(bytes);
  if (!extension) {
    // The bytes decide the extension and the extension decides the Content-Type
    // `/setup-api/chat/media` serves the file under. Something unrecognised
    // would be written as a file that reader then refuses, so it is refused
    // here instead, where the reason can still be reported.
    throw new ClawaiImageError(
      502,
      "ClawBox AI returned a picture in a format this box cannot show.",
    );
  }

  return { bytes, extension };
}


/**
 * What a failing status is allowed to say.
 *
 * Mapped from the codes the proxy actually answers with rather than invented:
 * 401/403 are the credential (`missing_token` / `invalid_token`), other 4xx is
 * the request, 5xx is the far side. The 429 arm names the daily allowance
 * because that is the only 429 this endpoint has — every plan carries a
 * per-UTC-day image cap and the proxy's own counter is what enforces it.
 */
function messageForStatus(status: number): [number, string] {
  if (status === 401 || status === 403) {
    return [503, "ClawBox AI rejected this device's credentials. Re-link the device and try again."];
  }
  if (status === 429) {
    return [429, "You have used up today's ClawBox AI pictures. The allowance resets at midnight UTC."];
  }
  if (status >= 400 && status < 500) {
    return [400, `ClawBox AI could not draw that (upstream ${status}).`];
  }
  return [502, `Generating the picture failed (upstream ${status}).`];
}

/**
 * The response body, cut off past the cap.
 *
 * Counted as it arrives rather than trusted from Content-Length: a chunked
 * response declares no length at all, so a header check bounds only the
 * upstreams that were never the problem. `res.json()` would buffer whatever
 * arrived before anything could object to its size.
 */
async function readBounded(res: Response): Promise<Buffer> {
  const body = res.body;
  if (!body) throw new ClawaiImageError(502, "ClawBox AI returned an empty response.");
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        // Cancelling stops the upstream being drained to its end.
        await reader.cancel().catch(() => {});
        throw new ClawaiImageError(502, "ClawBox AI returned a picture this box cannot store.");
      }
      chunks.push(Buffer.from(value));
    }
    if (done) break;
  }
  return Buffer.concat(chunks);
}

/** The base64 of the first picture in the response, or "". */
function firstImagePayload(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return "";
  const first = data[0];
  if (!first || typeof first !== "object") return "";
  const encoded = (first as { b64_json?: unknown }).b64_json;
  return typeof encoded === "string" && encoded ? encoded : "";
}

/**
 * The extension for these bytes, from their MAGIC rather than from the
 * response's `output_format`.
 *
 * The bytes are the thing being written, and the header a proxy puts on them is
 * a claim ABOUT the bytes — one that would decide what Content-Type the media
 * reader later serves the file under. Sniffing keeps those two answers from
 * being able to disagree. Only the three formats this endpoint has ever been
 * seen to return are recognised; anything else is refused rather than saved
 * under a guess.
 */
function imageExtension(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * Write the picture where `/setup-api/chat/media` can find it.
 *
 * The name is a UUID and nothing else. A prompt-derived filename would put the
 * customer's own words into a path that the media route then carries in a query
 * string and the browser keeps in its history — and the prompt is the least
 * redacted thing in the whole exchange.
 */
async function writeGeneratedImage(bytes: Buffer, extension: string): Promise<ClawaiImageResult> {
  const dir = await chatGeneratedImageDir();
  await fsp.mkdir(dir, { recursive: true, mode: DIR_MODE });
  // `mkdir`'s mode is ignored for a directory that already exists, and an older
  // build (or a umask) may have left it wider. Best effort, like the transcript
  // store's: a failed chmod must not cost the customer their picture.
  await fsp.chmod(dir, DIR_MODE).catch(() => {});
  // Swept BEFORE the write, because the point is to make room — a sweep that
  // ran afterwards would be measuring a directory it had just added to. Best
  // effort: a failed sweep must never turn a good generation into an error.
  await pruneMediaDir(dir, GENERATED_IMAGE_RETENTION).catch(() => {});
  const file = path.join(dir, `${randomUUID()}.${extension}`);
  await fsp.writeFile(file, bytes, { mode: FILE_MODE });
  await fsp.chmod(file, FILE_MODE).catch(() => {});
  return { path: file, media: mediaUrl(file) };
}
