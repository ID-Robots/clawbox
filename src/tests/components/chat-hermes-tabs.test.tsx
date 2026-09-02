import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
import {
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
