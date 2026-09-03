// ClawBox's outbound guard for `EMAIL:` card directives, as an OpenClaw plugin.
//
// WHAT IT IS FOR. `EMAIL:4471` is how the agent tells a ClawBox CHAT that its
// reply points at a message the owner can open: `chat-email-refs.ts` lifts the
// line out and the bubble shows a card. Telegram, WhatsApp and Discord have no
// cards, so there the line is an internal id printed at the owner — the
// 2026-09-03 screenshot behind TASK-679.
//
// PR #605 fixed the half ClawBox owns: the email tools now ask for the
// directive only on the surfaces that can render a card. That half is a
// SENTENCE in a tool result, and a sentence is something a model can misread.
// This is the other half — the strip happens on the way out, whatever the model
// wrote.
//
// THE SEAM IS THE CORE'S OWN. `reply_payload_sending` — "Mutate or cancel
// normalized reply payloads before delivery" — is the typed outbound hook of
// the pinned 2026.8.1 core. It runs after the core has parsed its OWN `MEDIA:`
// and `[[…]]` directives out of the text and before the channel adapter sends,
// which is why nothing here re-implements those: they are already gone.
//
// Two properties of the dispatcher shape this file:
//
//   * A handler must RETURN `{ payload }`. The event it is given is a
//     `structuredClone`, so mutating `event.payload` writes to a throwaway.
//   * It is FAIL-OPEN with a 15 s ceiling: a throw is logged as
//     `[hooks] reply_payload_sending handler from clawbox-email-directives
//     failed: …` and that handler is skipped, delivery unchanged. So there is
//     deliberately no try/catch here — the core's own line names this plugin,
//     and swallowing the error would replace a diagnosable fault with a silent
//     one.
//
// WHAT IT CANNOT DO. The core synthesises speech BEFORE any outbound hook runs
// (`dispatch-from-config` applies TTS, then queues the payload for the
// dispatcher whose `beforeDeliver` calls this). Rewriting the text here does
// not change the audio that has already been made. The on-device voice is
// covered instead at its own entry point, `scripts/openclaw/clawbox-tts.sh`;
// a cloud voice on this edition is out of reach of both.

import { stripEmailDirectives } from "./email-directives.mjs";

/** The plugin id, which must match `openclaw.plugin.json` and the config key. */
const PLUGIN_ID = "clawbox-email-directives";

/**
 * Channels whose replies KEEP the directive.
 *
 * `webchat` is the core's `INTERNAL_MESSAGE_CHANNEL`: every gateway client on
 * `chat.send` gets it, which is ClawBox's dashboard chat, ClawBox's mascot
 * popup — the two surfaces that turn the directive INTO the card — and the
 * gateway's own Control UI, which shows it as text. Nothing in this hook's
 * context separates the three: `ctx` carries no client id, version or mode, and
 * ClawBox's own `version: 'clawbox-chat'` connect frame never reaches a hook.
 * That is TASK-700, and it is why this keeps all three rather than breaking the
 * two that work.
 *
 * ONLY THE NAMED SURFACES. A field that names nothing is not looked up here at
 * all — `keepsDirectives` skips an empty signal before it asks this set — so
 * "could not place this delivery" is one rule expressed in one place rather
 * than a `""` member that has to be remembered.
 *
 * KEEP-LIST, NEVER A DENY-LIST OF CHANNELS. A channel plugin installed
 * tomorrow arrives with a channel id nothing here has heard of, and it must
 * strip by default.
 */
const KEEP_CHANNELS = new Set(["webchat"]);

/** The reply payload fields that carry prose a person reads or hears. */
function strippedPayload(payload) {
  const next = { ...payload };
  let changed = false;

  const replace = (value) => {
    if (typeof value !== "string" || !value) return null;
    const stripped = stripEmailDirectives(value);
    return stripped === value ? null : stripped;
  };

  const text = replace(payload.text);
  if (text !== null) {
    // "" is deliberate rather than avoided: the core reads a payload with no
    // visible content left as `empty_after_reply_payload_sending_hook` and
    // suppresses the message, which is the right outcome for a reply that was
    // nothing but directives — and it still sends the media when there is any.
    //
    // The Hermes twin cannot do this: `transform_llm_output` accepts a
    // replacement only when it is a non-empty string, so an all-directive reply
    // becomes an ellipsis there. Same input, two answers, because the two
    // harnesses offer different powers — see
    // `scripts/hermes-plugins/clawbox_email_directives/__init__.py`.
    next.text = text;
    changed = true;
  }

  // The text a channel falls back to when it cannot render the primary form.
  if (payload.fallbackText && typeof payload.fallbackText === "object") {
    const fallback = replace(payload.fallbackText.text);
    if (fallback !== null) {
      next.fallbackText = { ...payload.fallbackText, text: fallback };
      changed = true;
    }
  }

  // The spoken transcript. The audio itself was made before this hook ran, so
  // this does not change what the box SAYS — it keeps the payload from carrying
  // an id that other surfaces (archival, search, a caption on the audio-only
  // path) would show.
  const spoken = replace(payload.spokenText);
  if (spoken !== null) {
    next.spokenText = spoken;
    changed = true;
  }
  if (payload.ttsSupplement && typeof payload.ttsSupplement === "object") {
    const supplement = replace(payload.ttsSupplement.spokenText);
    if (supplement !== null) {
      next.ttsSupplement = { ...payload.ttsSupplement, spokenText: supplement };
      changed = true;
    }
  }

  return changed ? next : null;
}

/**
 * WHERE THIS REPLY IS GOING — asked of BOTH signals, because neither one is
 * right on its own.
 *
 * Read off the pinned 2026.8.1 core installed on the OpenClaw box (read-only,
 * nothing mutated) rather than assumed:
 *
 *   `event.channel`   `deliver-prepare-BMUQRpAJ.js:125` — `finalized.Surface ??
 *                     finalized.Provider`.
 *   `ctx.channelId`   `message-hook-mappers-BvcG8vBF.js:50` — `OriginatingChannel
 *                     ?? Surface ?? Provider`, lower-cased, `""` when unknown.
 *
 * On the dashboard chat BOTH are the literal `"webchat"`:
 * `chat-send-handler-VKdsT8Lk.js:2367-2371` sets `Provider` and `Surface` to
 * `INTERNAL_MESSAGE_CHANNEL` (`message-channel-constants-2zSoJXQC.js:3`), and
 * `resolveChatSendOriginatingRoute` (`:355/365/382`) makes `OriginatingChannel`
 * the same for every send that is not an explicit deliver route. On a reply
 * arriving from a channel all three are that channel id
 * (`channel-inbound-CxNf-7n7.js:153-162`), and a routed outbound send builds
 * both fields from the destination (`route-reply-B6JDR0Lx.js:194-197`,
 * `delivery.runtime-Dz8vF_W2.js:619-622`).
 *
 * WHERE THEY COME APART, AND WHY THIS ASKS BOTH. A `chat.send` with
 * `deliver: true` and an explicit route keeps `Surface`/`Provider` pinned to
 * `"webchat"` while `OriginatingChannel` becomes the real channel
 * (`chat-send-handler-VKdsT8Lk.js:346-392`). So `event.channel` says `webchat`
 * for a reply headed to Telegram, and trusting it FIRST would print the id in
 * Telegram — the exact bug this plugin exists to stop. No case was found in the
 * other direction, where the event names a channel and the ctx names the chat.
 *
 * So the line is kept only when NOTHING about the delivery names a surface that
 * cannot draw a card. An empty or absent field is not a vote either way — the
 * core sets `channelId` to `""` when it knows nothing — so it cannot force a
 * strip, and a delivery this plugin cannot place at all still keeps the line,
 * because the cost of guessing wrong there is the card disappearing from the
 * chat the owner uses every day.
 *
 * Asking both also removes the precedence question altogether: there is no
 * order to get wrong, and a core that changes what one field means is caught by
 * the other rather than silently believed.
 */
function keepsDirectives(event, ctx) {
  for (const candidate of [ctx?.channelId, event?.channel]) {
    if (typeof candidate !== "string") continue;
    const surface = candidate.trim().toLowerCase();
    if (surface && !KEEP_CHANNELS.has(surface)) return false;
  }
  return true;
}

/**
 * The hook. `undefined` on every "nothing to do" path — the dispatcher reads a
 * falsy result as "this handler had no opinion" and moves on without cloning or
 * re-accepting the payload.
 */
export function onReplyPayloadSending(event, ctx) {
  if (keepsDirectives(event, ctx)) return undefined;
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const next = strippedPayload(payload);
  return next ? { payload: next } : undefined;
}

const clawboxEmailDirectivesPlugin = {
  id: PLUGIN_ID,
  name: "ClawBox email directives",
  description: "Removes EMAIL: card directives from replies leaving the box for a channel.",
  register(api) {
    api.on("reply_payload_sending", onReplyPayloadSending);
  },
};

// The loader follows only the `default` and `module` export keys, and its one
// hard requirement is that `register` is a function — a named export would be
// ignored, so this default is the plugin's entire contract with the core.
export default clawboxEmailDirectivesPlugin;
