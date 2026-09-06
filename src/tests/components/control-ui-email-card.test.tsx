// What the owner sees on the gateway's own Control UI chat after a reply that
// names his mail.
//
// The repro on the card: OpenClaw edition → the pinned OpenClaw icon → "read my
// last two emails" → the reply ends with bare `EMAIL:<id>` lines. Nothing in the
// harness can fix that without taking the card away from ClawBox's own two
// chats (one payload, one channel, three clients — see
// `src/lib/control-ui-email-directives.ts`), so ClawBox does it in the page it
// already serves and already injects into.
//
// The script is run here EXACTLY as it ships — the same string
// `serveGatewayHTML` puts in the element — against a DOM shaped like a rendered
// transcript. Asserting on a TypeScript twin of it would pin nothing.

import { describe, expect, it, beforeEach } from "vitest";

import { controlUiEmailDirectiveScriptBody } from "@/lib/control-ui-email-directives";

/**
 * Evaluate the shipped program with its three dependencies passed in by name.
 *
 * `new Function` over a module constant, not over anything a request can reach:
 * the point is to run the string the browser runs. Naming `document` and
 * `MutationObserver` as parameters also states, and enforces, the whole of what
 * the script is allowed to touch.
 */
function installScript(): void {
  const run = new Function(
    "document",
    "MutationObserver",
    controlUiEmailDirectiveScriptBody(),
  ) as (doc: Document, observer: typeof MutationObserver) => void;
  run(document, MutationObserver);
}

function cards(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>("a.clawbox-email-card"));
}

/** One microtask turn, which is when a MutationObserver callback runs. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the Control UI chat and an EMAIL: directive", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("turns a directive already on the page into a card and leaves the prose", () => {
    document.body.innerHTML =
      '<div class="msg"><p>Jane sent the plan, and Accounts sent an invoice.\nEMAIL:4471\nEMAIL:4468</p></div>';

    installScript();

    expect(document.body.textContent).not.toContain("EMAIL:4471");
    expect(document.body.textContent).not.toContain("4468");
    expect(document.body.textContent).toContain("Jane sent the plan, and Accounts sent an invoice.");
    expect(cards().map((a) => a.getAttribute("href"))).toEqual([
      "/app/clawbox?email=4471",
      "/app/clawbox?email=4468",
    ]);
    expect(cards()[0].textContent).toBe("Open full message");
  });

  it("turns a directive that arrives later into a card", async () => {
    installScript();

    const bubble = document.createElement("p");
    bubble.textContent = "Here it is.\nEMAIL:4471";
    document.body.appendChild(bubble);
    await settle();

    expect(document.body.textContent).not.toContain("EMAIL:");
    expect(cards()).toHaveLength(1);
  });

  it("does not draw the same message twice when the turn is seen again", async () => {
    // The false-success guard. Both ClawBox chats and this page can be open on
    // the same turn, and a streaming UI re-renders the same bubble many times:
    // the card must be the reply's, not the pass's.
    document.body.innerHTML = "<p>Done.\nEMAIL:4471</p>";

    installScript();
    // A second pass over the same DOM, and a third the observer runs itself.
    installScript();
    document.body.appendChild(document.createElement("span"));
    await settle();

    expect(cards()).toHaveLength(1);
  });

  it("leaves a reply that EXPLAINS the syntax alone", () => {
    document.body.innerHTML =
      "<p>End the reply with</p><pre><code>EMAIL:4471</code></pre>";

    installScript();

    expect(document.body.textContent).toContain("EMAIL:4471");
    expect(cards()).toHaveLength(0);
  });

  it("leaves what the owner is still typing alone", async () => {
    document.body.innerHTML = '<textarea>EMAIL:4471</textarea>';

    installScript();
    await settle();

    expect(document.querySelector("textarea")?.textContent).toBe("EMAIL:4471");
    expect(cards()).toHaveLength(0);
  });

  it("leaves the page's own chrome alone", () => {
    // The accepted cost of reading a whole page rather than a transcript: a
    // line that is exactly `Email: 12345` is a directive by this grammar
    // wherever it appears. Chrome is where such a line plausibly lives.
    document.body.innerHTML =
      "<table><tr><th>Email: 12345</th></tr></table><label>Email: 99</label>";

    installScript();

    expect(document.body.textContent).toContain("Email: 12345");
    expect(document.body.textContent).toContain("Email: 99");
    expect(cards()).toHaveLength(0);
  });

  it("keeps a directive that names no usable id as text", () => {
    document.body.innerHTML = "<p>Done.\nEMAIL:abc</p>";

    installScript();

    expect(document.body.textContent).toContain("EMAIL:abc");
    expect(cards()).toHaveLength(0);
  });
});
