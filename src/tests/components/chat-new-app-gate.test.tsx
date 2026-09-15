// The chat's + button (Create App) while the Coding Agent's setup is
// unfinished.
//
// The card composes a message that asks the assistant to DELEGATE a build,
// and until the owner has been through the Coding Agent's wizard (or while
// its switch is off) that delegation is refused — so the press used to open
// a form whose only outcome was a refusal. It lands on the Coding Agent app
// now, in a plain window, where the wizard is the first thing on screen. A
// status the box cannot read still opens the card: never a dead button. And
// the Coding Agent's OWN hand-off (its home's Create, a project's Plan) is
// not gated here, because that app already sits behind its wizard.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { installHermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { OPEN_APP_EVENT, openNewAppCard, type OpenAppDetail } from "@/lib/ui-events";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run; every
// suite that mounts it declares both ceilings (`test-timeout-hygiene.test.ts`).
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

/** How the status route answers; anything else falls through to the Hermes box's stub. */
type StatusAnswer = () => unknown;

/** Answer `/setup-api/coding-agent/status` on top of the box's stub and count the reads. */
function answerCodingStatus(answer: StatusAnswer): { reads: () => number } {
  const inner = globalThis.fetch;
  let reads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/setup-api/coding-agent/status")) {
        reads += 1;
        return answer();
      }
      return inner(input as RequestInfo, init);
    }),
  );
  return { reads: () => reads };
}

const ok = (payload: unknown) => ({ ok: true, json: async () => payload });

/** Every app the desktop was asked to open while the test ran. */
function watchOpens(): OpenAppDetail[] {
  const opened: OpenAppDetail[] = [];
  const onOpen = (e: Event) => opened.push((e as CustomEvent<OpenAppDetail>).detail);
  window.addEventListener(OPEN_APP_EVENT, onOpen);
  listeners.push(() => window.removeEventListener(OPEN_APP_EVENT, onOpen));
  return opened;
}
const listeners: Array<() => void> = [];

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  installHermesBox();
});

afterEach(() => {
  for (const off of listeners.splice(0)) off();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("the chat's Create App button and the Coding Agent's setup", () => {
  it("opens the Coding Agent app, not the card, while setup is unfinished", async () => {
    answerCodingStatus(() => ok({ enabled: true, setupComplete: false, maxTaskChars: 4000 }));
    const opened = watchOpens();
    render(<ChatPopup isOpen onClose={() => {}} />);
    const toggle = await screen.findByTestId("chat-new-app-toggle");

    fireEvent.click(toggle);

    // A plain window: the owner lands on the wizard in the size and place
    // the app already has, not thrown to full screen.
    await waitFor(() => expect(opened).toEqual([{ appId: "coding" }]));
    expect(screen.queryByTestId("chat-new-app")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("opens the Coding Agent app while the feature's switch is off, even with setup done", async () => {
    answerCodingStatus(() => ok({ enabled: false, setupComplete: true }));
    const opened = watchOpens();
    render(<ChatPopup isOpen onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("chat-new-app-toggle"));

    await waitFor(() => expect(opened).toEqual([{ appId: "coding" }]));
    expect(screen.queryByTestId("chat-new-app")).toBeNull();
  });

  it("opens the card once setup is complete, exactly as before", async () => {
    const status = answerCodingStatus(() => ok({ enabled: true, setupComplete: true, maxTaskChars: 4000 }));
    const opened = watchOpens();
    render(<ChatPopup isOpen onClose={() => {}} />);
    const toggle = await screen.findByTestId("chat-new-app-toggle");

    fireEvent.click(toggle);

    await screen.findByTestId("chat-new-app");
    expect(opened).toEqual([]);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(status.reads()).toBe(1);
  });

  it("opens the card when the status cannot be read: a refused route", async () => {
    answerCodingStatus(() => ({ ok: false, status: 500, json: async () => ({ error: "Status check failed" }) }));
    const opened = watchOpens();
    render(<ChatPopup isOpen onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("chat-new-app-toggle"));

    await screen.findByTestId("chat-new-app");
    expect(opened).toEqual([]);
  });

  it("opens the card when the status cannot be read: a fetch that throws", async () => {
    answerCodingStatus(() => { throw new Error("offline"); });
    const opened = watchOpens();
    render(<ChatPopup isOpen onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("chat-new-app-toggle"));

    await screen.findByTestId("chat-new-app");
    expect(opened).toEqual([]);
  });

  it("opens the card on a status that predates the field: only an explicit false is a refusal", async () => {
    answerCodingStatus(() => ok({ maxTaskChars: 4000 }));
    const opened = watchOpens();
    render(<ChatPopup isOpen onClose={() => {}} />);
    fireEvent.click(await screen.findByTestId("chat-new-app-toggle"));

    await screen.findByTestId("chat-new-app");
    expect(opened).toEqual([]);
  });

  it("asks again on the next press, so a wizard finished in the other window counts without a reload", async () => {
    let setupComplete = false;
    const status = answerCodingStatus(() => ok({ enabled: true, setupComplete }));
    const opened = watchOpens();
    render(<ChatPopup isOpen onClose={() => {}} />);
    const toggle = await screen.findByTestId("chat-new-app-toggle");

    fireEvent.click(toggle);
    await waitFor(() => expect(opened).toEqual([{ appId: "coding" }]));

    setupComplete = true;
    fireEvent.click(toggle);
    await screen.findByTestId("chat-new-app");
    expect(opened).toEqual([{ appId: "coding" }]);
    expect(status.reads()).toBe(2);
  });

  it("costs one status read for a double press and leaves the card open", async () => {
    let release: (() => void) | null = null;
    const status = answerCodingStatus(
      () => new Promise((resolve) => { release = () => resolve(ok({ enabled: true, setupComplete: true })); }),
    );
    render(<ChatPopup isOpen onClose={() => {}} />);
    const toggle = await screen.findByTestId("chat-new-app-toggle");

    fireEvent.click(toggle);
    fireEvent.click(toggle);
    await waitFor(() => expect(release).not.toBeNull());
    release!();

    await screen.findByTestId("chat-new-app");
    expect(status.reads()).toBe(1);
    // Still open: the second press was neither a second open nor a close.
    expect(screen.getByTestId("chat-new-app")).toBeTruthy();
  });

  it("closes the open card on a press without asking the box anything", async () => {
    const status = answerCodingStatus(() => ok({ enabled: true, setupComplete: true }));
    render(<ChatPopup isOpen onClose={() => {}} />);
    const toggle = await screen.findByTestId("chat-new-app-toggle");
    fireEvent.click(toggle);
    await screen.findByTestId("chat-new-app");

    fireEvent.click(toggle);

    await waitFor(() => expect(screen.queryByTestId("chat-new-app")).toBeNull());
    expect(status.reads()).toBe(1);
  });

  it("leaves the Coding Agent's own hand-off ungated: that app already sits behind its wizard", async () => {
    answerCodingStatus(() => ok({ enabled: true, setupComplete: false }));
    const opened = watchOpens();
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findByTestId("chat-new-app-toggle");

    openNewAppCard({ project: "/home/clawbox/Projects/shop" });

    await screen.findByTestId("chat-new-app");
    expect(opened).toEqual([]);
  });
});
