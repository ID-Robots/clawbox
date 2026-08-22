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
};
const bare: HarnessFacts = {
  hasClawaiToken: false,
  hermesSupportsImages: false,
  hermesHasVisionRoute: false,
};
/** The box the attach button is honest on: the flag AND somewhere to look. */
const seeing: HarnessFacts = {
  hasClawaiToken: true,
  hermesSupportsImages: true,
  hermesHasVisionRoute: true,
};

describe("capabilitiesFor", () => {
  it("follows the credential, not the edition, for transcription", () => {
    expect(capabilitiesFor("hermes", linked).canTranscribe).toBe(true);
    expect(capabilitiesFor("hermes", bare).canTranscribe).toBe(false);
    // OpenClaw's microphone has always been shown and stays shown: the route
    // behind it resolves the same credential either way.
    expect(capabilitiesFor("openclaw", bare).canTranscribe).toBe(true);
  });

  it("reports image generation from the credential where there is a tool to spend it on", () => {
    // OpenClaw: the agent has its own image tool, so the only open question is
    // whether the box can pay for a picture.
    expect(capabilitiesFor("openclaw", linked).canGenerateImages).toBe(true);
    expect(capabilitiesFor("openclaw", bare).canGenerateImages).toBe(false);
  });

  it("does not promise pictures on a harness with nothing to ask for one", () => {
    // Hermes has no image-generation plugin and no provider slot for one, so
    // there is nothing a request for a picture could reach. A credential does
    // not change that, and computing this from the token would report an
    // ability the box does not have — the same shape of lie the microphone
    // used to tell in the other direction.
    expect(capabilitiesFor("hermes", linked).canGenerateImages).toBe(false);
    expect(capabilitiesFor("hermes", bare).canGenerateImages).toBe(false);
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
      expect(caps.streamsTurns).toBe(false);
    }
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
      }).canAttachImages,
    ).toBe(false);
    // And the mirror: a vision route on an agent whose turn cannot carry the
    // file is just as useless.
    expect(
      capabilitiesFor("hermes", {
        hasClawaiToken: true,
        hermesSupportsImages: false,
        hermesHasVisionRoute: true,
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
      }).canAttachImages,
    ).toBe(false);
    expect(
      capabilitiesFor("hermes", {
        hasClawaiToken: false,
        hermesSupportsImages: true,
        hermesHasVisionRoute: true,
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
