import type { HarnessCapabilities, HarnessId } from "./transport";

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
      // The Hermes chat route runs `hermes chat -q … -Q` and reads the whole
      // answer off the child's stdout. Streaming is a future upgrade.
      streamsTurns: false,
      canListHistory: HERMES_DURABLE_TRANSCRIPT,
      // Forgetting the resumed session id IS the reset: the next turn goes out
      // with no `--resume`, so the box opens a fresh session. Every bit as real
      // a reset as the gateway's, and the only one Hermes can have.
      canResetSession: true,
      // `sessions.patch` is a gateway call. There is no session on the box to
      // patch — see `reasoningScope` for what Hermes has instead.
      canPatchSessionDefaults: false,
      reasoningScope: "per-turn",
      canAttachImages: facts.hermesSupportsImages,
      // `--image` is image-only, and the agent's own path-in-prompt resolver
      // matches picture extensions by design. A document has no way in.
      canAttachDocuments: false,
      maxAttachmentsPerTurn: MAX_ATTACHMENTS.hermes,
      // The transcription route is edition-neutral — it posts to the ClawBox
      // AI proxy, which both editions can reach. What a Hermes box may lack is
      // the credential, so that is exactly what this asks about.
      canTranscribe: facts.hasClawaiToken,
      // FALSE, and not because of the credential.
      //
      // On OpenClaw a picture is made by the AGENT reaching for its own image
      // tool — the user just asks. That tool is a bundled OpenClaw plugin
      // configured through `agents.defaults.imageGenerationModel`, and Hermes
      // has no such plugin and no image-generation provider slot to put one in.
      // So there is nothing on this edition that a request for a picture could
      // reach, and a `true` here computed from the token would be describing a
      // credential rather than an ability.
      //
      // The credential is genuinely not the blocker: the ClawBox AI proxy
      // serves `POST /images/generations` (`gpt-image-1-mini`, on every plan)
      // with the same device token `canTranscribe` above reads. What is missing
      // is a TRIGGER — the Hermes agent needs a tool it can call, the way the
      // OpenClaw agent has one — and the enablement plan is in the PR. Until
      // that lands this stays false, because a composer that offered to draw
      // and then could not would be the same lie the microphone used to tell.
      canGenerateImages: false,
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
    canTranscribe: true,
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
  status: string;
  sessionKey: string;
}): boolean {
  if (!input.capabilities.canPatchSessionDefaults) return false;
  if (input.status !== "connected") return false;
  return input.sessionKey.length > 0;
}
