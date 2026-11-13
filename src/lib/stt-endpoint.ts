/**
 * The owner's own OpenAI-compatible speech-to-text server as a transcription
 * engine (TASK-2501 PR-D: speech local-only).
 *
 * A third engine beside faster-whisper on the box and ClawBox AI's cloud: a
 * server the owner runs on this machine or on the LAN — a vLLM or SGLang ASR
 * model, faster-whisper-server, speaches, a Workstation's ASR node — asked the
 * OpenAI way, `POST {base}/audio/transcriptions` with a multipart `file` and a
 * `model`, answering `{ text }`.
 *
 * LOOPBACK OR PRIVATE LAN ONLY. The engine exists so a recording never leaves
 * the owner's network, so an address on the public internet is refused when it
 * is saved AND every time a recording is sent: a name is resolved per request
 * and every address it answers must be loopback, RFC 1918, CGNAT or IPv6
 * unique-local (`isPrivateIp`), and none may be one an engine can never be —
 * link-local or a cloud metadata service, the External engine's own rule
 * (`refusedEngineHost`). A name that does not resolve is no engine at all.
 * Redirects are not followed: a 3xx could carry the recording and the key to a
 * host nobody checked. And THE ADDRESS CHECKED IS THE ADDRESS DIALLED: the
 * request runs on Node's own http(s) client with a lookup that answers only
 * addresses that pass the rule ({@link lanFetch}), so a name whose DNS answer
 * changes between a check and the connect (rebinding) cannot carry a recording
 * off the network.
 *
 * The record lives in the device store under {@link STT_ENDPOINT_STORE_KEY}
 * (no secret in it); the optional key has its own 0600 file beside the
 * External engine's, and is never logged or answered.
 *
 * The chat microphone calls {@link transcribeAtEndpoint}. Channel voice notes
 * reach the same server through `scripts/stt-endpoint-client.py`, which reads
 * the same record and key and applies the same address rule (see
 * `buildAudioModels` in stt-preference.ts for why it is a CLI row).
 *
 * SERVER ONLY.
 */

import crypto from "crypto";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import { lookup as dnsLookup } from "dns/promises";
import path from "@/lib/runtime-path";
import { get, resolveConfigRoot, setMany } from "@/lib/config-store";
import { EXTERNAL_ENGINE_LIMITS, normalizeExternalBaseUrl, refusedEngineHost } from "@/lib/external-engine-shared";
import { isPrivateIp, DNS_TIMEOUT_MS } from "@/lib/private-address";

/** The config-store key of the record. */
export const STT_ENDPOINT_STORE_KEY = "stt_endpoint";

/** What the server is asked for when the owner names no model: OpenAI's own id, which most servers alias. */
export const STT_ENDPOINT_DEFAULT_MODEL = "whisper-1";

/** The client script channel voice notes run (repo `scripts/`). Matched by name, like stt-client.py. */
export const STT_ENDPOINT_CLIENT_SCRIPT = "stt-endpoint-client.py";

export const STT_ENDPOINT_LIMITS = {
  baseUrlMax: EXTERNAL_ENGINE_LIMITS.baseUrlMax,
  modelMax: EXTERNAL_ENGINE_LIMITS.modelIdMax,
  apiKeyMax: EXTERNAL_ENGINE_LIMITS.apiKeyMax,
} as const;

/** Long enough for a cold ASR model on a busy server, short enough that the composer is never stuck. */
export const STT_ENDPOINT_TIMEOUT_MS = 120_000;
export const STT_ENDPOINT_PROBE_TIMEOUT_MS = 8_000;
/** The most of an answer that is read: a transcript of half an hour of speech is tens of KB. */
const MAX_ANSWER_BYTES = 1024 * 1024;

export interface SttEndpointRecord {
  /** `http(s)://host[:port][/path]`, no trailing slash — the `/v1` root of the server. */
  baseUrl: string;
  /** The `model` field every request carries. */
  model: string;
}

export type SttEndpointErrorCode =
  | "invalid_base_url"
  | "invalid_model"
  | "invalid_api_key"
  | "address_refused"
  | "unreachable"
  | "unauthorized"
  | "bad_response"
  | "not_configured";

// ── The record ───────────────────────────────────────────────────────────────

function keyPath(): string {
  return path.join(resolveConfigRoot(), "data", ".stt-endpoint-key");
}

/**
 * The stored key FOR `baseUrl`, or null when none is on file for it. Never
 * logged, never answered. The key is stored BOUND to the server it was saved
 * for (`{"v":1,"for":<baseUrl>,"key":…}`), so whatever a reader saw of the
 * record, a key is only ever handed out for the address it belongs to — no
 * interleaving of saves (A → B → A) can pair one server's key with another's
 * address. A file in any other shape is no key.
 */
export function readSttEndpointKey(baseUrl: string): string | null {
  try {
    const stored = JSON.parse(fs.readFileSync(keyPath(), "utf-8")) as { v?: unknown; for?: unknown; key?: unknown } | null;
    if (!stored || stored.v !== 1 || stored.for !== baseUrl || typeof stored.key !== "string") return null;
    const key = stored.key.trim();
    return key ? key : null;
  } catch {
    return null;
  }
}

/** Written 0600 and atomically (temp + rename), so a crash never leaves half a key; bound to `baseUrl`. */
export function writeSttEndpointKey(key: string, baseUrl: string): void {
  const target = keyPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, for: baseUrl, key }), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, target);
}

export function deleteSttEndpointKey(): void {
  try {
    fs.unlinkSync(keyPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
  }
}

/** The record from a stored value, or null when it is absent or not one ClawBox wrote. PURE. */
export function sttEndpointFromValue(raw: unknown): SttEndpointRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { baseUrl, model } = raw as { baseUrl?: unknown; model?: unknown };
  const url = normalizeSttEndpointUrl(baseUrl);
  const name = parseModel(model);
  if (!url || !name) return null;
  return { baseUrl: url, model: name };
}

/** The saved endpoint, or null. An unreadable store reads as none: the engine is then simply not offered. */
export async function readSttEndpoint(): Promise<SttEndpointRecord | null> {
  try {
    return sttEndpointFromValue(await get(STT_ENDPOINT_STORE_KEY));
  } catch {
    return null;
  }
}

/**
 * The saved server and its key as ONE pair, for a request that is about to
 * send the key: the record, then the key, then the record again, accepted only
 * when both record reads agree. The save writes key-off, record, new key (see
 * the endpoint route), so a key read between two equal records is that
 * record's key or none — never the key a save meanwhile stored for another
 * server. `null`: no server is saved. `"changing"`: it kept changing over a
 * few tries, and nothing should be sent.
 */
export async function readSttEndpointSnapshot(): Promise<{ record: SttEndpointRecord; key: string | null } | null | "changing"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const first = await readSttEndpoint();
    if (!first) return null;
    const key = readSttEndpointKey(first.baseUrl);
    const again = await readSttEndpoint();
    if (again && again.baseUrl === first.baseUrl && again.model === first.model) return { record: first, key };
  }
  return "changing";
}

export async function writeSttEndpoint(record: SttEndpointRecord): Promise<void> {
  await setMany({ [STT_ENDPOINT_STORE_KEY]: { baseUrl: record.baseUrl, model: record.model } });
}

export async function deleteSttEndpoint(): Promise<void> {
  await setMany({ [STT_ENDPOINT_STORE_KEY]: undefined });
  deleteSttEndpointKey();
}

// ── Validation ───────────────────────────────────────────────────────────────

function parseModel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const model = raw.trim();
  if (!model || model.length > STT_ENDPOINT_LIMITS.modelMax || /[\u0000-\u001f\u007f]/.test(model)) return null;
  return model;
}

/**
 * Is this address one a speech engine on the owner's own network may have?
 * Loopback, RFC 1918, CGNAT, IPv6 unique-local — and never link-local, a
 * metadata service, the unspecified address or multicast. PURE.
 */
export function isLanAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").split("%")[0];
  if (!net.isIP(bare)) return false;
  if (!isPrivateIp(bare)) return false;
  if (refusedEngineHost(net.isIPv6(bare) ? `[${bare}]` : bare)) return false;
  // isPrivateIp counts multicast as "ours"; it is never a server.
  if (net.isIPv4(bare) && Number(bare.split(".")[0]) >= 224) return false;
  if (net.isIPv6(bare) && /^ff/i.test(bare)) return false;
  return true;
}

function isLoopbackName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost");
}

/**
 * The base URL as typed, normalised — http(s), no credentials, query or
 * fragment, no trailing slash, the External engine's rule — or null when it is
 * not one, or when its host is an address literal outside the owner's network.
 * A NAME passes here and is resolved when it is used ({@link endpointHostRefusal}).
 */
export function normalizeSttEndpointUrl(raw: unknown): string | null {
  const url = normalizeExternalBaseUrl(raw);
  if (!url) return null;
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && !isLanAddress(host)) return null;
  return url;
}

export type SttEndpointInput =
  | { ok: true; value: SttEndpointRecord; apiKey: string | null; clearApiKey: boolean }
  | { ok: false; code: SttEndpointErrorCode; error: string };

/** What the owner typed, validated. PURE. */
export function validateSttEndpointInput(body: Record<string, unknown> | null): SttEndpointInput {
  const rawUrl = body?.baseUrl;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    return { ok: false, code: "invalid_base_url", error: "Enter the server's address, for example http://192.168.1.20:8000/v1." }; // public-hygiene: allow an example LAN address shown to the user, not a real host
  }
  const baseUrl = normalizeSttEndpointUrl(rawUrl);
  if (!baseUrl) {
    let literal = false;
    try {
      literal = net.isIP(new URL(rawUrl.trim()).hostname.replace(/^\[|\]$/g, "")) !== 0;
    } catch {
      literal = false;
    }
    return literal
      ? { ok: false, code: "address_refused", error: "The speech server must be on this box or on your local network, not on the internet." }
      : { ok: false, code: "invalid_base_url", error: "That is not an http:// or https:// address (no user name, query or fragment)." };
  }
  const modelRaw = body?.model;
  const model = modelRaw === undefined || modelRaw === null || (typeof modelRaw === "string" && !modelRaw.trim())
    ? STT_ENDPOINT_DEFAULT_MODEL
    : parseModel(modelRaw);
  if (!model) return { ok: false, code: "invalid_model", error: "The model name must be one line of up to 200 characters." };
  const keyRaw = body?.apiKey;
  let apiKey: string | null = null;
  if (keyRaw !== undefined && keyRaw !== null) {
    if (typeof keyRaw !== "string") return { ok: false, code: "invalid_api_key", error: "The API key must be text." };
    const key = keyRaw.trim();
    if (key.length > STT_ENDPOINT_LIMITS.apiKeyMax || /[\u0000-\u001f\u007f\s]/.test(key)) {
      return { ok: false, code: "invalid_api_key", error: "The API key must be one line with no spaces." };
    }
    apiKey = key || null;
  }
  return { ok: true, value: { baseUrl, model }, apiKey, clearApiKey: body?.clearApiKey === true };
}

// ── The address rule, at use ─────────────────────────────────────────────────

export type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

const defaultLookup: LookupFn = async (hostname) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out")), DNS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Why a recording may not go to `baseUrl` right now, or null when it may.
 * FAILS CLOSED: a name that does not resolve, or resolves to one address
 * outside the owner's network, is refused.
 */
export async function endpointHostRefusal(baseUrl: string, lookupImpl: LookupFn = defaultLookup): Promise<string | null> {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch {
    return "not a valid address";
  }
  if (!host) return "not a valid address";
  if (isLoopbackName(host)) return null;
  if (refusedEngineHost(net.isIPv6(host) ? `[${host}]` : host)) return "an address a speech server can never be";
  if (net.isIP(host)) return isLanAddress(host) ? null : "not on this box or the local network";
  let addresses: { address: string }[];
  try {
    addresses = await lookupImpl(host);
  } catch {
    return "a name that does not resolve";
  }
  if (addresses.length === 0) return "a name that does not resolve";
  return addresses.every(({ address }) => isLanAddress(address)) ? null : "a name that resolves outside the local network";
}

/**
 * The addresses a connection to `hostname` may dial, resolved ONCE and
 * checked: every answer must be on the owner's network. All of them are kept,
 * in the resolver's order, so a connection that asks for every address (Node's
 * happy-eyeballs `autoSelectFamily`) can fall back from one that does not
 * answer — `::1` before `127.0.0.1` for a server that listens on IPv4 only —
 * the way the channel client already does (scripts/stt-endpoint-client.py).
 */
async function checkedAddresses(hostname: string, lookupImpl: LookupFn): Promise<{ address: string; family: 4 | 6 }[]> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (!isLanAddress(host)) throw new Error("address outside the local network");
    return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  }
  const answers = await lookupImpl(host);
  if (answers.length === 0 || !answers.every(({ address }) => isLanAddress(address))) {
    throw new Error("name resolves outside the local network");
  }
  return answers.map(({ address }) => ({ address, family: net.isIPv6(address) ? 6 as const : 4 as const }));
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * `fetch` for the owner's speech server, on Node's http(s) client: the
 * connection resolves its host through {@link checkedAddress}, so what was
 * checked is what is dialled. No redirect is followed (http.request never
 * does), no proxy is used, and at most {@link MAX_ANSWER_BYTES} of an answer
 * is read.
 */
export function lanFetch(lookupImpl: LookupFn = defaultLookup): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => { headers[key] = value; });
    let payload: Buffer | null = null;
    if (init.body !== undefined && init.body !== null) {
      const encoded = new Response(init.body as BodyInit);
      payload = Buffer.from(await encoded.arrayBuffer());
      const type = encoded.headers.get("content-type");
      if (type && !headers["content-type"]) headers["content-type"] = type;
      headers["content-length"] = String(payload.length);
    }
    const client = url.protocol === "https:" ? https : http;
    return await new Promise<Response>((resolve, reject) => {
      const req = client.request(url, {
        method: init.method ?? "GET",
        headers,
        signal: init.signal ?? undefined,
        agent: false,
        lookup: ((hostname: string, options: { all?: boolean }, callback: LookupCallback) => {
          checkedAddresses(hostname, lookupImpl).then(
            (all) => (options?.all ? callback(null, all) : callback(null, all[0].address, all[0].family)),
            (err: Error) => callback(Object.assign(err, { code: "ECLAWBOXREFUSED" }), "", 4),
          );
        }) as unknown as net.LookupFunction,
      }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > MAX_ANSWER_BYTES + 1) {
            res.destroy();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const status = res.statusCode ?? 502;
          const out = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value !== undefined) out.set(key, Array.isArray(value) ? value.join(", ") : value);
          }
          const empty = status === 204 || status === 205 || status === 304;
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status, headers: out }));
        });
        res.on("error", reject);
        res.on("close", () => { if (!res.complete) reject(new Error("the answer was cut off")); });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }) as typeof fetch;
}

// ── Talking to the server ────────────────────────────────────────────────────

function networkCode(err: unknown): string {
  const e = err as { name?: string; code?: string; cause?: { code?: string; name?: string } };
  return e?.cause?.code || e?.code || e?.cause?.name || e?.name || "";
}

function authHeader(apiKey: string | null): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

async function readCapped(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export type EndpointTranscript =
  | { ok: true; text: string }
  /** `error` is for the caller to show; `detail` for the box's log only. */
  | { ok: false; status: number; code: SttEndpointErrorCode; error: string; detail?: string };

export interface EndpointCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  lookupImpl?: LookupFn;
}

/**
 * Transcribe one recording on the owner's server. Never throws: the caller is
 * the transcribe route's engine chain.
 */
export async function transcribeAtEndpoint(
  record: SttEndpointRecord,
  apiKey: string | null,
  audio: { file: Blob; name: string },
  options: EndpointCallOptions = {},
): Promise<EndpointTranscript> {
  const refused = await endpointHostRefusal(record.baseUrl, options.lookupImpl);
  if (refused) {
    return {
      ok: false,
      status: 409,
      code: "address_refused",
      error: "The speech server's address is not on this box or the local network, so the recording was not sent.",
      detail: `endpoint host refused: ${refused}`,
    };
  }
  const form = new FormData();
  form.set("file", audio.file, audio.name);
  form.set("model", record.model);
  form.set("response_format", "json");
  const timeoutMs = options.timeoutMs ?? STT_ENDPOINT_TIMEOUT_MS;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await (options.fetchImpl ?? lanFetch(options.lookupImpl))(`${record.baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { Accept: "application/json", ...authHeader(apiKey) },
      body: form,
      redirect: "manual",
      cache: "no-store",
      signal,
    });
  } catch (err) {
    const code = networkCode(err);
    const timedOut = code === "TimeoutError" || code === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT";
    return {
      ok: false,
      status: 504,
      code: "unreachable",
      error: timedOut
        ? "The speech server on your network did not answer in time."
        : "Could not reach the speech server on your network.",
      detail: `endpoint ${timedOut ? "timed out" : `unreachable${code ? ` (${code})` : ""}`}`,
    };
  }
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => {});
    return { ok: false, status: 502, code: "unauthorized", error: "The speech server refused this box's API key.", detail: `endpoint ${res.status}` };
  }
  if (!res.ok) {
    // The body is not relayed: it can echo the request back.
    await res.body?.cancel().catch(() => {});
    return {
      ok: false,
      status: 502,
      code: "bad_response",
      error: `The speech server could not transcribe the recording (HTTP ${res.status}).`,
      detail: `endpoint ${res.status}`,
    };
  }
  let payload: unknown;
  try {
    const text = await readCapped(res, MAX_ANSWER_BYTES);
    if (text === null) return { ok: false, status: 502, code: "bad_response", error: "The speech server's answer is too large.", detail: "endpoint answer over 1 MB" };
    payload = JSON.parse(text);
  } catch {
    return { ok: false, status: 502, code: "bad_response", error: "The speech server's answer is not JSON.", detail: "endpoint answer unreadable" };
  }
  const text = (payload as { text?: unknown } | null)?.text;
  if (typeof text !== "string") {
    return { ok: false, status: 502, code: "bad_response", error: "The speech server answered without a transcript.", detail: "endpoint answer has no text" };
  }
  return { ok: true, text };
}

export type EndpointProbe =
  | { ok: true; latencyMs: number }
  | { ok: false; code: SttEndpointErrorCode; error: string };

/**
 * Is a server there, and does it take this key? `GET {base}/models`, the one
 * read every OpenAI-compatible server answers. Any HTTP answer but 401/403
 * means a server is listening — an ASR-only server may not list models — so
 * only an unreachable host, a refused key or a redirect fails it.
 */
export async function probeSttEndpoint(
  record: SttEndpointRecord,
  apiKey: string | null,
  options: EndpointCallOptions = {},
): Promise<EndpointProbe> {
  const refused = await endpointHostRefusal(record.baseUrl, options.lookupImpl);
  if (refused) {
    return { ok: false, code: "address_refused", error: `That address is ${refused}. The speech server must be on this box or on your local network.` };
  }
  const started = Date.now();
  let res: Response;
  try {
    res = await (options.fetchImpl ?? lanFetch(options.lookupImpl))(`${record.baseUrl}/models`, {
      method: "GET",
      headers: { Accept: "application/json", ...authHeader(apiKey) },
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(options.timeoutMs ?? STT_ENDPOINT_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    const code = networkCode(err);
    return {
      ok: false,
      code: "unreachable",
      error: `Could not reach ${record.baseUrl}${code ? ` (${code})` : ""}. Check the address and that the server is running.`,
    };
  }
  await res.body?.cancel().catch(() => {});
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "unauthorized", error: `The server refused the API key (HTTP ${res.status}).` };
  }
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, code: "bad_response", error: `The server answered with a redirect (HTTP ${res.status}). Enter the address it redirects to.` };
  }
  return { ok: true, latencyMs: Date.now() - started };
}

/** The script channel voice notes run, in the app's own `scripts/`. */
export function sttEndpointClientPath(): string {
  return path.join(resolveConfigRoot(), "scripts", STT_ENDPOINT_CLIENT_SCRIPT);
}
