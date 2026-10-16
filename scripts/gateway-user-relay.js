"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

// The chat socket of a signed-in ClawBox user who is NOT the owner.
//
// Every ClawBox user gets the owner's desktop except the main chat: each has
// their own conversation and never sees the owner's (src/lib/chat-scope.ts).
// The owner's browser talks to the OpenClaw gateway straight through
// production-server.js's upgrade pipe, holding the gateway's shared operator
// token — which the gateway treats as full operator access whatever scopes a
// caller declares (docs/gateway/operator-scopes.md, "Shared-secret auth", in
// the pinned core). A user's browser is never given that token: anyone who
// held it could read every session on the box, and the token works from any
// local account's shell too.
//
// So for a user, this server ends the browser's socket HERE and speaks to the
// gateway on their behalf:
//
//   * The handshake is the relay's own. The browser's `connect` is answered
//     with the gateway's hello, but the gateway is asked with THIS server's
//     token and its own device identity (an Ed25519 key in data/, paired once
//     like the browser's — loopback, so the gateway auto-approves it). The
//     hello goes back with the user's own main key in
//     `snapshot.sessionDefaults.mainSessionKey`, which is the one field the
//     chat reads from it; nothing else of the snapshot, and never the device
//     token the gateway mints for the relay.
//   * Every request names the session it acts on, and only the user's own
//     keys pass (chat.send, chat.history, sessions.reset/patch/delete, the
//     message subscription, the progress card). The few the chat sends with no
//     key (the slash-command catalogue, answering an approval or a question
//     the user was shown) pass as they are; everything else is refused with
//     the gateway's own error frame shape, so the chat reports it like any
//     other refusal.
//   * Every event the gateway broadcasts is dropped unless it names one of the
//     user's sessions, so the owner's turns never stream into a user's window.
//
// This is a wire filter, not a sandbox: the assistant runs as the box's own
// account for everyone, and its tools reach what that account reaches. What
// it guarantees is that a user's chat, its history and its live stream are
// theirs, and that the owner's are not on the wire to them.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { openclawUserMainKey, userMayUseKey } = require("./chat-scope.js");

/** The client the relay connects as: the same identity the browser's chat uses. */
const RELAY_CLIENT = Object.freeze({ id: "openclaw-control-ui", mode: "webchat", platform: "linux", version: "clawbox-user-relay" });
/** Never `operator.admin` or `operator.pairing`: nothing a user's chat sends needs either. */
const RELAY_SCOPES = Object.freeze(["operator.read", "operator.write", "operator.approvals", "operator.questions"]);
const PROTOCOL = 4;

/** Requests that act on one session, and the param that names it. The key is required. */
const KEYED_METHODS = Object.freeze({
  "chat.send": "sessionKey",
  "chat.abort": "sessionKey",
  "chat.history": "sessionKey",
  "progressCard.get": "sessionKey",
  "sessions.reset": "key",
  "sessions.patch": "key",
  "sessions.delete": "key",
  "sessions.messages.subscribe": "key",
  "sessions.messages.unsubscribe": "key",
});

/**
 * Requests the chat sends without a session key. `approval.resolve` and
 * `question.resolve` name an id the user could only have learnt from an event
 * this relay let through (both ids are random); `question.list` answers every
 * pending question on the box, so its answer is cut to the user's below.
 */
const KEYLESS_METHODS = new Set(["commands.list", "approval.resolve", "question.resolve", "question.list"]);

/** Events that name the session they are about, and where. */
const KEYED_EVENTS = Object.freeze({
  agent: ["sessionKey"],
  chat: ["sessionKey"],
  "session.message": ["sessionKey"],
  "progressCard.changed": ["sessionKey"],
  "session.approval": ["sessionKey", "sourceSessionKey"],
  "question.requested": ["sessionKey"],
});

/** The refusal the chat sees for a request this relay will not pass: the gateway's own `res` shape. */
function refusalFrame(id, message) {
  return {
    type: "res",
    id,
    ok: false,
    error: { code: "FORBIDDEN", message },
  };
}

/**
 * The per-connection state: who the socket belongs to, what is in flight.
 * `gatewayMainKey` arrives with the hello; until then the user's main is
 * derived from `main`, which the hello then corrects.
 */
function createRelayState(username) {
  return {
    username,
    connectId: null,
    connected: false,
    challenge: null,
    pending: new Map(),
    questions: new Set(),
  };
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * What to do with one frame from the browser, once the handshake is done:
 * `{ toGateway }` to pass it on, `{ toClient }` to answer it here, or `{}` to
 * drop it.
 */
function filterClientFrame(state, frame) {
  if (!isRecord(frame) || frame.type !== "req" || typeof frame.id !== "string" || typeof frame.method !== "string") {
    return {};
  }
  const { id, method } = frame;
  if (method === "connect") {
    return { toClient: refusalFrame(id, "This connection is already open.") };
  }
  const params = isRecord(frame.params) ? frame.params : {};
  const keyParam = KEYED_METHODS[method];
  if (keyParam) {
    if (!userMayUseKey(state.username, params[keyParam])) {
      return { toClient: refusalFrame(id, "That conversation belongs to someone else on this ClawBox.") };
    }
  } else if (!KEYLESS_METHODS.has(method)) {
    return { toClient: refusalFrame(id, `"${method}" is not available to this ClawBox user's chat.`) };
  }
  state.pending.set(id, method);
  return { toGateway: frame };
}

/** The pending questions of a `question.list` answer, cut to this user's sessions. */
function userQuestions(state, payload) {
  if (!isRecord(payload) || !Array.isArray(payload.questions)) return { questions: [] };
  const questions = payload.questions.filter((q) => isRecord(q) && userMayUseKey(state.username, q.sessionKey));
  for (const q of questions) if (typeof q.id === "string") state.questions.add(q.id);
  return { ...payload, questions };
}

/**
 * The hello as a user's chat is given it: the gateway's protocol, server,
 * features and policy, and a snapshot that carries ONLY the session defaults —
 * with the user's own main key. Never `auth`: the gateway's device token is
 * the relay's credential, not the browser's.
 */
function userHello(state, payload) {
  const hello = isRecord(payload) ? payload : {};
  const snapshot = isRecord(hello.snapshot) ? hello.snapshot : {};
  const defaults = isRecord(snapshot.sessionDefaults) ? snapshot.sessionDefaults : {};
  const gatewayMain = typeof defaults.mainSessionKey === "string" && defaults.mainSessionKey.trim()
    ? defaults.mainSessionKey
    : "main";
  const out = {};
  for (const field of ["type", "protocol", "server", "features", "policy"]) {
    if (field in hello) out[field] = hello[field];
  }
  out.snapshot = {
    sessionDefaults: {
      ...defaults,
      mainSessionKey: openclawUserMainKey(gatewayMain, state.username),
    },
  };
  return out;
}

/** What to do with one frame from the gateway: `{ toClient }` or `{}` to drop it. */
function filterGatewayFrame(state, frame) {
  if (!isRecord(frame)) return {};
  if (frame.type === "res" && typeof frame.id === "string") {
    if (frame.id === state.connectId) {
      if (frame.ok) {
        state.connected = true;
        return { toClient: { ...frame, payload: userHello(state, frame.payload) } };
      }
      return { toClient: frame };
    }
    const method = state.pending.get(frame.id);
    if (!method) return {};
    state.pending.delete(frame.id);
    if (method === "question.list" && frame.ok) {
      return { toClient: { ...frame, payload: userQuestions(state, frame.payload) } };
    }
    return { toClient: frame };
  }
  // A type test, written as a refusal: harness-contract reads `.event === "<literal>"`
  // as an event name, so the positive form would claim an event called "string".
  if (frame.type !== "event" || typeof frame.event !== "string") return {};
  if (frame.event === "connect.challenge") return { toClient: frame };
  const payload = isRecord(frame.payload) ? frame.payload : {};
  if (frame.event === "question.resolved") {
    // `{id, status, answers}` and no key: the id is the filter.
    return typeof payload.id === "string" && state.questions.has(payload.id) ? { toClient: frame } : {};
  }
  const fields = KEYED_EVENTS[frame.event];
  if (!fields) return {};
  const mine = fields.some((field) => userMayUseKey(state.username, payload[field]));
  if (!mine) return {};
  if (frame.event === "question.requested" && typeof payload.id === "string") state.questions.add(payload.id);
  return { toClient: frame };
}

// ── The relay's device identity ─────────────────────────────────────────────

/** OpenClaw's normalizeDeviceMetadataForAuth: trim, ASCII-lowercase. */
function normalizeMetadata(value) {
  return typeof value === "string" ? value.trim().replace(/[A-Z]/g, (c) => c.toLowerCase()) : "";
}

/**
 * The relay's Ed25519 identity, minted once into a 0600 file and kept: the
 * gateway pairs the PUBLIC key, so a new key would be a new device.
 */
function loadOrCreateRelayIdentity(file) {
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof stored?.d === "string" && typeof stored?.x === "string") {
      const privateKey = crypto.createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", d: stored.d, x: stored.x }, format: "jwk" });
      return { privateKey, publicKey: stored.x };
    }
  } catch {
    /* mint a fresh one below */
  }
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ d: jwk.d, x: jwk.x }), { mode: 0o600 });
  } catch {
    // Kept for this process only; the next start pairs again (auto-approved on loopback).
  }
  return { privateKey, publicKey: jwk.x };
}

/**
 * The `device` block for the relay's connect — OpenClaw's v3 device-auth
 * payload, exactly as src/lib/gateway-device-identity.ts signs it for the
 * browser — or null when the gateway sent no challenge to sign.
 */
function relayDeviceParams(identity, { nonce, ts, token, scopes }) {
  if (typeof nonce !== "string" || !nonce || typeof ts !== "number" || !Number.isFinite(ts)) return null;
  const deviceId = crypto.createHash("sha256").update(Buffer.from(identity.publicKey, "base64url")).digest("hex");
  const payload = [
    "v3",
    deviceId,
    RELAY_CLIENT.id,
    RELAY_CLIENT.mode,
    "operator",
    scopes.join(","),
    String(ts),
    token,
    nonce,
    normalizeMetadata(RELAY_CLIENT.platform),
    normalizeMetadata(undefined),
  ].join("|");
  const signature = crypto.sign(null, Buffer.from(payload, "utf-8"), identity.privateKey).toString("base64url");
  return { id: deviceId, publicKey: identity.publicKey, signature, signedAt: ts, nonce };
}

/** The relay's own connect request, under the id the browser's connect used. */
function buildRelayConnect(state, clientFrame, { token, identity }) {
  const clientParams = isRecord(clientFrame.params) ? clientFrame.params : {};
  const scopes = [...RELAY_SCOPES];
  const challenge = isRecord(state.challenge) ? state.challenge : {};
  const device = identity ? relayDeviceParams(identity, { nonce: challenge.nonce, ts: challenge.ts, token, scopes }) : null;
  return {
    type: "req",
    id: clientFrame.id,
    method: "connect",
    params: {
      minProtocol: PROTOCOL,
      maxProtocol: PROTOCOL,
      client: {
        id: RELAY_CLIENT.id,
        version: RELAY_CLIENT.version,
        platform: RELAY_CLIENT.platform,
        mode: RELAY_CLIENT.mode,
        instanceId: crypto.randomUUID(),
      },
      role: "operator",
      scopes,
      caps: ["tool-events"],
      auth: { token },
      ...(typeof clientParams.locale === "string" ? { locale: clientParams.locale.slice(0, 32) } : {}),
      ...(device ? { device } : {}),
    },
  };
}

// ── The token ───────────────────────────────────────────────────────────────

/** gateway.auth.token from openclaw.json, as src/lib/gateway-proxy.ts's getGatewayToken reads it. */
function readGatewayToken(configPath) {
  try {
    const token = JSON.parse(fs.readFileSync(configPath, "utf-8"))?.gateway?.auth?.token;
    return typeof token === "string" && token && !/^\$\{.+\}$/.test(token) ? token : "";
  } catch {
    return "";
  }
}

// ── One connection ──────────────────────────────────────────────────────────

/** A close code the browser will accept, for one the gateway sent. */
function safeCloseCode(code) {
  return Number.isInteger(code) && ((code >= 3000 && code <= 4999) || [1000, 1001, 1008, 1011].includes(code)) ? code : 1011;
}

const MAX_QUEUED_FRAMES = 64;

/**
 * Relay one user's chat socket. `clientWs` is the browser's socket (already
 * upgraded), `connectUpstream()` opens the gateway's.
 */
function relayUserChat({ clientWs, username, connectUpstream, token, identity, log = () => {} }) {
  const WebSocket = require("ws");
  const state = createRelayState(username);
  const queued = [];
  let upstream;
  let closed = false;

  const sendClient = (frame) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(frame));
  };
  const sendGateway = (frame) => {
    if (upstream && upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify(frame));
  };
  const closeBoth = (code, reason) => {
    if (closed) return;
    closed = true;
    try { clientWs.close(safeCloseCode(code), typeof reason === "string" ? reason.slice(0, 120) : undefined); } catch { /* gone */ }
    try { upstream?.close(); } catch { /* gone */ }
  };

  if (!token) {
    // No gateway credential on this box (not set up yet, or a SecretRef the
    // web server cannot resolve): the chat reports a closed connection.
    log("no gateway token; closing the user's chat socket");
    closeBoth(1011, "The assistant is not reachable yet.");
    return;
  }

  const handleClient = (raw) => {
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (!state.connectId) {
      if (!isRecord(frame) || frame.type !== "req" || frame.method !== "connect" || typeof frame.id !== "string") return;
      state.connectId = frame.id;
      sendGateway(buildRelayConnect(state, frame, { token, identity }));
      return;
    }
    if (!state.connected) return;
    const out = filterClientFrame(state, frame);
    if (out.toClient) sendClient(out.toClient);
    if (out.toGateway) sendGateway(out.toGateway);
  };

  clientWs.on("message", (raw, isBinary) => {
    if (isBinary) return;
    if (!upstream || upstream.readyState !== WebSocket.OPEN) {
      if (queued.length < MAX_QUEUED_FRAMES) queued.push(raw);
      return;
    }
    handleClient(raw);
  });
  clientWs.on("close", () => closeBoth(1000));
  clientWs.on("error", () => closeBoth(1011));

  upstream = connectUpstream();
  upstream.on("open", () => {
    for (const raw of queued.splice(0)) handleClient(raw);
  });
  upstream.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let frame;
    try { frame = JSON.parse(String(raw)); } catch { return; }
    if (isRecord(frame) && frame.type === "event" && frame.event === "connect.challenge") {
      state.challenge = isRecord(frame.payload) ? frame.payload : null;
    }
    const out = filterGatewayFrame(state, frame);
    if (out.toClient) sendClient(out.toClient);
  });
  upstream.on("close", (code, reason) => closeBoth(code, reason ? String(reason) : undefined));
  upstream.on("error", (err) => {
    log(`gateway socket error: ${err && err.message ? err.message : err}`);
    closeBoth(1011);
  });
}

module.exports = {
  RELAY_SCOPES,
  KEYED_METHODS,
  KEYLESS_METHODS,
  createRelayState,
  filterClientFrame,
  filterGatewayFrame,
  userHello,
  buildRelayConnect,
  relayDeviceParams,
  loadOrCreateRelayIdentity,
  readGatewayToken,
  relayUserChat,
};
