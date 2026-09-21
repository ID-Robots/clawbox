// The gateway's own Control UI chat is a THIRD `webchat` surface, and it showed
// `EMAIL:<uid>` as a bare internal id.
//
// ClawBox's two chats lift the directive out and draw an "open full message"
// card. The OpenClaw Control UI at `/chat` — a ClawBox-served, default-pinned
// app on that edition — is `webchat` too, and nothing the gateway hands an
// outbound hook separates it from the two: the hook sees one payload for one
// delivery, so a strip there would take the card away from the surfaces that
// make one. That is why the harness cannot answer this and ClawBox's own
// injection into the page it already serves has to (TASK-700).
//
// The grammar's own parity — the shared case table AND both generated sweeps —
// lives with the other three copies in `email-directive-parity.test.ts`. This
// file pins what is only true of the fourth: the shape of the thing that ships.

import { describe, expect, it } from "vitest";

import { parseEmailUid } from "@/lib/chat-email-refs";
import {
  CONTROL_UI_EMAIL_PARAM,
  CONTROL_UI_SETTLE_MS,
  CONTROL_UI_SWEEP_MS,
  controlUiCardLabel,
  controlUiEmailDirectiveScript,
  controlUiEmailDirectiveScriptBody,
  controlUiEmailHref,
} from "@/lib/control-ui-email-directives";

describe("the link a Control UI card opens", () => {
  it("points at the chat that already renders the message", () => {
    expect(controlUiEmailHref(4471)).toBe("/app/clawbox?email=4471");
  });

  it("is the same link the shipped script builds", () => {
    // One shape, one place. The helper is what `ChatApp` is tested against and
    // what the script's prefix is derived from, so they cannot drift.
    const prefix = controlUiEmailHref(1).slice(0, -1);
    expect(controlUiEmailDirectiveScriptBody()).toContain(JSON.stringify(prefix));
    expect(prefix.endsWith(`${CONTROL_UI_EMAIL_PARAM}=`)).toBe(true);
  });

  it("reads back through the same uid rule the directive uses", () => {
    expect(parseEmailUid("4471")).toBe(4471);
    expect(parseEmailUid("0")).toBeNull();
    expect(parseEmailUid("4294967296")).toBeNull();
    expect(parseEmailUid("4x")).toBeNull();
  });
});

describe("the script that is injected into the page ClawBox already serves", () => {
  it("carries no closing tag that could end the element early", () => {
    const script = controlUiEmailDirectiveScript();
    // `</script>` anywhere inside would close the injected element at that
    // point and spill the rest of the program into the document as text.
    expect(script.slice("<script>".length, -"</script>".length)).not.toMatch(/<\/script/i);
  });

  it("waits for the text to hold still before it draws anything", () => {
    // The production numbers, asserted where a reviewer can see them: a reply
    // streams, and every prefix of `EMAIL:4471` is a usable id, so converting
    // on sight draws cards for messages 4, 44 and 447 on the way.
    expect(CONTROL_UI_SETTLE_MS).toBeGreaterThanOrEqual(250);
    expect(CONTROL_UI_SWEEP_MS).toBeLessThanOrEqual(CONTROL_UI_SETTLE_MS);
    expect(controlUiEmailDirectiveScriptBody()).toContain(`var SETTLE_MS = ${CONTROL_UI_SETTLE_MS};`);
    expect(controlUiEmailDirectiveScriptBody()).toContain(`var SWEEP_MS = ${CONTROL_UI_SWEEP_MS};`);
  });

  it("says it in the owner's language, escaped for a script element", () => {
    expect(controlUiCardLabel("bg")).toBe("Отвори цялото писмо");
    expect(controlUiCardLabel("xx")).toBe("Open full message");
    expect(controlUiCardLabel(undefined)).toBe("Open full message");
    expect(controlUiEmailDirectiveScript("bg")).toContain(JSON.stringify("Отвори цялото писмо"));
  });
});
