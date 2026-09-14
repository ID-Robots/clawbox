/**
 * The ClawBox AI cloud embedder: where it is, what it answers with, and whether
 * this box can reach it right now.
 *
 * SERVER ONLY.
 *
 * The memory index is the one capability of the three where "default to the
 * cloud" cannot simply be switched on: changing the provider, the model or the
 * endpoint changes what the vectors on disk BELONG to, and OpenClaw fails the
 * index closed until it has been rebuilt. So the cloud embedder is reached for
 * only when this box can prove it answers — `probeCloudEmbeddings` — and the
 * caller that moves the index is the one that asks for the rebuild.
 *
 * The route is `POST <proxy>/embeddings`, OpenAI-compatible (`input`, `model`,
 * `data[].embedding`, `usage`) with the box's own `claw_` token as the bearer.
 * WHERE it is comes from the environment and never from a file — see
 * `CLAWAI_CLOUD_EMBEDDINGS_KEY` for why that distinction is load-bearing, and
 * `usableEndpoint` for the trust boundary the address sits on: who may set it,
 * what it may be, and which half of that is enforced here rather than owed by
 * the operator.
 * It is shipping separately on the website side; until it does, every probe here
 * answers false and the resolver leaves the index on the model on this box. That
 * is the whole reason the probe exists rather than a flag someone flips: a box
 * that pointed its memory at a 404 would report a healthy index that finds
 * nothing.
 */

import { get } from "@/lib/config-store";
import { CLAWBOX_AI_PROXY_URL, resolveClawaiToken } from "@/lib/harness/credentials";

/**
 * What a model id may look like. A bound on the request body rather than a
 * guess at a vendor's format: this string is env-supplied and is serialised
 * into every probe, so an id outside this charset or past this length is a
 * misconfigured image and the shipped default is the safer answer.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** What a device build embeds with when nothing overrides it. */
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-large";

/**
 * The cloud embedding model.
 *
 * `text-embedding-3-large` at 3,072 dimensions — the same model the owner's own
 * OpenClaw memory search uses, so an index built here and one built there are
 * comparable. Env-overridable so a staging proxy can serve something else
 * without a code change; the DIMENSION travels with it, because a model with a
 * different one is a different index and not a different setting. An override
 * that is not a plausible id is ignored rather than sent — see {@link MODEL_ID}.
 */
export const CLOUD_EMBEDDING_MODEL = (() => {
  const override = process.env.CLAWBOX_AI_EMBEDDING_MODEL?.trim();
  return override && MODEL_ID.test(override) ? override : DEFAULT_EMBEDDING_MODEL;
})();

/** What the model above answers with, for the index-rebuild rule. */
export const CLOUD_EMBEDDING_DIMENSIONS = 3072;

/** The OpenClaw provider id the cloud embedder is reached through. */
export const CLOUD_EMBEDDING_PROVIDER = "openai-compatible";

/** What the panel calls it. */
export const CLOUD_EMBEDDING_ENGINE = "ClawBox AI";

/**
 * The field switch: `"off"` stops this box using the cloud embedder at all.
 *
 * A key rather than only a build-time constant because the proxy route is
 * shipping after this code: a box already in a customer's hands can be taken
 * back off it without an update, whatever its plan says.
 *
 * IT IS A SWITCH AND NOT AN ADDRESS, deliberately. The first draft let this key
 * hold the endpoint URL, which CodeQL flagged for what it is
 * (`js/file-data-outbound-request`): the owner's whole memory index becomes the
 * body of a request to whatever `data/config.json` names, and that file is
 * deny-listed for a coding run's own file tools exactly because a
 * prompt-injected run must not be able to redirect the box. A word cannot name
 * a host. Where the endpoint IS is decided by the environment the image was
 * built with, below, which is root's and not the clawbox account's.
 */
export const CLAWAI_CLOUD_EMBEDDINGS_KEY = "clawai_cloud_embeddings";

/**
 * The longest endpoint this box will send to, and the charset a model id may
 * use. Both are bounds on what reaches the network, not guesses at a format:
 * a URL past this length or a model id outside this charset is a misconfigured
 * image, and sending either is strictly worse than falling back to the built-in
 * route.
 */
const MAX_ENDPOINT_CHARS = 2048;

/**
 * THE TRUST BOUNDARY for the cloud embedder's address.
 *
 * WHO MAY SET IT. `CLAWBOX_AI_EMBEDDINGS_URL` is read from the environment the
 * image was built with, which is root's and not the `clawbox` account's —
 * deliberately, and it is the whole reason the device store gets a SWITCH and
 * not an address (see `CLAWAI_CLOUD_EMBEDDINGS_KEY`). Everything the owner has
 * indexed becomes the body of requests to whatever this names, so only an
 * operator who is already trusted with the image may configure it. A
 * prompt-injected coding run, a hand-edited `data/config.json` and a restored
 * backup all reach the store and none of them reaches here.
 *
 * WHAT IT MAY BE. Plain `http:` is accepted, for the one case it exists for: a
 * staging proxy on a trusted LAN. That is a STAGING CONTRACT and not a
 * loopback restriction — pinning it to loopback would delete the staging setup
 * it was added for. Outside a trusted LAN the endpoint must be `https:`,
 * because the request carries the box's `claw_` bearer and the text being
 * embedded in cleartext otherwise (CWE-319). Nothing here can tell a trusted
 * LAN from the open internet, so that half is the operator's to honour.
 *
 * WHAT IS ENFORCED. The scheme must be `http:` or `https:` and the whole URL
 * must parse and stay under {@link MAX_ENDPOINT_CHARS}. Anything else — a
 * `file:`, a `data:`, an unparseable string, a length nothing legitimate needs
 * — is refused and this box falls back to the built-in proxy route, which is
 * its own account's endpoint and never a third party's.
 */
function usableEndpoint(raw: string | undefined): string | null {
  const candidate = raw?.trim();
  if (!candidate || candidate.length > MAX_ENDPOINT_CHARS) return null;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
}

/**
 * The endpoint.
 *
 * From the environment or from the proxy constant, never from a file — see the
 * key above. `CLAWBOX_AI_EMBEDDINGS_URL` is for a staging image pointed at a
 * proxy of its own; a device build sets neither and gets the line below. An
 * override that does not pass {@link usableEndpoint} is treated as absent
 * rather than sent to: the built-in route is this box's own account, so falling
 * back is the conservative direction.
 */
export function cloudEmbeddingsUrl(): string {
  const override = usableEndpoint(process.env.CLAWBOX_AI_EMBEDDINGS_URL);
  return override || `${CLAWBOX_AI_PROXY_URL.replace(/\/+$/, "")}/embeddings`;
}

/** Has the owner (or a support engineer) switched the cloud embedder off here? */
export async function cloudEmbeddingsSwitchedOff(): Promise<boolean> {
  const stored = await get(CLAWAI_CLOUD_EMBEDDINGS_KEY);
  return typeof stored === "string" && stored.trim().toLowerCase() === "off";
}

/**
 * What OpenClaw is pointed at: the endpoint with its `/embeddings` suffix taken
 * off, because the core's OpenAI-compatible client appends that itself. Written
 * as its own function so the probe and the config write cannot disagree about
 * which half of the URL is theirs.
 */
export function embeddingsBaseUrlOf(endpoint: string): string {
  return endpoint.replace(/\/+$/, "").replace(/\/embeddings$/, "");
}

/** How long a probe answer is believed. */
const PROBE_OK_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * A refusal is re-asked sooner than an acceptance is re-checked: the route is
 * expected to APPEAR under a box that has been answering 404, and an owner who
 * has just upgraded should not wait six hours for the box to notice.
 */
const PROBE_FAIL_TTL_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 8000;

/**
 * THE MOST OF AN ANSWER THIS BOX WILL HOLD IN MEMORY: 256 KiB.
 *
 * {@link PROBE_TIMEOUT_MS} bounds how LONG the probe may take and nothing else.
 * A responder that answers fast and never stops — a staging proxy on a LAN, an
 * intermediary, anything on the far side of a plain `http:` hop that the
 * staging contract on {@link usableEndpoint} deliberately allows — can send
 * gigabytes inside those eight seconds, and `res.json()` buffers every byte of
 * it before anything gets to look at the shape. On a box this size that is the
 * whole device, not one request.
 *
 * 256 KiB is chosen against what a legitimate answer actually weighs. The one
 * this probe asks for is a single {@link CLOUD_EMBEDDING_DIMENSIONS}-dimension
 * vector: 3,072 JSON numbers run to roughly 60 KiB even printed at full
 * `double` precision, so the cap accepts the real answer about four times over
 * and still leaves room for the `model` and `usage` fields around it. It is a
 * bound on a PROBE, not on embedding traffic — nothing else in this module
 * reads a body.
 */
const MAX_PROBE_BYTES = 256 * 1024;

/**
 * The cap, exported for the regression test that pins the boundary exactly.
 * Nothing in the app reads it; a test that hard-coded the number would keep
 * passing if the constant above ever moved.
 */
export const CLOUD_PROBE_MAX_BYTES = MAX_PROBE_BYTES;

/**
 * Module-level rather than in `process-store.ts`: the two copies Next compiles
 * of this file would each keep their own answer, and the cost of that is one
 * extra HTTP request every few hours. Nothing here holds a handle on live work
 * or writes a file, which is the bar that module sets.
 */
let probeCache: { at: number; ok: boolean; endpoint: string } | null = null;

/** Test seam, and what a credential change calls: forget what the route said. */
export function forgetCloudEmbeddingsProbe(): void {
  probeCache = null;
}

/**
 * Does the cloud embedder answer for THIS box?
 *
 * Sends the smallest request the API has — one short string — and requires a
 * numeric vector back. A 2xx with a shape nothing can read is not a working
 * embedder, and neither is a 404 from a proxy that has not shipped the route
 * yet; both answer false, and false always means "leave the index where it is".
 * Never throws.
 */
export async function probeCloudEmbeddings(): Promise<boolean> {
  if (await cloudEmbeddingsSwitchedOff()) return false;
  const endpoint = cloudEmbeddingsUrl();
  const now = Date.now();
  if (probeCache && probeCache.endpoint === endpoint) {
    const ttl = probeCache.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS;
    if (now - probeCache.at < ttl) return probeCache.ok;
  }
  const ok = await askCloudEmbedder(endpoint);
  probeCache = { at: Date.now(), ok, endpoint };
  return ok;
}

/**
 * Stop reading, and DO NOT WAIT TO FIND OUT WHETHER STOPPING WORKED.
 *
 * `cancel()` resolves when the far side has been torn down, and the far side
 * here is exactly the thing already suspected of misbehaving: a responder that
 * never stops sending is one that can leave this promise pending, and awaiting
 * it would hand back the hang that the byte cap just refused. So the refusal
 * returns immediately and the teardown is left to settle on its own, with its
 * rejection swallowed — an already-closed, already-errored or already-locked
 * stream is not news, it is the outcome being asked for.
 */
function stopReading(target: { cancel: (reason?: unknown) => unknown } | null | undefined): void {
  if (!target) return;
  try {
    const settled = target.cancel();
    if (settled && typeof (settled as Promise<unknown>).catch === "function") {
      void (settled as Promise<unknown>).catch(() => {});
    }
  } catch {
    // Already closed, errored, or locked by a reader that is itself gone.
  }
}

/**
 * Read at most {@link MAX_PROBE_BYTES} of a response, or refuse it.
 *
 * Both halves are load-bearing, because each one alone is bypassable:
 *
 * `Content-Length` IS CHECKED FIRST, so an answer that admits up front to being
 * too big is refused before a single byte of it is pulled. A responder that
 * tells the truth costs this box nothing at all.
 *
 * THE BYTES ARE THEN COUNTED AS THEY ARRIVE, because the header is the
 * responder's claim and not a fact. A chunked answer carries no length, a
 * hostile one can advertise `12` and send forever, and a compressed one is
 * checked by `fetch` against the length of the COMPRESSED body while what lands
 * in memory here is the inflated stream. The running total is the only figure
 * this box can actually vouch for, so it is the one that decides, and the chunk
 * that crosses the line is dropped rather than kept — peak memory is the cap
 * plus one chunk, not the cap plus whatever arrived last.
 *
 * On any refusal the stream is cancelled (see {@link stopReading}) and `null`
 * comes back, so the caller never reaches `JSON.parse` on an oversized payload:
 * the parse happens only after a read that finished INSIDE the bound. A body
 * that is absent, errors mid-stream, or decodes to nothing readable fails the
 * same closed way, which is the contract the probe already had.
 */
async function readBoundedText(res: Response, limit: number): Promise<string | null> {
  const advertised = Number(res.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > limit) {
    stopReading(res.body);
    return null;
  }
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        stopReading(reader);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    stopReading(reader);
    return null;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * The one request this module makes, and everything about it is bounded.
 *
 * The destination is re-checked against {@link usableEndpoint} here as well as
 * where it was resolved: this is the function that actually opens the socket,
 * and a fence with one gate is a fence. The BODY is a seven-character literal
 * and a model id that has passed {@link MODEL_ID} — nothing the owner has
 * written, and nothing read out of a file, travels in it. What is file-derived
 * is the `claw_` bearer, which is the box's own credential for its own account
 * and is the point of the request; it goes in a header to a destination the
 * device store cannot name.
 *
 * The ANSWER is bounded too, and separately: the timeout says how long the far
 * side may take, {@link readBoundedText} says how much of it this box will hold
 * while it takes it. Nothing is parsed until that read has finished inside the
 * cap.
 */
async function askCloudEmbedder(endpoint: string): Promise<boolean> {
  const target = usableEndpoint(endpoint);
  if (!target) return false;
  const token = await resolveClawaiToken();
  if (!token) return false;
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ model: CLOUD_EMBEDDING_MODEL, input: "clawbox" }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      // Nothing here wants the body of a 404, and leaving it unread leaves the
      // connection held open until the far side or the GC gives up on it.
      stopReading(res.body);
      return false;
    }
    const text = await readBoundedText(res, MAX_PROBE_BYTES);
    if (text === null) return false;
    const payload = JSON.parse(text) as { data?: { embedding?: unknown }[] };
    const vector = Array.isArray(payload?.data) ? payload.data[0]?.embedding : null;
    return Array.isArray(vector) && vector.length > 0 && vector.every((n) => typeof n === "number");
  } catch {
    // A refused connection, a timeout, a body that is not JSON. All of them mean
    // the same thing to the caller and none of them is worth a stack in the log
    // every six hours on a box whose plan simply does not include this.
    return false;
  }
}
