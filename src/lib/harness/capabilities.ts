import type { HarnessCapabilities, HarnessId, HarnessStatus } from "./transport";

/**
 * What the chat surface may offer, per harness, on THIS box.
 *
 * Not constants: functions of the box's resolved state, so "Hermes with no
 * ClawBox AI token" honestly reports `canTranscribe: false` and hides the
 * microphone, while a linked one reports true and shows it. A capability that
 * ignored the credential would be a lie in one direction or the other on every
 * box that disagreed with the hardcoded answer.
 */

/**
 * The facts a capability is computed from. Resolved server-side and served by
 * `/setup-api/chat/capabilities`, because both of them are things only the box
 * can answer and neither may be sent to the browser as its underlying value —
 * `hasClawaiToken` is a boolean precisely so the token itself never travels.
 */
export interface HarnessFacts {
  /** A ClawBox AI device credential exists, in either edition's store. */
  hasClawaiToken: boolean;
  /**
   * The installed `hermes` understands `chat --image`.
   *
   * A PROBED fact rather than a compile-time constant, because upstream
   * Hermes moves daily and the flag is what makes an attachment reach the
   * model. On a miss the attach button honestly disappears rather than staging
   * files into a turn that would silently ignore them.
   */
  hermesSupportsImages: boolean;
  /**
   * There is somewhere for an attached picture to be LOOKED AT
   * (`auxiliary.vision.model` in `~/.hermes/config.yaml`).
   *
   * The other half of the same capability, and a separate fact because it has a
   * separate cause: the flag above says the turn will carry the file, this says
   * something will read it. An unlinked box passes the first and fails the
   * second — `image_routing.py` falls back to `vision_analyze` for a chat model
   * that is not vision-capable, and with nothing named there the picture
   * arrives nowhere.
   */
  hermesHasVisionRoute: boolean;
  /**
   * Turns can be run through the already-running `hermes dashboard` process and
   * streamed back token by token, instead of spawning a `chat -q` per message.
   *
   * PROBED, like the two above, and for a sharper reason than either: the
   * dashboard is a separate service that can be stopped, and the answer is
   * therefore about the box's state this minute rather than about which version
   * is installed. A wrong `true` would promise the composer a stream it then
   * never gets; the route's own fallback covers that, but the caret would sit
   * empty until the whole turn landed, which is worse than never claiming it.
   */
  hermesStreamsTurns: boolean;
  /**
   * The agent on this box has an image backend to reach for
   * (`image_gen.provider` in `~/.hermes/config.yaml`).
   *
   * PROBED, like the rest, and about the box rather than the version: linking
   * ClawBox AI installs the backend and names it, and the write is fail-soft,
   * so two boxes running the same `hermes` can disagree. It reads the same key
   * the agent's own dispatcher reads at tool time.
   */
  hermesAgentDrawsImages: boolean;
}

/**
 * Hermes keeps a durable transcript: `transcript-store.ts`, written by the chat
 * route as each turn goes out and comes back, read by `/setup-api/chat/history`.
 *
 * It used to be false, and this was the single line to flip when the store
 * landed. It stays a named constant rather than being inlined as `true` for the
 * same reason it was named while false: what it records is that Hermes' history
 * is OURS to keep, not the transport's — the one thing about this capability
 * that a reader would otherwise have to go and discover.
 */
export const HERMES_DURABLE_TRANSCRIPT = true;

/**
 * How many files one turn may carry.
 *
 * OpenClaw's is the multipart part cap the staging route already enforces
 * (`chat/attachments/route.ts` MAX_PARTS). Hermes' is lower because only the
 * first image rides a real flag and the rest are resolved out of the prompt
 * text, which is a convention worth keeping short.
 */
const MAX_ATTACHMENTS = { openclaw: 12, hermes: 8 } as const;

export function capabilitiesFor(id: HarnessId, facts: HarnessFacts): HarnessCapabilities {
  if (id === "hermes") {
    return {
      // True only where the box can actually do it. A turn routed through the
      // running dashboard streams token by token; one that has to spawn
      // `hermes chat -q … -Q` cannot, because the whole answer is read off the
      // child's stdout after roughly six seconds of the process starting up.
      // The route tries the first and falls back to the second, so this says
      // which of the two the composer should expect — and on a box with no
      // dashboard it still honestly says no.
      streamsTurns: facts.hermesStreamsTurns,
      canListHistory: HERMES_DURABLE_TRANSCRIPT,
      // Forgetting the resumed session id IS the reset: the next turn goes out
      // with no `--resume`, so the box opens a fresh session. Every bit as real
      // a reset as the gateway's, and the only one Hermes can have.
      canResetSession: true,
      // `sessions.patch` is a gateway call. There is no session on the box to
      // patch — see `reasoningScope` for what Hermes has instead.
      canPatchSessionDefaults: false,
      reasoningScope: "per-turn",
      // BOTH halves, because a picture needs both to be answered about: a turn
      // that CARRIES it (`chat --image`) and something that LOOKS at it
      // (`auxiliary.vision`). Gating on the flag alone shipped the attach
      // button on an unlinked box, where the file reached the agent and no
      // vision route existed — the model reached for a `vision_analyze` tool
      // that was not installed and finally hand-wrote pixel-scanning code to
      // answer at all. The composer promising something the box half-does is
      // the failure this table exists to stop.
      canAttachImages: facts.hermesSupportsImages && facts.hermesHasVisionRoute,
      // `--image` is image-only, and the agent's own path-in-prompt resolver
      // matches picture extensions by design. A document has no way in.
      canAttachDocuments: false,
      maxAttachmentsPerTurn: MAX_ATTACHMENTS.hermes,
      // The transcription route is edition-neutral — it posts to the ClawBox
      // AI proxy, which both editions can reach. What a Hermes box may lack is
      // the credential, so that is exactly what this asks about.
      canTranscribe: facts.hasClawaiToken,
      // TRUE once the agent has a backend to reach for — which is the same
      // shape image generation has on OpenClaw, and deliberately so.
      //
      // It used to be false because the premise was that Hermes had "no image
      // plugin and no provider slot to put one in". The second half of that was
      // wrong: Hermes has a whole plugin KIND for image backends
      // (`~/.hermes/plugins/image_gen/<name>/`, resolved through
      // `image_gen.provider`), and ClawBox now installs one that speaks to the
      // ClawBox AI images endpoint with the device's own token. So a Hermes
      // customer asks for a picture the way an OpenClaw customer does — in
      // words, in any channel — and the agent draws it.
      //
      // Computed from the CONFIG rather than from the token, and
      // `hermesAgentDrawsImages` carries the argument for that: linking is what
      // writes the key, but the write is fail-soft, so a box can hold the
      // credential and still have nothing to draw with.
      canGenerateImages: facts.hermesAgentDrawsImages,
      // Speaking replies is a gateway capability with no Hermes equivalent.
      // Genuinely absent, and note this is voice OUTPUT: voice INPUT is
      // `canTranscribe` above and is a different feature with a different
      // answer. Reading one as the other is how a working microphone gets
      // hidden behind a card that says "voice is an OpenClaw feature".
      canSpeakReplies: false,
      canAbortTurn: true,
      // There is no socket, so there is nothing that can be "down" and a
      // connection banner would be describing a wire that does not exist.
      hasLiveConnection: false,
    };
  }
  return {
    streamsTurns: true,
    canListHistory: true,
    canResetSession: true,
    canPatchSessionDefaults: true,
    reasoningScope: "session",
    canAttachImages: true,
    canAttachDocuments: true,
    maxAttachmentsPerTurn: MAX_ATTACHMENTS.openclaw,
    // Follows the credential here too, for the same reason it does on Hermes:
    // `/setup-api/chat/transcribe` resolves the token with `resolveClawaiToken`
    // and answers 503 "not linked" without one, and that route is
    // edition-neutral. Hardcoding `true` put a microphone on an OpenClaw box
    // whose owner never linked ClawBox AI, where every recording was uploaded,
    // refused, and thrown away.
    canTranscribe: facts.hasClawaiToken,
    // Honest on OpenClaw too: pictures are generated through the ClawBox AI
    // credential, and a box whose owner never linked one cannot make them.
    canGenerateImages: facts.hasClawaiToken,
    canSpeakReplies: true,
    canAbortTurn: true,
    hasLiveConnection: true,
  };
}

/** The facts to assume before the box has answered: the cautious ones. */
export const UNKNOWN_FACTS: HarnessFacts = {
  hasClawaiToken: false,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  // Cautious in the same direction as the rest: a composer that has not heard
  // back yet waits for the whole turn rather than showing a caret that may
  // never move.
  hermesStreamsTurns: false,
  hermesAgentDrawsImages: false,
};

/**
 * May the chat push a sticky reasoning default right now?
 *
 * Three things have to hold, and only one of them is about the harness:
 *
 * 1. the harness has sticky session defaults at all (`canPatchSessionDefaults`);
 * 2. the transport is up, so the call can actually be delivered;
 * 3. there is a session key to name.
 *
 * (1) is checked outright and first. Without it the call is delivered nowhere
 * on Hermes and can only reject with "Not connected". Today that never happens,
 * but only by accident — nothing assigns a gateway session key on the Hermes
 * path, so the `!key` guard swallows it. That is a side effect, not a rule, and
 * the first change that seeds a key from anywhere would quietly start firing
 * patches at a socket that does not exist.
 */
export function shouldPatchSessionDefaults(input: {
  capabilities: Pick<HarnessCapabilities, "canPatchSessionDefaults">;
  // `HarnessStatus`, not `string`: a plain string accepts any literal, so a
  // typo compiles and silently makes this always answer false.
  status: HarnessStatus;
  sessionKey: string;
}): boolean {
  if (!input.capabilities.canPatchSessionDefaults) return false;
  if (input.status !== "connected") return false;
  return input.sessionKey.length > 0;
}
