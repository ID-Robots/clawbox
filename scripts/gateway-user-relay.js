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
//     message subscription, the progress card and its refresh and clear —
//     a clear only, never a write). The few the chat sends with no
//     key (the slash-command catalogue, answering an approval or a question
//     the user was shown) pass as they are; everything else is refused with
//     the gateway's own error frame shape, so the chat reports it like any
//     other refusal.
//   * `sessions.reset` (the chat's /new and /reset) is the one exception to
//     "never admin": OpenClaw requires `operator.admin` from any caller that
//     declares scopes before it resets a session, so the user's socket can
//     never do it. Once the key has passed the same ownership check, the relay
//     runs that one reset on a short-lived socket of its own that declares
//     admin, sends nothing else on it, and closes it. The browser's socket
//     keeps its scopes; the user can reset only their own sessions.
//   * Every event the gateway broadcasts is dropped unless it names one of the
//     user's sessions, so the owner's turns never stream into a user's window.
//
// This is a wire filter, not a sandbox: the assistant runs as the box's own
// account for everyone, and its tools reach what that account reaches. What
// it guarantees is that a user's chat, its history and its live stream are
// theirs, and that the owner's are not on the wire to them.
//
// ON AN ORGANISATION BOX (org_mode, src/lib/org-mode.ts) a member of staff's
// conversations live on THEIR OWN agent, `clawbox-staff-<name>`
// (src/lib/org-staff-agents.ts): its own workspace and memory, and the tool
// allow-list of config/org-staff-policy.json enforced by the gateway itself.
// The relay is what holds them to it (`staffAgent` in the state):
//
//   * the hello names `agent:clawbox-staff-<name>:clawbox-user-<name>`, and
//     only keys on that agent pass — never their old key on the owner's agent;
//   * a turn goes out only while that agent is configured with the staff
//     policy (`staffReady`), so a missing or widened entry fails closed rather
//     than running with the core's defaults;
//   * `/new` and `/reasoning` are the only commands they may send, and no
//     inline directive (`/model x` mid-sentence) reaches the gateway; the
//     catalogue they are shown is cut to those two;
//   * a session patch carries only the thinking and reasoning levels and a
//     label — never a model, a tool override or an elevated level;
//   * a `chat.send` carries only the fields ClawBox's chat sends.
//
// The owner turning the switch while the socket is open closes it, so the
// next hello is the right one.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { agentIdOfKey, openclawUserMainKey, userMayUseKey } = require("./chat-scope.js");
const {
  STAFF_GUARD_PLUGIN_ID,
  isStaffCatalogueCommand,
  staffAgentConfigured,
  staffCommandRefusal,
  staffGuardEnabled,
  staffMessageVerdict,
} = require("./org-staff-policy.js");

/** The client the relay connects as: the same identity the browser's chat uses. */
const RELAY_CLIENT = Object.freeze({ id: "openclaw-control-ui", mode: "webchat", platform: "linux", version: "clawbox-user-relay" });
/** Never `operator.admin` or `operator.pairing`: nothing a user's chat sends needs either. */
const RELAY_SCOPES = Object.freeze(["operator.read", "operator.write", "operator.approvals", "operator.questions"]);
/** The scopes of the one-shot socket that runs a user's `sessions.reset`, and nothing else. */
const RESET_SCOPES = Object.freeze([...RELAY_SCOPES, "operator.admin"]);
const RESET_TIMEOUT_MS = 15_000;
const PROTOCOL = 4;

/** Requests that act on one session, and the param that names it. The key is required. */
const KEYED_METHODS = Object.freeze({
  "chat.send": "sessionKey",
  "chat.abort": "sessionKey",
  "chat.history": "sessionKey",
  "progressCard.get": "sessionKey",
  "progressCard.put": "sessionKey",
  "progressCard.refresh": "sessionKey",
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
function createRelayState(username, options = {}) {
  return {
    username,
    // A member of staff on an organisation box: their own agent's id, else null.
    staffAgent: typeof options.staffAgent === "string" && options.staffAgent ? options.staffAgent.toLowerCase() : null,
    // Whether that agent is configured with the staff policy right now.
    staffReady: typeof options.staffReady === "function" ? options.staffReady : () => false,
    connectId: null,
    connected: false,
    challenge: null,
    pending: new Map(),
    questions: new Set(),
  };
}

/**
 * May this connection use the session behind `key`? The user's own key, and
 * for a member of staff only on their own agent.
 */
function mayUseKey(state, key) {
  if (!userMayUseKey(state.username, key)) return false;
  return !state.staffAgent || agentIdOfKey(key.trim()) === state.staffAgent;
}

/** The fields of a member of staff's `chat.send` that travel: what ClawBox's chat sends, nothing that routes, binds tools or claims system input. */
const STAFF_CHAT_SEND_FIELDS = Object.freeze(["sessionKey", "message", "idempotencyKey", "attachments", "thinking", "timeoutMs"]);

/** The session settings a member of staff may change: the thinking and reasoning levels (`/reasoning`), and a label. */
const STAFF_PATCH_FIELDS = Object.freeze(["thinkingLevel", "reasoningLevel", "label", "autoLabel"]);

/**
 * A member of staff's request, narrowed: `{ params }` to pass on, or
 * `{ refuse }` with the sentence they read. Called after the key check.
 */
function staffRequest(state, method, params) {
  if (params.agentId !== undefined && (typeof params.agentId !== "string" || params.agentId.toLowerCase() !== state.staffAgent)) {
    return { refuse: "That assistant belongs to someone else on this ClawBox." };
  }
  if (method === "chat.send") {
    const verdict = staffMessageVerdict(params.message, { inline: true });
    if (!verdict.ok) return { refuse: staffCommandRefusal(verdict.command) };
    if (!state.staffReady()) return { refuse: "Your assistant is being set up on this ClawBox. Try again in a minute." };
    const out = { deliver: false };
    for (const field of STAFF_CHAT_SEND_FIELDS) if (params[field] !== undefined) out[field] = params[field];
    return { params: out };
  }
  if (method === "sessions.patch") {
    const out = { key: params.key };
    let changes = 0;
    for (const field of STAFF_PATCH_FIELDS) {
      if (params[field] !== undefined) {
        out[field] = params[field];
        changes += 1;
      }
    }
    // The chat sends the ClawBox AI model beside the level to repair old
    // session pins; that half is the administrator's and is dropped. A patch
    // that was ONLY a model (or a tool override, an elevated level…) is refused.
    if (changes === 0) return { refuse: "This setting is chosen by your administrator on this organisation's ClawBox." };
    return { params: out };
  }
  if (method === "commands.list") {
    return { params: { ...params, agentId: state.staffAgent } };
  }
  return { params };
}

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * What to do with one frame from the browser, once the handshake is done:
 * `{ toGateway }` to pass it on, `{ toClient }` to answer it here, `{ reset }`
 * to run a reset of the user's own session on the relay's admin socket, or
 * `{}` to drop it.
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
  let forwarded = frame;
  if (state.staffAgent && (keyParam || KEYLESS_METHODS.has(method))) {
    if (keyParam && !mayUseKey(state, params[keyParam])) {
      return { toClient: refusalFrame(id, "That conversation belongs to someone else on this ClawBox.") };
    }
    const narrowed = staffRequest(state, method, params);
    if (narrowed.refuse) return { toClient: refusalFrame(id, narrowed.refuse) };
    forwarded = { type: "req", id, method, params: narrowed.params };
  }
  if (keyParam) {
    if (!mayUseKey(state, params[keyParam])) {
      return { toClient: refusalFrame(id, "That conversation belongs to someone else on this ClawBox.") };
    }
    if (method === "sessions.reset") {
      // Only the key and the reason travel: nothing else of the browser's frame
      // reaches a socket that holds operator.admin.
      const resetParams = { key: params.key };
      if (typeof params.reason === "string") resetParams.reason = params.reason.slice(0, 32);
      return { reset: { id, params: resetParams } };
    }
    if (method === "progressCard.put") {
      // The chat's only write to the card is the trash: a clear of the user's
      // own card, checked against the revision they saw. A note or a plan
      // never travels — what the card says is the agent's to write — and
      // neither does a clear without the revision, which could erase a newer card.
      if (!Number.isInteger(params.expectedRevision) || params.expectedRevision < 1) {
        return { toClient: refusalFrame(id, "A progress card is cleared only against the revision on screen.") };
      }
      state.pending.set(id, method);
      return { toGateway: { type: "req", id, method, params: { sessionKey: params.sessionKey, expectedRevision: params.expectedRevision } } };
    }
    if (method === "progressCard.refresh") {
      // Just the session and the retry key: the refresh carries no prompt of the caller's.
      const refreshParams = { sessionKey: params.sessionKey, idempotencyKey: typeof params.idempotencyKey === "string" ? params.idempotencyKey.slice(0, 128) : "" };
      state.pending.set(id, method);
      return { toGateway: { type: "req", id, method, params: refreshParams } };
    }
  } else if (!KEYLESS_METHODS.has(method)) {
    return { toClient: refusalFrame(id, `"${method}" is not available to this ClawBox user's chat.`) };
  }
  state.pending.set(id, method);
  return { toGateway: forwarded };
}

/** A `commands.list` answer cut to what a member of staff may send: /new and /reasoning. */
function staffCommands(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.commands)) return { commands: [] };
  return { ...payload, commands: payload.commands.filter((c) => isRecord(c) && isStaffCatalogueCommand(c.name)) };
}

/** The pending questions of a `question.list` answer, cut to this user's sessions. */
function userQuestions(state, payload) {
  if (!isRecord(payload) || !Array.isArray(payload.questions)) return { questions: [] };
  const questions = payload.questions.filter((q) => isRecord(q) && mayUseKey(state, q.sessionKey));
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
      // A member of staff's main is on their own agent, whatever the gateway's is.
      mainSessionKey: openclawUserMainKey(state.staffAgent ? `agent:${state.staffAgent}:main` : gatewayMain, state.username),
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
    if (method === "commands.list" && frame.ok && state.staffAgent) {
      return { toClient: { ...frame, payload: staffCommands(frame.payload) } };
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
  const mine = fields.some((field) => mayUseKey(state, payload[field]));
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
function buildRelayConnect(state, clientFrame, { token, identity, scopes: wanted = RELAY_SCOPES }) {
  const clientParams = isRecord(clientFrame.params) ? clientFrame.params : {};
  const scopes = [...wanted];
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

// ── A user's reset ──────────────────────────────────────────────────────────

/**
 * Run one `sessions.reset` on a socket of the relay's own that declares
 * `operator.admin`, and resolve with the gateway's `res` under the browser's
 * request id. The caller has already checked that the key is the user's.
 * Never rejects: a failure is a refusal frame the chat reports as usual.
 */
function runAdminReset({ id, params, connectUpstream, token, identity, timeoutMs = RESET_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let ws;
    let settled = false;
    let timer;
    const state = createRelayState("");
    const connectId = `reset-connect-${crypto.randomUUID()}`;
    const resetId = `reset-${crypto.randomUUID()}`;
    const finish = (frame) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* gone */ }
      resolve(frame);
    };
    const fail = () => finish(refusalFrame(id, "The conversation could not be reset. Try again."));
    timer = setTimeout(fail, timeoutMs);
    try {
      ws = connectUpstream();
    } catch {
      fail();
      return;
    }
    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let frame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      if (!isRecord(frame)) return;
      if (frame.type === "event" && frame.event === "connect.challenge") {
        state.challenge = isRecord(frame.payload) ? frame.payload : null;
        ws.send(JSON.stringify(buildRelayConnect(state, { id: connectId }, { token, identity, scopes: RESET_SCOPES })));
        return;
      }
      if (frame.type !== "res") return;
      if (frame.id === connectId) {
        if (!frame.ok) { fail(); return; }
        ws.send(JSON.stringify({ type: "req", id: resetId, method: "sessions.reset", params }));
        return;
      }
      if (frame.id === resetId) finish({ ...frame, id });
    });
    ws.on("error", fail);
    ws.on("close", fail);
  });
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
function relayUserChat({ clientWs, username, connectUpstream, token, identity, staffAgent = null, staffReady, stillCurrent = () => true, log = () => {} }) {
  const WebSocket = require("ws");
  const state = createRelayState(username, { staffAgent, staffReady });
  const queued = [];
  let upstream;
  let closed = false;
  // One admin reset socket per browser connection at a time: a burst of
  // /new frames must not open a burst of admin sockets on the gateway.
  let resetInFlight = false;

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
    // The owner turned the organisation switch since this socket opened: the
    // hello it was given names the wrong agent. Closed, the chat reconnects
    // and is handed the right one.
    if (!stillCurrent()) {
      log("the organisation switch moved; closing the user's chat socket");
      closeBoth(1001, "This ClawBox's settings changed. Reconnecting.");
      return;
    }
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
    if (out.reset) {
      if (resetInFlight) {
        sendClient(refusalFrame(out.reset.id, "A reset is already running. Try again in a moment."));
        return;
      }
      resetInFlight = true;
      runAdminReset({ ...out.reset, connectUpstream, token, identity })
        .then((res) => {
          if (!closed) sendClient(res);
        })
        .finally(() => {
          resetInFlight = false;
        });
    }
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

// ── A member of staff's agent ───────────────────────────────────────────────

/**
 * `staffReady` for production-server.js: is `agentId` configured with the
 * staff policy in openclaw.json right now, AND is the staff guard installed
 * and enabled beside it (its file tools reach past the member's folder
 * without it)? Re-read when the file changes (its mtime), so a roster the
 * owner's switch just wrote is seen on the next turn; an unreadable file is
 * "not ready".
 */
function staffReadyReader(configPath, agentId) {
  const guard = path.join(path.dirname(configPath), "extensions", STAFF_GUARD_PLUGIN_ID, "index.mjs");
  let seen = null;
  let ready = false;
  return () => {
    try {
      // ONE descriptor for the stat and the read, so the mtime remembered is
      // the mtime of the bytes judged (no check-then-use race on the path).
      const fd = fs.openSync(configPath, "r");
      try {
        const mtimeMs = fs.fstatSync(fd).mtimeMs;
        if (seen !== mtimeMs) {
          const config = JSON.parse(fs.readFileSync(fd, "utf-8"));
          seen = mtimeMs;
          ready = staffAgentConfigured(config, agentId) && staffGuardEnabled(config);
        }
      } finally {
        fs.closeSync(fd);
      }
      if (!ready) return false;
      // The guard's own entry point, opened rather than looked for.
      fs.closeSync(fs.openSync(guard, "r"));
      return true;
    } catch {
      seen = null;
      return false;
    }
  };
}

module.exports = {
  RELAY_SCOPES,
  RESET_SCOPES,
  runAdminReset,
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
  staffReadyReader,
};
