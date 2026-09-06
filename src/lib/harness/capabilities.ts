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
   * The ClawBox AI proxy is up and serving image generation for the model this
   * box would ask for.
   *
   * PROBED, and the SECOND half of the composer path's "can this box draw" --
   * `hasClawaiToken` above is the first. Two facts because they have two causes
   * and two failure stories: an unlinked box has no credential to spend, while
   * a linked box on a dead uplink has a credential and nowhere to spend it.
   * Either one alone makes the button dead, so the capability wants both.
   *
   * They cannot be collapsed the other way round either: the proxy's discovery
   * endpoint is UNAUTHENTICATED, so it answers "is there an image service" and
   * says nothing whatever about whether this device's token still works. The
   * one exception is a token the proxy has ALREADY named as invalid on a real
   * generation — `clawaiImageRouteReachable` reports false for that, because by
   * then it is a measured fact rather than a guess. See that function.
   */
  hasClawaiImageRoute: boolean;
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
  /**
   * This box is configured to speak (`tts.provider` in `~/.hermes/config.yaml`
   * names one of the two providers ClawBox offers).
   *
   * PROBED, like its neighbours, and about the box rather than the version:
   * the Voice tab writes that key, so two boxes running the same `hermes` can
   * disagree. Hermes' factory value is `edge`, which ClawBox never offers and
   * never counts — see hermes-tts.ts for why a ClawBox must not speak through
   * it by default.
   */
  hermesSpeaksReplies: boolean;
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
      // The chat's provider and model are `model.provider` / `model.default` in
      // ~/.hermes/config.yaml — the harness's own store, served by
      // /setup-api/hermes/models. `agents.defaults.model.primary` is not this
      // box's answer even on the dual SKU, where the OpenClaw half keeps it
      // warm for the edition that is not running.
      modelStore: "harness",
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
      // Two ways to draw, and this block wires BOTH. The agent path: the
      // box's agent has an image backend selected (`hermesAgentDrawsImages`,
      // read from `image_gen.provider`), so a customer asks for a picture in
      // plain words and the agent draws it — the same shape as OpenClaw. The
      // composer path: no backend yet, but a credential to spend
      // (`hasClawaiToken`) AND somewhere to spend it (`hasClawaiImageRoute`,
      // probed against the proxy's own discovery endpoint, and false while the
      // proxy has named this device's credential invalid) put a picture button
      // in the composer instead.
      //
      // This was FALSE outright until these two paths landed. On OpenClaw a
      // picture is made by the AGENT reaching for its own image tool — the
      // user just asks — and that tool is a bundled plugin configured through
      // `agents.defaults.imageGenerationModel`. On Hermes the equivalent slot
      // EXISTS (`image_gen.provider`, served by plugins discovered from
      // `~/.hermes/plugins/image_gen/`) and shipped EMPTY. Linking ClawBox AI
      // now installs a backend into that slot, and where the slot is still
      // empty the box itself can be the caller through the composer button
      // (see `clawai-images.ts`). Either path is a real ability; either alone
      // makes this true.
      canGenerateImages:
        facts.hermesAgentDrawsImages ||
        (facts.hasClawaiToken && facts.hasClawaiImageRoute),
      // WHO draws. `'agent'` the moment the agent has a backend — the button
      // disappears and asking in plain words works, exactly the transition the
      // composer path promised. `'composer'` only while the slot is empty and
      // the box would be the caller. Computed from the same facts as the flag
      // above so the two can never disagree — a `'composer'` beside a false
      // `canGenerateImages` would be a button over a route this box cannot
      // reach.
      //
      imageGenerationTrigger: facts.hermesAgentDrawsImages
        ? "agent"
        : facts.hasClawaiToken && facts.hasClawaiImageRoute
          ? "composer"
          : null,
      // Voice OUTPUT, and note it is a different feature from voice INPUT
      // (`canTranscribe` above) with a different answer — reading one as the
      // other is how a working microphone got hidden behind a card saying
      // "voice is an OpenClaw feature".
      //
      // This said `false` with the comment "a gateway capability with no
      // Hermes equivalent". That was never true of the harness: Hermes ships
      // its own `tts:` block, a `text_to_speech` toolset (which this repo's
      // own local-model-profile.ts already lists) and `POST /api/audio/speak`.
      // What was true is that ClawBox had not wired any of it up. So the flag
      // follows the box's ACTUAL speech config now, the same way
      // `hermesAgentDrawsImages` follows its image backend.
      canSpeakReplies: facts.hermesSpeaksReplies,
      // WHO speaks it. Hermes has no gateway to append an audio part on its
      // own, so the ClawBox chat route asks Hermes to speak the finished reply
      // and attaches the clip in the same shape the gateway produces — which
      // is why the renderer needed no edition of its own.
      spokenReplyTrigger: facts.hermesSpeaksReplies ? "box" : null,
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
    //
    // NOT gated on `hasClawaiImageRoute`, unlike Hermes, and the asymmetry is
    // real rather than an oversight. Here the picture comes from the AGENT'S
    // image provider, which is only ours by default: `ai-models/configure`
    // leaves `agents.defaults.imageGenerationModel` alone when it already names
    // one, so a customer who pointed it at their own provider draws pictures
    // that never touch the ClawBox AI proxy. Probing our route and answering
    // false would hide a button that works — the "wrong false" this table
    // spends most of its comments avoiding.
    canGenerateImages: facts.hasClawaiToken,
    // The customer just asks and the agent's own tool answers, so there is
    // nothing for the composer to render. See the type's own note: this is the
    // flag that keeps `generateImage` honest about rejecting here.
    imageGenerationTrigger: facts.hasClawaiToken ? "agent" : null,
    canSpeakReplies: true,
    // The gateway speaks the reply itself and pushes it as a second message
    // carrying the audio; nothing here has to ask for it.
    spokenReplyTrigger: "harness",
    canAbortTurn: true,
    hasLiveConnection: true,
    modelStore: "openclaw-config",
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
  // And no picture button until the box has said there is somewhere to send a
  // prompt. A button that appears and then vanishes when the facts land is
  // worse than one that appears a beat late.
  hasClawaiImageRoute: false,
  hermesAgentDrawsImages: false,
  // And no player promised until the box has said it has a voice configured.
  hermesSpeaksReplies: false,
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
