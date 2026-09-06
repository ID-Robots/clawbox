// The gateway's own Control UI chat is a THIRD `webchat` surface, and it showed
// `EMAIL:<uid>` as a bare internal id.
//
// ClawBox's two chats lift the directive out and draw an "open full message"
// card. The OpenClaw Control UI at `/chat` — a ClawBox-served, default-pinned
// app on that edition — is `webchat` too, and nothing the gateway hands an
// outbound hook separates the three: the hook sees one payload going to one
// channel, so a strip there would take the card away from the two surfaces that
// make one. That is why the harness cannot answer this and ClawBox's own
// injection into the page it already serves has to (TASK-700).
//
// This file pins the half that has to agree with everything else: the grammar
// the injected script carries is the SAME grammar, case for case, as the three
// implementations `email-directive-parity.test.ts` already holds together.

import { describe, expect, it } from "vitest";
import vm from "node:vm";

import { splitEmailRefs, parseEmailUid } from "@/lib/chat-email-refs";
import {
  CONTROL_UI_DIRECTIVE_PARSER_JS,
  controlUiEmailHref,
  controlUiEmailDirectiveScript,
} from "@/lib/control-ui-email-directives";
import { EMAIL_DIRECTIVE_CASES } from "@/tests/fixtures/email-directive-cases";

interface BrowserSplit {
  (raw: string): { text: string; uids: number[] };
}

/**
 * The parser the browser gets, evaluated exactly as the browser evaluates it.
 *
 * Asserting on a TypeScript copy of the rule would prove nothing about the
 * string that actually ships inside the `<script>`; this runs THAT string.
 */
function browserSplit(): BrowserSplit {
  return vm.runInNewContext(
    `${CONTROL_UI_DIRECTIVE_PARSER_JS}\nsplitEmailRefs;`,
  ) as BrowserSplit;
}

describe("the Control UI's copy of the EMAIL: grammar", () => {
  it("answers every shared case the way the chat window does", () => {
    const split = browserSplit();
    for (const testCase of EMAIL_DIRECTIVE_CASES) {
      expect(split(testCase.input).text, testCase.name).toBe(testCase.stripped);
      expect(split(testCase.input).uids, testCase.name).toEqual(
        splitEmailRefs(testCase.input).uids,
      );
    }
  });

  it("caps the cards under one reply where the chat window caps them", () => {
    // 30 directives, cap 25: the last five go back to being text on BOTH sides.
    const raw = Array.from({ length: 30 }, (_, i) => `EMAIL:${i + 1}`).join("\n");
    const split = browserSplit();
    expect(split(raw).uids).toEqual(splitEmailRefs(raw).uids);
    expect(split(raw).text).toBe(splitEmailRefs(raw).text);
  });
});

describe("the link a Control UI card opens", () => {
  it("points at the chat that already renders the message", () => {
    expect(controlUiEmailHref(4471)).toBe("/app/clawbox?email=4471");
  });

  it("reads back through the same uid rule the directive uses", () => {
    expect(parseEmailUid("4471")).toBe(4471);
    expect(parseEmailUid("0")).toBeNull();
    expect(parseEmailUid("4294967296")).toBeNull();
    expect(parseEmailUid("4x")).toBeNull();
  });
});

describe("the script that is injected into the page ClawBox already serves", () => {
  it("carries the parser and no closing tag that could end the element early", () => {
    const script = controlUiEmailDirectiveScript();
    expect(script).toContain(CONTROL_UI_DIRECTIVE_PARSER_JS);
    // `</script>` anywhere inside would close the injected element at that
    // point and spill the rest of the program into the document as text.
    expect(script.slice("<script>".length, -"</script>".length)).not.toMatch(/<\/script/i);
  });
});
