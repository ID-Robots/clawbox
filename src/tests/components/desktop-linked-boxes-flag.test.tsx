import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";

// The linked-box switcher on the desktop (Ctrl+Shift+1 … 9) is an experiment:
// off until the owner switches "Linked ClawBoxes (experimental)" on in
// Settings → System update → Advanced options (`pref:ui_linked_boxes`). Off,
// the desktop never asks for the list and leaves the keys alone.

vi.mock("@/components/Mascot", () => ({ default: () => null }));
vi.mock("@/components/ChatPopup", () => ({
  default: () => null,
  CHAT_PANEL_GAP: 12,
}));
vi.mock("@/components/TimezoneAdopter", () => ({ default: () => null }));

// Mounts the whole desktop shell per case — see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const OWNER = { username: "clawbox", isOwner: true, multiUser: false };
const FLAG_URL = "/setup-api/preferences?keys=ui_linked_boxes";
const LIST_URL = "/setup-api/linked-boxes";

/** What GET /setup-api/preferences?keys=ui_linked_boxes answers. */
let flag: unknown;

function answer(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// The desktop wraps `fetch` while it is mounted (src/lib/session-expiry.ts),
// so the stub is read through its own reference.
let fetchStub = vi.mocked(fetch);

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === FLAG_URL) return answer(flag === undefined ? {} : { ui_linked_boxes: flag });
    if (url === LIST_URL) return answer({ self: { name: "main" }, boxes: [], max: 8 });
    if (url.includes("/setup-api/users/me")) return answer(OWNER);
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) return answer({ active: "openclaw", edition: "openclaw", activeKnown: true });
    return answer({});
  }));
  fetchStub = vi.mocked(fetch);
}

const asked = (url: string) => fetchStub.mock.calls.some(([input]) => String(input) === url);
const press = (n: number) => fireEvent.keyDown(window, { code: `Digit${n}`, key: "!", ctrlKey: true, shiftKey: true });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  resetHarnessCache();
  _resetSessionUserForTest();
  flag = undefined;
  installFetch();
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
  // The preference writer's debounced flush, so it lands in this case.
  await wait(650);
  vi.unstubAllGlobals();
});

describe("the desktop's linked-box switcher", () => {
  it("is off by default: the list is never asked for and Ctrl+Shift+2 is left to the browser", async () => {
    render(<ChromeDesktop />);
    await waitFor(() => expect(asked(FLAG_URL)).toBe(true));
    await wait(200);
    expect(asked(LIST_URL)).toBe(false);
    expect(press(2)).toBe(true);
    expect(screen.queryByTestId("box-switcher-indicator")).toBeNull();
  });

  it("stays off when the switch is stored off", async () => {
    flag = false;
    render(<ChromeDesktop />);
    await waitFor(() => expect(asked(FLAG_URL)).toBe(true));
    await wait(200);
    expect(asked(LIST_URL)).toBe(false);
    expect(press(2)).toBe(true);
  });

  it("works as before once the switch is on: the list is read and Ctrl+Shift+2 is the switcher's", async () => {
    flag = true;
    render(<ChromeDesktop />);
    await waitFor(() => expect(asked(LIST_URL)).toBe(true));
    // Slot 2 is empty on this box, so the switcher says so and navigates nowhere.
    await waitFor(() => expect(press(2)).toBe(false));
    expect(await screen.findByTestId("box-switcher-indicator")).toHaveAttribute("data-kind", "empty");
  });
});
