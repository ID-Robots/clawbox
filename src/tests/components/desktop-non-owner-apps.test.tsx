import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";

// Multi-user ClawBox OS (TASK-1256). The owner's store-installed apps — skills
// and web apps — are the owner's: a second ClawBox user's desktop must not
// offer them in the icon grid, the launcher or the shelf, whatever the box
// answers (the server refuses the preference read for a non-owner anyway; this
// pins the desktop's own rule, which getAllApps once skipped).

vi.mock("@/components/Mascot", () => ({ default: () => null }));
vi.mock("@/components/ChatPopup", () => ({
  default: () => null,
  CHAT_PANEL_GAP: 12,
  noticeColumnInset: () => 0,
}));

// Mounts the whole desktop shell per case — see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const APP_NAME = "Weather Now";
let me: unknown = {};

function answer(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/users/me")) return answer(me);
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) return answer({ active: "openclaw", edition: "openclaw", activeKnown: true });
    if (url.includes("/setup-api/preferences?all=1")) {
      return answer({
        installed_apps: ["weather"],
        installed_meta: { weather: { name: APP_NAME, color: "#0ea5e9", webappUrl: "/setup-api/webapps?app=weather" } },
      });
    }
    return answer({});
  }));
}

async function openLauncher() {
  fireEvent.click((await screen.findAllByTestId("shelf-launcher-button"))[0]);
}

describe("the desktop's installed apps — owner only", () => {
  beforeEach(() => {
    resetHarnessCache();
    _resetSessionUserForTest();
    installFetch();
    // The launcher asks matchMedia on its focus timer; the setup file's mock
    // loses its implementation to `mockReset` between cases.
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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers the owner their installed app (so the case below means something)", async () => {
    me = { username: "clawbox", isOwner: true, multiUser: true };
    render(<ChromeDesktop />);
    expect((await screen.findAllByText(APP_NAME)).length).toBeGreaterThan(0);
    await openLauncher();
    await new Promise((r) => setTimeout(r, 150));
    expect((await screen.findAllByText(APP_NAME)).length).toBeGreaterThan(0);
  });

  it("offers a second ClawBox user none of them — not on the desktop, not in the launcher", async () => {
    me = { username: "alice", isOwner: false, multiUser: true };
    render(<ChromeDesktop />);
    // The shelf names a non-owner only once /users/me has answered, and the
    // preference load — the installed app in it — was asked for before that.
    expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("/setup-api/preferences?all=1"))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryAllByText(APP_NAME)).toHaveLength(0);

    await openLauncher();
    const launcher = await screen.findByTestId("app-launcher");
    // Past the launcher's 50 ms opening timer, so it settles inside this case.
    await new Promise((r) => setTimeout(r, 150));
    expect(screen.queryAllByText(APP_NAME)).toHaveLength(0);
    // What the launcher does offer is the Terminal.
    expect(launcher.textContent ?? "").toMatch(/terminal/i);
  });
});
