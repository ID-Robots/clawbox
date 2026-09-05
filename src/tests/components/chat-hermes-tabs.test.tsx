import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
import {
  GENERATED_IMAGE_PATH,
  HERMES_SESSION,
  installHermesBox,
  mountHermesChat,
  type HermesBox,
} from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";
import type { ReactNode } from "react";

// The labels asserted below ("Chat 2", "Close tab") come from the real
// tables; the provider loads them through a dynamic import that never settles
// under jsdom, which is why it is mocked here exactly as chat-tabs.test.tsx does.
vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({
      t: (key: string, params?: Record<string, string | number>) => {
        let str = translations.en[key] ?? key;
        for (const [k, v] of Object.entries(params ?? {})) str = str.replaceAll(`{${k}}`, String(v));
        return str;
      },
    }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * The (+) on a box that runs no gateway.
 *
 * On OpenClaw the + opens a TAB: a second conversation with the same agent,
 * beside the first, which stays exactly as it was. On Hermes the same button
 * reset the one conversation in place — transcript deleted, agent told to
 * forget — and the owner asked for the two editions to behave the same.
 * Nothing in Hermes stands in the way: `hermes chat -q` threads any number of
 * sessions by id, and the transcript store is keyed by filename. So this pins
 * the OpenClaw contract (chat-tabs.test.tsx) on the Hermes surface:
 *
 *  - the + opens a tab on a fresh conversation; the first is neither cleared
 *    nor deleted, and nothing is sent on the owner's behalf;
 *  - a turn in the tab runs on ITS Hermes session and is recorded under ITS
 *    transcript, apart from main's;
 *  - switching back replays main's transcript and resumes main's session;
 *  - closing the tab deletes its transcript and returns to main;
 *  - the tab list and the open tab survive a remount.
 */

let box: HermesBox;
const DESKTOP = "desktop";
const TAB_KEY = /^desktop-[a-z0-9]{12}$/;
const TAB_SESSION = "20260901_120000_abc123";

const tabs = () => screen.getAllByTestId("chat-tab");
const tabKeys = () => tabs().map((el) => el.getAttribute("data-session-key"));
const activeTabKey = () =>
  tabs().find((el) => el.getAttribute("aria-selected") === "true")?.getAttribute("data-session-key");

async function sendTurn(text: string) {
  const textarea = screen.getByRole("textbox");
  const before = box.chatPosts.length;
  await waitFor(() => expect(textarea).not.toBeDisabled());
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
  await waitFor(() => expect(box.chatPosts.length).toBe(before + 1));
  await screen.findAllByText("hello back");
}

async function openNewTab(): Promise<string> {
  const plus = screen.getByTestId("chat-new-tab");
  await waitFor(() => expect(plus).not.toBeDisabled());
  fireEvent.click(plus);
  await waitFor(() => expect(tabs()).toHaveLength(2));
  const key = activeTabKey();
  expect(key).toMatch(TAB_KEY);
  return key as string;
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  box = installHermesBox();
  // Two conversations, two Hermes sessions — the box answers a different id
  // for a tab than for the desktop thread, so a turn resumed on the wrong one
  // is visible in the request rather than hidden behind one fixed id.
  box.sessionIdFor = (sessionKey) => (sessionKey === DESKTOP ? HERMES_SESSION : TAB_SESSION);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("the + on the Hermes edition", () => {
  it("opens a second conversation and leaves the first one intact", async () => {
    await mountHermesChat(box);
    await screen.findByText("Earlier in this chat.");
    await sendTurn("remember the number 41");

    const key = await openNewTab();
    expect(tabKeys()).toEqual([DESKTOP, key]);
    // The tab's own (empty) transcript was read, and the first conversation
    // is no longer on screen...
    await waitFor(() => expect(box.historyReads).toContain(key));
    expect(screen.queryByText("hello back")).toBeNull();
    expect(screen.queryByText("remember the number 41")).toBeNull();
    // ...but it was not DELETED, which is what the + used to do here, and no
    // turn went out on the owner's behalf (no greet, no reset).
    expect(box.transcriptDeletes).toBe(0);
    expect(box.chatPosts).toHaveLength(1);
    expect(box.socketsOpened).toBe(0);
    expect(screen.queryByText(/Could not start a new chat/)).toBeNull();
    // It has a placeholder name until the owner says something.
    expect(tabs()[1].textContent).toBe("Chat 2");
  });

  it("threads the tab's turns on their own session and transcript, apart from main's", async () => {
    await mountHermesChat(box);
    await sendTurn("remember the number 41");
    await sendTurn("what was the number?");
    expect(box.chatPosts[1].sessionId).toBe(HERMES_SESSION);

    const key = await openNewTab();
    await sendTurn("plan my week in Lisbon please");
    // A fresh conversation: nothing to resume, recorded under the tab's key.
    expect(box.chatPosts[2].sessionKey).toBe(key);
    expect(box.chatPosts[2]).not.toHaveProperty("sessionId");
    await sendTurn("and the weekend after");
    expect(box.chatPosts[3].sessionKey).toBe(key);
    expect(box.chatPosts[3].sessionId).toBe(TAB_SESSION);
    // Named after the first thing the owner said in it.
    expect(tabs()[1].textContent).toBe("plan my week in Lisbon p…");

    // Back to main. Its transcript — as the box recorded it — replays, and the
    // next turn resumes MAIN's session, not the tab's.
    box.storedTranscript = [
      ...box.storedTranscript,
      { role: "user", text: "remember the number 41", timestamp: 10 },
      { role: "assistant", text: "hello back", timestamp: 20 },
    ];
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));
    await screen.findByText("Earlier in this chat.");
    await screen.findByText("remember the number 41");
    expect(screen.queryByText("plan my week in Lisbon please")).toBeNull();
    await sendTurn("still 41?");
    expect(box.chatPosts[4].sessionKey).toBe(DESKTOP);
    expect(box.chatPosts[4].sessionId).toBe(HERMES_SESSION);
  });

  it("closing the tab deletes its transcript and returns to main", async () => {
    await mountHermesChat(box);
    const key = await openNewTab();
    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(tabKeys()).toEqual([DESKTOP]));
    expect(activeTabKey()).toBe(DESKTOP);
    await waitFor(() => expect(box.deletedKeys).toEqual([key]));
    // Main's transcript was never touched.
    await screen.findByText("Earlier in this chat.");
  });

  it("names the strip and sizes its controls for a real finger", async () => {
    // The accessible name goes through the same table every other string in
    // this strip does, and both icon buttons clear the WCAG 2.5.8 floor: they
    // sit beside a tab that is itself a target, so the spacing exception that
    // would excuse an 18px box does not apply here.
    await mountHermesChat(box);
    await openNewTab();
    screen.getByRole("tablist", { name: "Chats" });
    // Each control belongs to the tab the owner is on: close on a side tab,
    // restart on main.
    expect(screen.getByTestId("chat-tab-close")).toHaveStyle({ width: "24px", height: "24px" });
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));
    expect(screen.getByTestId("chat-tab-restart")).toHaveStyle({ width: "24px", height: "24px" });
  });

  it("is one tab stop, and the arrows move along it", async () => {
    await mountHermesChat(box);
    await openNewTab();
    // Roving: the strip costs the keyboard ONE stop on the way to the composer,
    // however many conversations are open.
    const [main, second] = tabs();
    expect(main).toHaveAttribute("tabindex", "-1");
    expect(second).toHaveAttribute("tabindex", "0");

    second.focus();
    fireEvent.keyDown(second, { key: "ArrowRight" });
    // Wraps, and moves FOCUS only: arriving on a tab must not spend a history
    // read on a conversation nobody asked to open.
    expect(document.activeElement).toBe(main);
    expect(activeTabKey()).not.toBe(DESKTOP);
    fireEvent.keyDown(main, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(second);
    // Enter is what opens one.
    main.focus();
    fireEvent.keyDown(main, { key: "Enter" });
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));
  });

  it("the tabs and the open one survive a remount", async () => {
    await mountHermesChat(box);
    const key = await openNewTab();
    cleanup();
    box.historyReads.length = 0;
    await mountHermesChat(box);
    expect(tabKeys()).toEqual([DESKTOP, key]);
    expect(activeTabKey()).toBe(key);
    // The open tab's transcript is what a reload reads, not main's.
    await waitFor(() => expect(box.historyReads[0]).toBe(key));
    // A restored empty tab is not a first conversation: no greet.
    expect(box.chatPosts).toHaveLength(0);
  });
});

describe("a run that lands while the owner is in another tab", () => {
  /** A turn the test releases by hand, so a tab switch can happen mid-run. */
  function heldTurn(): { release: (answer: unknown) => void } {
    let release!: (answer: unknown) => void;
    const held = new Promise((resolve) => { release = resolve; });
    box.chatResponse = () => held;
    return { release };
  }

  it("reports a failed turn once, not once per store that recorded it", async () => {
    // The stashed error line exists for the gateway, whose failures live only
    // in the browser. This box writes its own: the route appends an `Error:`
    // row to the transcript, so the replay on return already says it. Saying it
    // again is one failed turn, reported twice, in two different wordings.
    const { release } = heldTurn();
    await mountHermesChat(box);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "boom" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(box.chatPosts).toHaveLength(1));

    await openNewTab();
    // The box recorded the failure, as its route does, and answers 502.
    box.storedTranscript = [
      ...box.storedTranscript,
      { role: "user", text: "boom", timestamp: 30 },
      { role: "system", text: "Error: the agent gave up", timestamp: 31, variant: "error" },
    ];
    release({ ok: false, status: 502, json: async () => ({ error: "the agent gave up" }) });
    // The tab it failed in is marked for the owner's return, not painted over
    // the conversation they are reading now.
    await waitFor(() => expect(tabs()[0].querySelector('[data-testid="chat-tab-unread"]')).not.toBeNull());
    expect(screen.queryByText(/the agent gave up/)).toBeNull();

    fireEvent.click(tabs()[0]);
    await screen.findByText("Error: the agent gave up");
    // One failure, one line: the box's own, and not our second copy of it.
    expect(screen.getAllByText(/agent gave up/)).toHaveLength(1);
    expect(screen.queryByText(/Try sending it again/i)).toBeNull();
  });

  it("puts a picture in the conversation that asked for it", async () => {
    // A composer generation takes 15-40 seconds and the box records it under
    // the key that asked. The screen has to follow the same rule the turn path
    // does, or the picture lands in whichever tab happens to be open when it
    // arrives — and a refresh would then move it, which is worse than either.
    box.facts.hasClawaiToken = true;
    box.facts.hasClawaiImageRoute = true;
    let release!: (answer: { ok: boolean; status: number; payload: unknown }) => void;
    box.imageReply = () => {
      throw new Error("unused: the picture is released by hand below");
    };
    const held = new Promise<{ ok: boolean; status: number; payload: unknown }>((resolve) => { release = resolve; });
    // The helper calls `imageReply()` synchronously and awaits the payload, so
    // a pending payload is what keeps the generation in flight.
    box.imageReply = () => ({ ok: true, status: 200, payload: held.then((a) => a.payload) });
    await mountHermesChat(box);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "a red maple leaf" } });
    const draw = await screen.findByTestId("generate-image");
    await waitFor(() => expect(draw).not.toBeDisabled());
    fireEvent.click(draw);
    await waitFor(() => expect(box.imagePrompts).toEqual(["a red maple leaf"]));

    const key = await openNewTab();
    const mediaRef = `/setup-api/chat/media?path=${encodeURIComponent(GENERATED_IMAGE_PATH)}`;
    // The route records both halves under the conversation that asked.
    box.storedTranscript = [
      ...box.storedTranscript,
      { role: "user", text: "a red maple leaf", timestamp: 40 },
      { role: "assistant", text: "", timestamp: 41, images: [mediaRef] },
    ];
    release({ ok: true, status: 200, payload: { ok: true, media: [mediaRef] } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Not here: this tab never asked for a picture.
    expect(screen.queryByRole("img")).toBeNull();
    expect(box.tabTranscripts[key] ?? []).toHaveLength(0);

    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(screen.getByRole("img")).toHaveAttribute("src", mediaRef));
  });

  it("keeps painting a streamed reply after the owner leaves the tab and comes back", async () => {
    // The live-frame gates ask whether a frame belongs to the run this popup is
    // showing. Leaving a tab puts that run's id down; coming back has to pick it
    // up again, or the tab stops painting its own reply half-written.
    box.facts.hermesStreamsTurns = true;
    const encoder = new TextEncoder();
    // The reader hands out one chunk per `read()`, so the test paces the
    // stream: null the releaser, wait for the loop to arm a fresh one.
    let releaseChunk: ((chunk: string | null) => void) | null = null;
    const frame = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const push = async (chunk: string | null) => {
      await waitFor(() => expect(releaseChunk).not.toBeNull());
      const release = releaseChunk!;
      releaseChunk = null;
      release(chunk);
      await new Promise((r) => setTimeout(r, 0));
    };
    box.chatResponse = () => ({
      ok: true,
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === "content-type" ? "text/event-stream" : null) },
      body: {
        getReader: () => ({
          read: () => new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
            releaseChunk = (chunk) => chunk === null
              ? resolve({ done: true })
              : resolve({ done: false, value: encoder.encode(chunk) });
          }),
        }),
      },
    });
    await mountHermesChat(box);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "count slowly" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await push(frame("delta", { text: "one" }));
    await waitFor(() => expect(screen.getByText(/one/)).toBeTruthy());

    await openNewTab();
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));

    // Still the same run, still this tab's reply: the frames that arrive after
    // the owner comes back keep painting where they belong.
    await push(frame("delta", { text: " two" }));
    await waitFor(() => expect(screen.getByText(/one two/)).toBeTruthy());
    await push(frame("done", { text: "one two three", harness: "hermes", sessionId: HERMES_SESSION }));
    await push(null);
    await waitFor(() => expect(screen.getAllByText(/one two three/)).toHaveLength(1));
  });
});

describe("what a screen reader is told about a tab", () => {
  /** A turn the test releases by hand, so a tab can be left mid-run. */
  function heldTurn(): { release: (answer: unknown) => void } {
    let release!: (answer: unknown) => void;
    const held = new Promise((resolve) => { release = resolve; });
    box.chatResponse = () => held;
    return { release };
  }

  it("says which conversation is working and which is holding a new reply", async () => {
    // Both dots are aria-hidden decoration. Without the state in the name, a
    // conversation still answering, one holding an unread reply, and an idle
    // one are indistinguishable to anyone not looking at the colour.
    const { release } = heldTurn();
    await mountHermesChat(box);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "take your time" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(box.chatPosts).toHaveLength(1));

    await openNewTab();
    screen.getByRole("tab", { name: "ClawBox, working" });

    release({ ok: true, json: async () => ({ text: "done", sessionId: HERMES_SESSION }) });
    await screen.findByRole("tab", { name: "ClawBox, new reply" });

    // Read, and it goes back to being just a name.
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));
    screen.getByRole("tab", { name: "ClawBox" });
  });

  it("keeps a background tab's error for that tab when the owner switches again mid-read", async () => {
    // `switchSession` awaits the transcript read. A second switch during it
    // used to hand the leaving tab's error to whatever was on screen by then —
    // and lose it, because reading the entry also removes it.
    const { release } = heldTurn();
    await mountHermesChat(box);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "boom" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(box.chatPosts).toHaveLength(1));

    const second = await openNewTab();
    // It failed the way a request that never reached the route does: nothing is
    // recorded on the box, so the client-side line is the only account of it.
    release({ ok: false, status: 500, json: async () => ({ error: "nothing was written" }) });
    await waitFor(() => expect(tabs()[0].querySelector('[data-testid="chat-tab-unread"]')).not.toBeNull());

    // Head back to main, then change our mind while its transcript is loading.
    box.historyDelayMs[DESKTOP] = 40;
    fireEvent.click(tabs()[0]);
    fireEvent.click(tabs()[1]);
    await waitFor(() => expect(activeTabKey()).toBe(second));
    await new Promise((resolve) => setTimeout(resolve, 80));
    // Not spilled into the conversation the owner actually has open…
    expect(screen.queryByText(/nothing was written/i)).toBeNull();

    // …and not lost either: it is still waiting in the tab it belongs to.
    box.historyDelayMs = {};
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));
    await screen.findByText(/nothing was written/i);
  });
  it("keeps the composer's picture wait in the tab that asked for it", async () => {
    // The picture already lands in the right conversation; the WAIT did not.
    // `drawing` was one component-wide flag, so a generation started in main
    // put "Generating image…" over a second tab's transcript and greyed its
    // picture button — a control the owner can see is not disabled by anything
    // in the conversation they are looking at.
    box.facts.hasClawaiToken = true;
    box.facts.hasClawaiImageRoute = true;
    let release!: (answer: unknown) => void;
    const held = new Promise<unknown>((resolve) => { release = resolve; });
    box.imageReply = () => ({ ok: true, status: 200, payload: held });
    await mountHermesChat(box);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "a red maple leaf" } });
    const draw = await screen.findByTestId("generate-image");
    await waitFor(() => expect(draw).not.toBeDisabled());
    fireEvent.click(draw);
    await waitFor(() => expect(box.imagePrompts).toEqual(["a red maple leaf"]));
    await screen.findByText(translations.en["chat.generatingImage"]);

    await openNewTab();
    // This conversation asked for nothing and is not waiting for anything.
    expect(screen.queryByText(translations.en["chat.generatingImage"])).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "a blue whale" } });
    await waitFor(() => expect(screen.getByTestId("generate-image")).not.toBeDisabled());

    // Back where it was asked for, the wait is still on screen and the button
    // is still held — one generation per conversation, as before.
    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));
    await screen.findByText(translations.en["chat.generatingImage"]);
    expect(screen.getByTestId("generate-image")).toBeDisabled();

    release({ ok: true, media: [] });
    await waitFor(() =>
      expect(screen.queryByText(translations.en["chat.generatingImage"])).toBeNull());
  });

  it("names the transcript as the tab strip's panel", async () => {
    // The strip implements the ARIA tabs pattern — tablist, roving tabindex,
    // manual activation — with no `tabpanel` anywhere, so a screen reader was
    // told these were tabs and never what selecting one changed.
    await mountHermesChat(box);
    await openNewTab();

    const panel = screen.getByTestId("chat-transcript");
    expect(panel).toHaveAttribute("role", "tabpanel");
    for (const tab of tabs()) {
      expect(tab.getAttribute("aria-controls"), tab.getAttribute("data-session-key") ?? "")
        .toBe(panel.id);
      expect(tab.id).toBeTruthy();
    }
    // Labelled by whichever tab is selected, and it follows the selection.
    const selected = () => tabs().find((el) => el.getAttribute("aria-selected") === "true")!;
    expect(panel.getAttribute("aria-labelledby")).toBe(selected().id);

    fireEvent.click(tabs()[0]);
    await waitFor(() => expect(activeTabKey()).toBe(DESKTOP));
    expect(panel.getAttribute("aria-labelledby")).toBe(selected().id);
  });
});
