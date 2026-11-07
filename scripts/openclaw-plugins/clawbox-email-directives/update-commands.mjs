// The owner's /update, and a tap on the weekly notice's Update button, taken
// off the wire before the model sees them (TASK-2260).
//
// SAME SEAM AS email-approvals.mjs: `before_dispatch`, the core's typed inbound
// CLAIM hook. A tap needs nothing more, because OpenClaw (2026.10.x) turns an
// inline-button tap it has no handler for into a synthetic message from the
// presser — `callback_data: <data>` — and sends it down the same inbound path
// as typed text, after its own sender authorization (the core's
// `callback-allowlist` for a private chat). So the button's data and the typed
// command are both just text by the time they reach this hook.
//
// WHAT IT DOES NOT DECIDE. Not who the owner is, not whether there is an
// update, and never whether one runs: it matches the shape, hands the message
// to /setup-api/update/chat-command and claims it. Every gate is on the ClawBox
// side (src/lib/update-notice.ts), and the button only ever ASKS — the update
// runs only when the owner confirms on the desktop or the approvals bot.
//
// FAIL CLOSED, unlike the email hook, and on purpose. A message this hook does
// not claim goes on through the core — and the core has a `/update` of its own
// ("Update OpenClaw and restart"), which would update the OpenClaw core
// underneath ClawBox's pin. An owner who typed /update meant the ClawBox
// update; if ClawBox cannot be asked, he is told so, and nothing else runs.

import { API_BASE, TOKEN_RE, apiToken, channelOf, contentOf, forgetApiToken, senderOf } from "./email-approvals.mjs";

/** The button's callback data — `UPDATE_BUTTON_DATA` in src/lib/update-notice.ts. */
export const UPDATE_BUTTON_DATA = "clawbox-update";

/**
 * The shape, identical to `parseUpdateChatCommand` (pinned by
 * src/tests/unit/update-notice-plugin-parity.test.ts): `/update` or
 * `/update@<bot>`, the bare button data, or the form OpenClaw gives a tap.
 */
const COMMAND_SHAPE = /^\/update(?:@[A-Za-z0-9_]{1,64})?$/i;

export function looksLikeUpdateCommand(text) {
  if (typeof text !== "string") return false;
  const trimmed = text.replace(/\ufeff/g, "").trim();
  return COMMAND_SHAPE.test(trimmed)
    || trimmed === UPDATE_BUTTON_DATA
    || trimmed === `callback_data: ${UPDATE_BUTTON_DATA}`;
}

/** ClawBox answers before it does the slow part, so this is a loopback round trip. */
const TIMEOUT_MS = 15_000;

/** Said in the chat when ClawBox could not be asked — the core then sends it, and nothing else runs. */
export const UNAVAILABLE_TEXT = "ClawBox could not answer /update just now. Try again in a minute.";

async function ask(token, body) {
  const matched = TOKEN_RE.exec(token.trim());
  if (!matched) return { status: 0, handled: false };
  const res = await fetch(`${API_BASE}/setup-api/update/chat-command`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${matched[1]}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return { status: res.status, handled: false };
  const answer = await res.json().catch(() => null);
  return { status: res.status, handled: !!answer && answer.handled === true };
}

/**
 * `{ handled: true }` when ClawBox took the message (it answers the owner
 * itself, on the same bot); `{ handled: true, text }` when it could not be
 * asked; `undefined` for everything that is not /update or the button.
 */
export async function onUpdateCommand(event, ctx) {
  const text = contentOf(event);
  if (!looksLikeUpdateCommand(text)) return undefined;
  // The allowlist ClawBox weighs the sender against is Telegram's; /update on
  // another channel is not this feature's.
  if (channelOf(event, ctx) !== "telegram") return undefined;
  const senderId = senderOf(event, ctx);
  if (!senderId) return { handled: true, text: UNAVAILABLE_TEXT };

  const body = {
    senderId,
    text,
    channel: "telegram",
    harness: "openclaw",
    isGroup: event?.isGroup === true || ctx?.isGroup === true,
  };
  try {
    const token = apiToken();
    if (!token) return { handled: true, text: UNAVAILABLE_TEXT };
    let answer = await ask(token, body);
    if (answer.status === 401 || answer.status === 403) {
      // A stale cached bearer: read the file once more, as the email hook does.
      forgetApiToken();
      const fresh = apiToken();
      if (fresh && fresh !== token) answer = await ask(fresh, body);
    }
    return answer.handled ? { handled: true } : { handled: true, text: UNAVAILABLE_TEXT };
  } catch {
    return { handled: true, text: UNAVAILABLE_TEXT };
  }
}
