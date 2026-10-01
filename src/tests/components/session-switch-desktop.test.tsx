/**
 * The desktop on a session switch (TASK-1247).
 *
 * A desktop open in one tab while another tab picked a 12-hour session (or
 * signed in as someone else, or signed out) kept the previous session's
 * windows, role and Terminal sockets on screen — its requests already carried
 * the new cookie — until it was reloaded by hand. It now reopens at "/" on the
 * session that holds, the moment it hears of it, or when Back brings it out of
 * the back-forward cache after one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { SESSION_SWITCH_EVENT } from "@/lib/session-switch";
import {
  announceFromAnotherTab,
  channelTick,
  firePageShow,
  fireVisibility,
  installFakeBroadcastChannel,
  stubLocation,
  type StubbedLocation,
} from "@/tests/helpers/session-switch";

vi.mock("@/components/Mascot", () => ({ default: () => null }));
vi.mock("@/components/ChatPopup", () => ({
  default: () => null,
  CHAT_PANEL_GAP: 12,
  noticeColumnInset: () => 0,
}));
vi.mock("@/components/TimezoneAdopter", () => ({ default: () => null }));

// Mounts the whole desktop shell per case — see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

function answer(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

let location: StubbedLocation | undefined;

beforeEach(() => {
  resetHarnessCache();
  _resetSessionUserForTest();
  window.localStorage.clear();
  installFakeBroadcastChannel();
  fireVisibility("visible");
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/users/me")) return answer({ username: "clawbox", isOwner: true, multiUser: true });
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) return answer({ active: "openclaw", edition: "openclaw", activeKnown: true });
    return answer({});
  }));
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(async () => {
  // The owner's desktop leaves debounced preference writes behind; let them
  // land here rather than in the next case's fetch mock.
  await new Promise((resolve) => setTimeout(resolve, 650));
  location?.restore();
  location = undefined;
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});

async function openDesktop(path = "/") {
  location = stubLocation(path);
  render(<ChromeDesktop />);
  expect((await screen.findAllByTestId("shelf-launcher-button")).length).toBeGreaterThan(0);
  return location;
}

describe("the desktop — another tab switches the session", () => {
  it("reopens at / on the new session when another tab signs in", async () => {
    const loc = await openDesktop();
    const leaving = vi.fn();
    window.addEventListener(SESSION_SWITCH_EVENT, leaving);
    try {
      announceFromAnotherTab("login", "channel");
      await act(async () => { await channelTick(); });
      expect(loc.replace).toHaveBeenCalledTimes(1);
      expect(loc.replace).toHaveBeenCalledWith("/");
      // Its Terminal windows were told to drop their sockets first.
      expect(leaving).toHaveBeenCalledTimes(1);
      expect(loc.assign).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(SESSION_SWITCH_EVENT, leaving);
    }
  });

  it("follows a sign-out the same way, in a browser without BroadcastChannel", async () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const loc = await openDesktop();
    act(() => { announceFromAnotherTab("logout", "storage"); });
    expect(loc.replace).toHaveBeenCalledWith("/");
  });

  it("does not carry the previous session's one-time notice into the new one", async () => {
    const loc = await openDesktop("/?notice=owner-only");
    act(() => { announceFromAnotherTab("login", "storage"); });
    expect(loc.replace).toHaveBeenCalledWith("/");
  });

  it("stays put for storage traffic that is not a session switch", async () => {
    const loc = await openDesktop();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "clawbox-custom-wallpapers", newValue: "[]" }));
    });
    await act(async () => { await channelTick(); });
    expect(loc.replace).not.toHaveBeenCalled();
  });
});

describe("the desktop — Back, Forward and background tabs", () => {
  it("brought back from the back-forward cache after a switch, it reopens on the new session", async () => {
    const loc = await openDesktop();
    announceFromAnotherTab("login", "none");
    act(() => { firePageShow(true); });
    expect(loc.replace).toHaveBeenCalledWith("/");
  });

  it("brought back with no switch since, it is left as it was", async () => {
    const loc = await openDesktop();
    act(() => { firePageShow(true); });
    expect(loc.replace).not.toHaveBeenCalled();
  });

  it("shown again after missing the switch in the background, it catches up", async () => {
    const loc = await openDesktop();
    fireVisibility("hidden");
    announceFromAnotherTab("login", "none");
    expect(loc.replace).not.toHaveBeenCalled();
    act(() => { fireVisibility("visible"); });
    expect(loc.replace).toHaveBeenCalledWith("/");
  });
});
