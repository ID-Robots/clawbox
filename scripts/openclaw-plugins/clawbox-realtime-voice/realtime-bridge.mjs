// The ClawBox realtime voice provider: OpenClaw Talk over OpenAI Realtime, with
// the OpenAI key kept on the ClawBox AI proxy.
//
// WHY A PROVIDER OF OUR OWN. On the pinned core every bundled realtime provider
// mints its session secret on the box from an OpenAI Platform key the box holds
// (`talk.realtime.providers.<id>.apiKey`). A ClawBox holds no OpenAI key and
// must not. What it does hold is its ClawBox AI token (`claw_…`), which it
// already sends to the proxy for chat, speech and transcription. So the bridge
// below asks the proxy for a SHORT-LIVED OpenAI realtime client secret with that
// token, and opens the realtime WebSocket with the secret. The proxy is the one
// that checks the Max plan, books the weekly minutes and caps the session; the
// box never sees a long-lived provider key.
//
// THE PROXY CONTRACT (the server half lives in the ClawBox AI proxy):
//
//   POST {baseUrl}/realtime/client_secrets
//   Authorization: Bearer <claw_ token>
//   { "model": "<model>", "voice": "<voice>"? }
//
//   200 { "value": "<ephemeral secret>", "expires_at": <unix s>,
//         "session_seconds": <seconds this session may last>?,
//         "session_id": "<id to report usage against>"?,
//         "url": "wss://…"? }
//   401 token refused · 402/403 not on Max · 429 the week's minutes are used up
//
//   POST {baseUrl}/realtime/usage   (best effort, when a session_id was given)
//   { "session_id": "<id>", "seconds": <whole seconds the session was open> }
//
// The WebSocket is OpenAI's own, authenticated the documented way for an
// ephemeral secret: the `openai-insecure-api-key.<secret>` subprotocol. That is
// "insecure" for a long-lived key in a browser; for a secret that expires in
// minutes and is scoped to one session it is the intended use.

/** The realtime voice provider id. `talk.realtime.provider` names it. */
export const PROVIDER_ID = "clawbox";

/** The one model the proxy mints secrets for. CLAWBOX_TALK_MODEL_ID in gateway-pre-start.sh. */
export const DEFAULT_MODEL = "gpt-realtime-2.1-mini";

/** OpenAI's realtime WebSocket, used when the proxy names none. */
export const DEFAULT_REALTIME_URL = "wss://api.openai.com/v1/realtime";

/**
 * The longest a session may run when the proxy did not say: the whole weekly
 * allowance of the Max plan (60 minutes). A ceiling, not the meter — the proxy
 * meters — so a proxy that forgot `session_seconds` cannot hand out an
 * unbounded session.
 */
export const MAX_SESSION_SECONDS = 60 * 60;

const PCM16_24K = { encoding: "pcm16", sampleRateHz: 24000, channels: 1 };
const OPENAI_PCM = { type: "audio/pcm", rate: 24000 };
const SECRET_TIMEOUT_MS = 10_000;
const USAGE_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 15_000;
/** Microphone chunks held while the socket opens; ~2 s of audio at 20 ms chunks. */
const MAX_QUEUED_AUDIO = 100;

/** A ClawBox AI token, not an OpenAI key and not an empty string. */
export function isClawToken(value) {
  return typeof value === "string" && value.startsWith("claw_") && value.length > "claw_".length;
}

/**
 * Where the token may be sent: an HTTPS address with no credentials in it, or
 * a loopback proxy in development. Never plain HTTP to another host, so the
 * token cannot cross the network in the clear.
 *
 * The host is not checked against a list on purpose. The address and the token
 * come from the same `talk.realtime.providers.clawbox` entry, which ClawBox
 * writes with its proxy (a staging box names its staging host, an address the
 * gateway's own environment does not carry), and the token is refreshed only
 * where it already sits (`clawaiSpeechKeyRefresh`). Whoever can point the entry
 * elsewhere can already read the token beside it.
 */
export function isProxyUrl(value) {
  if (typeof value !== "string") return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function joinUrl(baseUrl, suffix) {
  return baseUrl.replace(/\/+$/, "") + suffix;
}

/** The sentence a Talk client shows when the proxy says no. Never carries a secret. */
export function refusalMessage(status, body) {
  const resetsAt = body && typeof body.resets_at === "string" ? body.resets_at : "";
  switch (status) {
    case 401:
      return "ClawBox AI did not accept this box's token. Re-link ClawBox AI in Settings.";
    case 402:
    case 403:
      return "Realtime Talk is part of the ClawBox AI Max plan. Hold-to-talk still works.";
    case 404:
      return "ClawBox AI realtime Talk is not available yet. Hold-to-talk still works.";
    case 429:
      return (
        "This week's realtime Talk minutes are used up." +
        (resetsAt ? ` They come back on ${resetsAt}.` : "") +
        " Hold-to-talk still works."
      );
    default:
      return `ClawBox AI realtime Talk is unavailable right now (HTTP ${status}).`;
  }
}

/**
 * The part of `fetch` this bridge uses — one JSON POST, then the answer's
 * status and body — so a stand-in has to provide only that much.
 *
 * @typedef {(url: string, init: { method: string, headers: Record<string, string>, body: string, signal?: AbortSignal }) => Promise<{ ok: boolean, status: number, json: () => Promise<any> }>} FetchLike
 */

/**
 * Trade the box's ClawBox AI token for an ephemeral OpenAI realtime secret.
 *
 * @param {{ baseUrl: unknown, token: unknown, model: string, voice?: string, fetchImpl?: FetchLike }} request
 * @returns {Promise<{ value: string, url: string, sessionSeconds: number, sessionId: string | null }>}
 */
export async function fetchClientSecret({ baseUrl, token, model, voice, fetchImpl = globalThis.fetch }) {
  if (!isClawToken(token)) throw new Error("ClawBox AI is not linked on this box, so realtime Talk is off.");
  if (!isProxyUrl(baseUrl)) throw new Error("The ClawBox AI address on this box is not one realtime Talk will use.");
  if (typeof fetchImpl !== "function") throw new Error("This Node has no fetch, so realtime Talk cannot start.");

  let response;
  try {
    response = await fetchImpl(joinUrl(baseUrl, "/realtime/client_secrets"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(voice ? { model, voice } : { model }),
      signal: AbortSignal.timeout(SECRET_TIMEOUT_MS),
    });
  } catch {
    throw new Error("Could not reach ClawBox AI for a realtime Talk session. Check the box's internet connection.");
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) throw new Error(refusalMessage(response.status, body));

  const value = body && typeof body.value === "string" ? body.value : "";
  if (!value) throw new Error("ClawBox AI answered without a realtime session secret.");
  const granted = Number(body.session_seconds);
  // A grant the proxy names is the ceiling; zero or less means it granted no
  // minutes, never "no limit". Only an absent or unreadable grant takes ours.
  if (Number.isFinite(granted) && granted <= 0) throw new Error(refusalMessage(429, body));
  const sessionSeconds = Number.isFinite(granted) ? Math.min(granted, MAX_SESSION_SECONDS) : MAX_SESSION_SECONDS;

  let url = `${DEFAULT_REALTIME_URL}?model=${encodeURIComponent(model)}`;
  if (typeof body.url === "string" && body.url) {
    let named;
    try {
      named = new URL(body.url);
    } catch {
      named = null;
    }
    // The secret goes wherever this points, so only a TLS WebSocket.
    if (!named || named.protocol !== "wss:") throw new Error("ClawBox AI named a realtime address that is not wss://.");
    url = named.toString();
  }
  const sessionId = typeof body.session_id === "string" && body.session_id ? body.session_id : null;
  return { value, url, sessionSeconds, sessionId };
}

/**
 * Best effort: tell the proxy how long the session really ran, so unused reserved minutes come back.
 *
 * @param {{ baseUrl: unknown, token: unknown, sessionId: string | null, seconds: number, fetchImpl?: FetchLike }} report
 * @returns {Promise<boolean>}
 */
export async function reportUsage({ baseUrl, token, sessionId, seconds, fetchImpl = globalThis.fetch }) {
  if (!sessionId || !isClawToken(token) || !isProxyUrl(baseUrl) || typeof fetchImpl !== "function") return false;
  try {
    const response = await fetchImpl(joinUrl(baseUrl, "/realtime/usage"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, seconds: Math.max(0, Math.round(seconds)) }),
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    return Boolean(response.ok);
  } catch {
    return false;
  }
}

function toolsForSession(tools) {
  if (!Array.isArray(tools)) return undefined;
  const out = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const fn = tool.function && typeof tool.function === "object" ? tool.function : tool;
    if (typeof fn.name !== "string" || !fn.name) continue;
    out.push({
      type: "function",
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
    });
  }
  return out;
}

function parseArgs(raw) {
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function messageText(data) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf-8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf-8");
  return "";
}

/**
 * One Talk session's bridge: the shape `registerRealtimeVoiceProvider`'s
 * `createBridge` returns.
 *
 * `deps` is the test seam — fetch, WebSocket and the clock. Production passes
 * nothing and gets the Node globals (Node 22 ships a WHATWG WebSocket).
 */
export function createClawboxRealtimeBridge(req = {}, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const WebSocketImpl = deps.WebSocket ?? globalThis.WebSocket;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;

  const providerConfig = req.providerConfig && typeof req.providerConfig === "object" ? req.providerConfig : {};
  const model =
    (typeof req.model === "string" && req.model) ||
    (typeof providerConfig.model === "string" && providerConfig.model) ||
    DEFAULT_MODEL;
  const voice =
    (typeof req.voice === "string" && req.voice) ||
    (typeof providerConfig.speakerVoice === "string" && providerConfig.speakerVoice) ||
    (typeof providerConfig.voice === "string" && providerConfig.voice) ||
    undefined;

  let socket = null;
  let open = false;
  let closed = false;
  let openedAt = 0;
  let capTimer = null;
  let sessionId = null;
  let closing = null;
  let lastAssistantItem = null;
  const queued = [];

  const send = (event) => {
    if (open && socket) socket.send(JSON.stringify(event));
  };

  // Hand the session's reserved minutes back to the proxy, ONCE: whichever
  // path ends the session first reports, and every later one finds no id.
  const releaseSession = (seconds) => {
    const id = sessionId;
    sessionId = null;
    return reportUsage({ baseUrl: providerConfig.baseUrl, token: providerConfig.apiKey, sessionId: id, seconds, fetchImpl });
  };

  const appendAudio = (audio) => {
    const bytes = Buffer.isBuffer(audio) ? audio : Buffer.from(audio ?? []);
    if (bytes.length === 0) return;
    send({ type: "input_audio_buffer.append", audio: bytes.toString("base64") });
  };

  const onServerEvent = (event) => {
    switch (event?.type) {
      case "response.output_audio.delta":
      case "response.audio.delta": {
        if (typeof event.delta !== "string") return;
        if (typeof event.item_id === "string") lastAssistantItem = event.item_id;
        req.onAudio?.(Buffer.from(event.delta, "base64"), event.item_id ? { itemId: event.item_id } : undefined);
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (typeof event.delta === "string") req.onTranscript?.("assistant", event.delta, false);
        return;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (typeof event.transcript === "string") req.onTranscript?.("assistant", event.transcript, true);
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (typeof event.delta === "string") req.onTranscript?.("user", event.delta, false);
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof event.transcript === "string") req.onTranscript?.("user", event.transcript, true);
        return;
      case "input_audio_buffer.speech_started":
        // The provider owns interruption from incoming audio
        // (`handlesInputAudioBargeIn`), so the host is told, not asked.
        req.onClearAudio?.("barge-in");
        return;
      case "response.function_call_arguments.done":
        if (typeof event.name !== "string" || typeof event.call_id !== "string") return;
        Promise.resolve(
          req.onToolCall?.({ itemId: event.item_id, callId: event.call_id, name: event.name, args: parseArgs(event.arguments) }),
        ).catch((err) => req.onError?.(err instanceof Error ? err : new Error(String(err))));
        return;
      case "error": {
        // A barge-in cancels the response that is playing; when none is, OpenAI
        // answers with this code. Nothing failed, so the host is not told.
        if (event.error?.code === "response_cancel_not_active") return;
        const message = typeof event.error?.message === "string" ? event.error.message : "OpenAI realtime reported an error.";
        req.onError?.(new Error(message));
        return;
      }
      default:
    }
  };

  const finish = (reason) => {
    if (closed) return closing;
    closed = true;
    open = false;
    if (capTimer) clearTimer(capTimer);
    capTimer = null;
    queued.length = 0;
    try {
      socket?.close(1000);
    } catch {
      // Already closing; the provider side is gone either way.
    }
    const seconds = openedAt ? (now() - openedAt) / 1000 : 0;
    closing = releaseSession(seconds).then(() => undefined);
    req.onClose?.(reason);
    return closing;
  };

  return {
    supportsToolResultContinuation: false,

    async connect() {
      if (closed) throw new Error("This realtime Talk session is already closed.");
      if (typeof WebSocketImpl !== "function") throw new Error("This Node has no WebSocket, so realtime Talk cannot start.");
      const secret = await fetchClientSecret({
        baseUrl: providerConfig.baseUrl,
        token: providerConfig.apiKey,
        model,
        voice,
        fetchImpl,
      });
      sessionId = secret.sessionId;
      if (closed) {
        // Closed while the secret was on its way: the close found no session to
        // report, so the minutes the proxy just reserved go back from here.
        void releaseSession(0);
        return;
      }

      socket = new WebSocketImpl(secret.url, ["realtime", `openai-insecure-api-key.${secret.value}`]);
      try {
        await new Promise((resolve, reject) => {
          const fail = () => {
            clearTimer(timer);
            reject(new Error("Could not open the realtime Talk connection."));
          };
          const timer = setTimer(() => reject(new Error("OpenAI realtime did not answer in time.")), CONNECT_TIMEOUT_MS);
          socket.onopen = () => {
            clearTimer(timer);
            resolve();
          };
          socket.onerror = fail;
          socket.onclose = fail;
        });
      } catch (err) {
        // Nothing ran: drop the socket and hand the reserved minutes back,
        // once — a close() before or after this finds no session id to report.
        try {
          socket.close(1000);
        } catch {
          // Never opened.
        }
        void releaseSession(0);
        // A close() while the socket was opening is what dropped it: the host
        // asked for that, so it is not a failed connect.
        if (closed) return;
        throw err;
      }
      if (closed) {
        socket.close(1000);
        return;
      }
      open = true;
      openedAt = now();
      socket.onmessage = (message) => {
        let event;
        try {
          event = JSON.parse(messageText(message?.data));
        } catch {
          return;
        }
        onServerEvent(event);
      };
      socket.onerror = () => req.onError?.(new Error("The realtime Talk connection failed."));
      socket.onclose = () => {
        if (!closed) finish("provider-closed");
      };

      const tools = toolsForSession(req.tools);
      send({
        type: "session.update",
        session: {
          type: "realtime",
          ...(typeof req.instructions === "string" && req.instructions ? { instructions: req.instructions } : {}),
          ...(tools && tools.length ? { tools, tool_choice: "auto" } : {}),
          audio: {
            input: {
              format: OPENAI_PCM,
              turn_detection: { type: "server_vad" },
              transcription: { model: "gpt-4o-mini-transcribe" },
            },
            output: { format: OPENAI_PCM, ...(voice ? { voice } : {}) },
          },
        },
      });
      // The proxy's grant, or the weekly allowance as a ceiling: the session
      // ends here rather than run past what was booked.
      capTimer = setTimer(() => {
        req.onError?.(new Error("This realtime Talk session reached its time allowance."));
        finish("allowance");
      }, secret.sessionSeconds * 1000);
      while (queued.length) appendAudio(queued.shift());
      req.onReady?.();
    },

    sendAudio(audio) {
      if (closed) return;
      if (!open) {
        if (queued.length < MAX_QUEUED_AUDIO) queued.push(audio);
        return;
      }
      appendAudio(audio);
    },

    setMediaTimestamp() {},

    handleBargeIn() {
      send({ type: "response.cancel" });
      if (lastAssistantItem) {
        const played = req.getPlaybackState?.();
        const entry = Array.isArray(played) ? played.find((item) => item?.itemId === lastAssistantItem) : null;
        if (entry && Number.isFinite(entry.audioEndMs)) {
          send({ type: "conversation.item.truncate", item_id: lastAssistantItem, content_index: 0, audio_end_ms: Math.max(0, Math.floor(entry.audioEndMs)) });
        }
      }
      req.onClearAudio?.("barge-in");
    },

    submitToolResult(callId, result, options = {}) {
      if (closed || typeof callId !== "string") return;
      send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: callId, output: typeof result === "string" ? result : JSON.stringify(result ?? null) },
      });
      if (!options?.willContinue && !options?.suppressResponse) send({ type: "response.create" });
    },

    acknowledgeMark() {},

    close() {
      return finish("closed");
    },

    isConnected() {
      return open && !closed;
    },
  };
}

/**
 * The provider descriptor for `api.registerRealtimeVoiceProvider`.
 *
 * Constructing it reads no credential and starts nothing — the core's rule for
 * native provider registration; all of that waits for `createBridge`.
 */
export function buildClawboxRealtimeProvider(deps = {}) {
  return {
    id: PROVIDER_ID,
    label: "ClawBox AI realtime voice",
    defaultModel: DEFAULT_MODEL,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [PCM16_24K],
      outputAudioFormats: [PCM16_24K],
      supportsBargeIn: true,
      handlesInputAudioBargeIn: true,
      supportsToolCalls: true,
    },
    isConfigured: ({ providerConfig } = {}) =>
      Boolean(providerConfig && isClawToken(providerConfig.apiKey) && isProxyUrl(providerConfig.baseUrl)),
    createBridge: (req) => createClawboxRealtimeBridge(req, deps),
  };
}
