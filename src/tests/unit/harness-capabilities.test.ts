import { describe, expect, it } from "vitest";
import {
  capabilitiesFor,
  shouldPatchSessionDefaults,
  UNKNOWN_FACTS,
  type HarnessFacts,
} from "@/lib/harness/capabilities";

/**
 * The capability table is the whole contract between "what this box can do"
 * and "what the chat offers". These tests pin the two rules that matter:
 *
 *  - a capability that depends on a CREDENTIAL must follow the credential, not
 *    the edition, or a Hermes box with ClawBox AI linked keeps a microphone
 *    hidden that would work;
 *  - a capability that is genuinely absent must stay false on every fact
 *    combination, or a button appears that promises something impossible.
 */

const linked: HarnessFacts = {
  hasClawaiToken: true,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  hermesStreamsTurns: false,
  hermesAgentDrawsImages: false,
};
const bare: HarnessFacts = {
  hasClawaiToken: false,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  hermesStreamsTurns: false,
  hermesAgentDrawsImages: false,
};
/** The box the attach button is honest on: the flag AND somewhere to look. */
const seeing: HarnessFacts = {
  hasClawaiToken: true,
  hermesSupportsImages: true,
  hermesHasVisionRoute: true,
  hermesStreamsTurns: false,
  hermesAgentDrawsImages: false,
};
/** A linked box whose agent has an image backend selected — it can draw. */
const drawing: HarnessFacts = {
  hasClawaiToken: true,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
  hermesStreamsTurns: false,
  hermesAgentDrawsImages: true,
};

describe("capabilitiesFor", () => {
  it("follows the credential, not the edition, for transcription", () => {
    expect(capabilitiesFor("hermes", linked).canTranscribe).toBe(true);
    expect(capabilitiesFor("hermes", bare).canTranscribe).toBe(false);
    // And the same on OpenClaw, which is the half this used to get wrong. The
    // route behind the microphone resolves the same credential on both
    // editions and answers 503 without one, so a bare OpenClaw box that showed
    // the button was promising something the box could not do.
    expect(capabilitiesFor("openclaw", linked).canTranscribe).toBe(true);
    expect(capabilitiesFor("openclaw", bare).canTranscribe).toBe(false);
  });

  it("answers transcription and image generation alike where both exist", () => {
    // On OpenClaw both features are reached through the one ClawBox AI
    // credential, so no fact combination may separate them. The asymmetry this
    // replaces is what let the microphone be offered where pictures were not.
    for (const facts of [linked, bare]) {
      const caps = capabilitiesFor("openclaw", facts);
      expect(caps.canTranscribe).toBe(caps.canGenerateImages);
    }
    // Hermes is deliberately NOT symmetrical, and for a reason that is not the
    // credential: linking installs the image backend, but that write is
    // fail-soft, so a box can hold the token and still have nothing to draw
    // with. The microphone follows the token; drawing follows the config.
    expect(capabilitiesFor("hermes", linked).canTranscribe).toBe(true);
    expect(capabilitiesFor("hermes", linked).canGenerateImages).toBe(false);
    expect(capabilitiesFor("hermes", drawing).canGenerateImages).toBe(true);
  });

  it("reports image generation from the credential where there is a tool to spend it on", () => {
    // OpenClaw: the agent has its own image tool, so the only open question is
    // whether the box can pay for a picture.
    expect(capabilitiesFor("openclaw", linked).canGenerateImages).toBe(true);
    expect(capabilitiesFor("openclaw", bare).canGenerateImages).toBe(false);
  });

  it("promises pictures on Hermes only once the agent has a backend to reach for", () => {
    // The config, not the credential, and the difference is a real box: a
    // device linked through a path that could not install the backend holds a
    // perfectly good token and cannot draw. Reading the token there would put a
    // promise in front of a customer that the next request cannot keep.
    expect(capabilitiesFor("hermes", drawing).canGenerateImages).toBe(true);
    expect(capabilitiesFor("hermes", linked).canGenerateImages).toBe(false);
    expect(capabilitiesFor("hermes", bare).canGenerateImages).toBe(false);
  });

  it("assumes a box cannot draw until it has said otherwise", () => {
    // The cautious direction, like every other unknown fact: a wrong false
    // costs a capability nobody had yet, a wrong true costs an apology.
    expect(UNKNOWN_FACTS.hermesAgentDrawsImages).toBe(false);
    expect(capabilitiesFor("hermes", UNKNOWN_FACTS).canGenerateImages).toBe(false);
  });

  it("keeps genuinely absent things absent whatever the facts say", () => {
    for (const facts of [linked, bare, seeing]) {
      const caps = capabilitiesFor("hermes", facts);
      // TTS is a gateway capability with no Hermes equivalent.
      expect(caps.canSpeakReplies).toBe(false);
      // There is no socket, so there is nothing a connection banner could
      // honestly describe.
      expect(caps.hasLiveConnection).toBe(false);
      // `--image` is image-only and the agent's path resolver matches picture
      // extensions by design; a document has no way in.
      expect(caps.canAttachDocuments).toBe(false);
    }
  });

  it("claims streaming only where the box was found able to do it", () => {
    // Both fact sets above have `hermesStreamsTurns: false` — a box with no
    // reachable dashboard, which is every box that has to spawn `chat -q` for
    // each turn and therefore cannot produce a token until the child exits.
    expect(capabilitiesFor("hermes", bare).streamsTurns).toBe(false);
    expect(capabilitiesFor("hermes", seeing).streamsTurns).toBe(false);
    // And the box that can: the claim follows the probe, nothing else. Not the
    // credential, not the image flags — a linked box with no dashboard running
    // still cannot stream, and an unlinked one with a dashboard still can.
    expect(capabilitiesFor("hermes", { ...bare, hermesStreamsTurns: true , hermesAgentDrawsImages: false}).streamsTurns).toBe(true);
    expect(capabilitiesFor("hermes", { ...seeing, hermesStreamsTurns: true , hermesAgentDrawsImages: false}).streamsTurns).toBe(true);
  });

  it("keeps the connection banner honest even when turns stream", () => {
    // `hasLiveConnection` is not "something arrives progressively" — it is
    // "there is a socket that can be DOWN, so a banner about it is honest".
    // Hermes' stream is opened per turn by the route and gone by the time the
    // answer lands; there is no connection for the surface to report on, and
    // three things read this flag: the queue-while-disconnected branch, the
    // replay-on-mount effect, and the transcript route's own ownership gate.
    expect(capabilitiesFor("hermes", { ...seeing, hermesStreamsTurns: true , hermesAgentDrawsImages: false}).hasLiveConnection).toBe(
      false,
    );
    // The transcript stays ours to serve, which is what that gate turns on.
    expect(capabilitiesFor("hermes", { ...seeing, hermesStreamsTurns: true , hermesAgentDrawsImages: false}).canListHistory).toBe(true);
  });

  it("never hides the attach button on the strength of a guess", () => {
    expect(capabilitiesFor("hermes", bare).canAttachImages).toBe(false);
    expect(capabilitiesFor("hermes", seeing).canAttachImages).toBe(true);
  });

  it("needs somewhere to LOOK at a picture, not just a turn that carries one", () => {
    // The bug this pins: on an unlinked box `hermes chat --image` exists, so the
    // flag probe said yes and the attach button appeared — but nothing had
    // `auxiliary.vision` configured, so `image_routing.py` had no
    // `vision_analyze` route to fall back to. The file reached the agent and
    // the model, with no way to see it, reached for a tool that was not there
    // and finally hand-wrote pixel-scanning code to answer at all.
    expect(
      capabilitiesFor("hermes", {
        hasClawaiToken: false,
        hermesSupportsImages: true,
        hermesHasVisionRoute: false,
        hermesStreamsTurns: false, hermesAgentDrawsImages: false
      }).canAttachImages,
    ).toBe(false);
    // And the mirror: a vision route on an agent whose turn cannot carry the
    // file is just as useless.
    expect(
      capabilitiesFor("hermes", {
        hasClawaiToken: true,
        hermesSupportsImages: false,
        hermesHasVisionRoute: true,
        hermesStreamsTurns: false, hermesAgentDrawsImages: false
      }).canAttachImages,
    ).toBe(false);
  });

  it("reads the vision route rather than the credential that usually writes it", () => {
    // `applyClawaiToHermes` is what normally writes `auxiliary.vision`, which
    // makes the token tempting as a proxy for it. It is the wrong fact both
    // ways: `hasClawaiToken` also resolves OpenClaw's store, so a dual box
    // linked through the OpenClaw path holds the credential with no Hermes
    // vision keys — and a customer can point `auxiliary.vision` at their own
    // provider with no ClawBox AI credential at all.
    expect(
      capabilitiesFor("hermes", {
        hasClawaiToken: true,
        hermesSupportsImages: true,
        hermesHasVisionRoute: false,
        hermesStreamsTurns: false, hermesAgentDrawsImages: false
      }).canAttachImages,
    ).toBe(false);
    expect(
      capabilitiesFor("hermes", {
        hasClawaiToken: false,
        hermesSupportsImages: true,
        hermesHasVisionRoute: true,
        hermesStreamsTurns: false, hermesAgentDrawsImages: false
      }).canAttachImages,
    ).toBe(true);
  });

  it("records Hermes reasoning as per-turn rather than as absent", () => {
    const caps = capabilitiesFor("hermes", linked);
    // The distinction is the point: Hermes HAS a reasoning dial, carried by the
    // turn. Recording it as "no reasoning" would hide a working control.
    expect(caps.canPatchSessionDefaults).toBe(false);
    expect(caps.reasoningScope).toBe("per-turn");
    expect(capabilitiesFor("openclaw", linked).reasoningScope).toBe("session");
  });

  it("says a new chat really resets on both editions", () => {
    expect(capabilitiesFor("openclaw", bare).canResetSession).toBe(true);
    expect(capabilitiesFor("hermes", bare).canResetSession).toBe(true);
    expect(capabilitiesFor("openclaw", bare).canAbortTurn).toBe(true);
    expect(capabilitiesFor("hermes", bare).canAbortTurn).toBe(true);
  });

  it("assumes nothing before the box has answered", () => {
    expect(UNKNOWN_FACTS.hasClawaiToken).toBe(false);
    expect(UNKNOWN_FACTS.hermesSupportsImages).toBe(false);
    expect(UNKNOWN_FACTS.hermesHasVisionRoute).toBe(false);
    // A composer that has not heard back yet must not show a caret it may never
    // be able to move.
    expect(UNKNOWN_FACTS.hermesStreamsTurns).toBe(false);
    expect(capabilitiesFor("hermes", UNKNOWN_FACTS).streamsTurns).toBe(false);
  });
});

describe("shouldPatchSessionDefaults", () => {
  const openclaw = capabilitiesFor("openclaw", bare);
  const hermes = capabilitiesFor("hermes", bare);

  it("refuses on a harness with no sticky defaults, even when everything else looks right", () => {
    // The key is what saves this today, and only by accident: nothing seeds a
    // gateway session key on the Hermes path. A change that seeded one from
    // anywhere would start firing patches at a socket that does not exist.
    expect(
      shouldPatchSessionDefaults({
        capabilities: hermes,
        status: "connected",
        sessionKey: "agent:main:main",
      }),
    ).toBe(false);
  });

  it("waits for the transport and for a session to name", () => {
    expect(
      shouldPatchSessionDefaults({ capabilities: openclaw, status: "connecting", sessionKey: "k" }),
    ).toBe(false);
    expect(
      shouldPatchSessionDefaults({ capabilities: openclaw, status: "connected", sessionKey: "" }),
    ).toBe(false);
    expect(
      shouldPatchSessionDefaults({ capabilities: openclaw, status: "connected", sessionKey: "k" }),
    ).toBe(true);
  });
});
