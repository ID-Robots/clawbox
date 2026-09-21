// What the owner sees on the gateway's own Control UI chat after a reply that
// names his mail.
//
// The repro on the card: OpenClaw edition → the pinned OpenClaw icon → "read my
// last two emails" → the reply ends with bare `EMAIL:<id>` lines. Nothing in the
// harness can fix that without taking the card away from ClawBox's own two
// chats (one payload, one delivery, three clients — see
// `src/lib/control-ui-email-directives.ts`), so ClawBox does it in the page it
// already serves and already injects into.
//
// The script is run here EXACTLY as it ships — the same string
// `serveGatewayHTML` puts in the element — against a DOM shaped like a rendered
// transcript. Asserting on a TypeScript twin of it would pin nothing.
//
// It installs ONCE per document and every later `installScript()` is the no-op
// the page would get from a second injection, which is also what the "seen
// again" case below asserts. jsdom hands the whole file one document, so a
// script that installed per call would leave one live observer per test and
// they would draw over each other's work — the same way two copies on a real
// page would. The label's ten locales are pinned in the unit suite, where
// asserting them does not need a second install.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { controlUiEmailDirectiveScriptBody } from "@/lib/control-ui-email-directives";

/**
 * The production settle is half a second; these tests use the same clock,
 * shorter, and ADVANCED BY HAND.
 *
 * The streaming case mutates the node every `SWEEP_MS` and asserts that nothing
 * has been converted yet, so the margin between the two is what the test is
 * actually made of — and on a real clock a scheduler stall longer than
 * `SETTLE_MS` between the mutation and the assertion would let the sweep
 * convert `EMAIL:44` and fail for the machine's reason rather than the code's.
 * Fake timers take the machine out of it: `Date.now()`, which is what the
 * script measures quiet with, moves exactly as far as each `advanceTimersBy`
 * says and no further.
 */
const SETTLE_MS = 150;
const SWEEP_MS = 10;

/**
 * Evaluate the shipped program with its two dependencies passed in by name.
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
    controlUiEmailDirectiveScriptBody({ settleMs: SETTLE_MS, sweepMs: SWEEP_MS }),
  ) as (doc: Document, observer: typeof MutationObserver) => void;
  run(document, MutationObserver);
}

function cards(): HTMLAnchorElement[] {
  return Array.from(document.querySelectorAll<HTMLAnchorElement>("a.clawbox-email-card"));
}

function uids(): string[] {
  return cards().map((a) => a.getAttribute("data-clawbox-email-uid") ?? "");
}

/**
 * Long enough for the text to have held still and for one sweep to have run.
 *
 * The whole point of the settle is that nothing is converted while the text is
 * still arriving, so every assertion here has to wait for quiet — a
 * `queueMicrotask` would see the DOM exactly as it was.
 */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(SETTLE_MS + SWEEP_MS * 4);
}

describe("the Control UI chat and an EMAIL: directive", () => {
  beforeEach(() => {
    // The clock the settle is measured against, driven by hand: the sweep and
    // the assertions must not race a loaded runner's scheduler.
    vi.useFakeTimers();
    document.body.innerHTML = "";
    document.getElementById("clawbox-email-card-style")?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns a directive already on the page into a card and leaves the prose", async () => {
    document.body.innerHTML =
      '<div class="msg"><p>Jane sent the plan, and Accounts sent an invoice.\nEMAIL:4471\nEMAIL:4468</p></div>';

    installScript();
    await settle();

    expect(document.body.textContent).not.toContain("EMAIL:4471");
    expect(document.body.textContent).not.toContain("4468");
    expect(document.body.textContent).toContain("Jane sent the plan, and Accounts sent an invoice.");
    expect(cards().map((a) => a.getAttribute("href"))).toEqual([
      "/app/clawbox?email=4471",
      "/app/clawbox?email=4468",
    ]);
    expect(cards()[0].textContent).toBe("Open full message");
    // One tab for all of them, and a name a screen reader can tell apart.
    expect(cards()[0].getAttribute("target")).toBe("clawbox-chat");
    expect(cards()[0].getAttribute("aria-label")).toBe("Open full message #4471");
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

  it("never draws a card for a uid that was still being typed", async () => {
    // The one that matters. A reply STREAMS, so the node holding it reads
    // `EMAIL:4`, `EMAIL:44`, `EMAIL:447`, `EMAIL:4471` in turn — every one a
    // usable id by this grammar. Converting on sight draws a card for message
    // 4, then 44, then 447; and a turn interrupted between two digits leaves
    // the wrong one on screen with no `EMAIL:` text left to show it is wrong.
    installScript();
    const bubble = document.createElement("p");
    bubble.textContent = "Here it is.";
    document.body.appendChild(bubble);
    const node = bubble.firstChild as Text;

    for (const text of ["Here it is.\nEMAIL:4", "Here it is.\nEMAIL:44", "Here it is.\nEMAIL:447"]) {
      node.data = text;
      await vi.advanceTimersByTimeAsync(SWEEP_MS);
      expect(cards()).toHaveLength(0);
    }
    node.data = "Here it is.\nEMAIL:4471";
    await settle();

    expect(uids()).toEqual(["4471"]);
  });

  it("caps the cards under one reply where the chat window caps them", async () => {
    // The chat window shows 25 and leaves the rest as text. Without a marker on
    // the text a rewrite puts BACK, the observer sees its own work and converts
    // the remainder 25 at a time until none is left.
    const lines = Array.from({ length: 30 }, (_, i) => `EMAIL:${i + 1}`).join("\n");
    document.body.innerHTML = `<p>Thirty.\n${lines}</p>`;

    installScript();
    await settle();
    await settle();

    expect(cards()).toHaveLength(25);
    expect(document.body.textContent).toContain("EMAIL:26");
    expect(document.body.textContent).toContain("EMAIL:30");
  });

  it("counts one reply once even when the page renders a line per node", async () => {
    // The page puts each directive on its own line — that IS the bug report —
    // so a dedupe scoped to one text node sees each of them alone and the same
    // message gets two identical cards.
    document.body.innerHTML =
      "<p>Two of them.<br>EMAIL:7<br>EMAIL:7<br>EMAIL:8</p>";

    installScript();
    await settle();

    expect(uids()).toEqual(["7", "8"]);
  });

  it("counts one reply once even when its lines settle in different sweeps", async () => {
    // One reply's text nodes do not have to hold still together: a directive
    // that arrives a second after its neighbour settles in a later sweep. A
    // budget carried only for the length of one sweep would give it a fresh
    // count and a fresh "already seen" set, and the same message would get a
    // second card.
    document.body.innerHTML = "<p>Two of them.<br>EMAIL:7</p>";
    installScript();
    await settle();
    expect(uids()).toEqual(["7"]);

    document.querySelector("p")?.appendChild(document.createTextNode("EMAIL:7"));
    await settle();

    expect(uids()).toEqual(["7"]);
  });

  it("does not weld two words together when the directive follows inline markup", async () => {
    // The parser trims because in the other three copies its input is a whole
    // reply; here it is one fragment sitting beside a <b>.
    document.body.innerHTML = "<p><b>Jane</b> sent the plan.\nEMAIL:4471</p>";

    installScript();
    await settle();

    expect(document.querySelector("p")?.textContent).toContain("Jane sent the plan.");
    expect(cards()).toHaveLength(1);
  });

  it("does not draw the same message twice when the turn is seen again", async () => {
    // Both ClawBox chats and this page can be open on the same turn, and a
    // streaming UI re-renders one bubble many times: the card must be the
    // reply's, not the pass's.
    document.body.innerHTML = "<p>Done.\nEMAIL:4471</p>";

    installScript();
    installScript();
    document.body.appendChild(document.createElement("span"));
    await settle();
    await settle();

    expect(cards()).toHaveLength(1);
  });

  it("leaves a reply that EXPLAINS the syntax alone", async () => {
    document.body.innerHTML =
      "<p>End the reply with</p><pre><code>EMAIL:4471</code></pre>";

    installScript();
    await settle();

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

  it("leaves the page's own chrome alone", async () => {
    // The accepted cost of reading a whole page rather than a transcript: a
    // line that is exactly `Email: 12345` is a directive by this grammar
    // wherever it appears. Chrome is where such a line plausibly lives.
    document.body.innerHTML = [
      "<table><tr><th>Email: 12345</th><td>Email: 12346</td></tr></table>",
      "<label>Email: 99</label>",
      "<dl><dt>Email: 98</dt><dd>Email: 97</dd></dl>",
      '<a href="/x">Email: 96</a>',
    ].join("");

    installScript();
    await settle();

    for (const id of ["12345", "12346", "99", "98", "97", "96"]) {
      expect(document.body.textContent).toContain(`Email: ${id}`);
    }
    expect(cards()).toHaveLength(0);
  });

  it("keeps a directive that names no usable id as text", async () => {
    document.body.innerHTML = "<p>Done.\nEMAIL:abc</p>";

    installScript();
    await settle();

    expect(document.body.textContent).toContain("EMAIL:abc");
    expect(cards()).toHaveLength(0);
  });

});
