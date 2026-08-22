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

const linked: HarnessFacts = { hasClawaiToken: true, hermesSupportsImages: false };
const bare: HarnessFacts = { hasClawaiToken: false, hermesSupportsImages: false };

describe("capabilitiesFor", () => {
  it("follows the credential, not the edition, for transcription", () => {
    expect(capabilitiesFor("hermes", linked).canTranscribe).toBe(true);
    expect(capabilitiesFor("hermes", bare).canTranscribe).toBe(false);
    // OpenClaw's microphone has always been shown and stays shown: the route
    // behind it resolves the same credential either way.
    expect(capabilitiesFor("openclaw", bare).canTranscribe).toBe(true);
  });

  it("reports image generation from the credential on BOTH editions", () => {
    expect(capabilitiesFor("openclaw", linked).canGenerateImages).toBe(true);
    expect(capabilitiesFor("openclaw", bare).canGenerateImages).toBe(false);
    expect(capabilitiesFor("hermes", linked).canGenerateImages).toBe(true);
    expect(capabilitiesFor("hermes", bare).canGenerateImages).toBe(false);
  });

  it("keeps genuinely absent things absent whatever the facts say", () => {
    for (const facts of [linked, bare, { hasClawaiToken: true, hermesSupportsImages: true }]) {
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
    expect(
      capabilitiesFor("hermes", { hasClawaiToken: false, hermesSupportsImages: true })
        .canAttachImages,
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
