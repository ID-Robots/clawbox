import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { nonOwnerVerdict } from "@/lib/non-owner-scope";
import { UPDATE_LOCK_HEADER, UPDATING_PAGE } from "@/lib/update-constants";

// Multi-user ClawBox OS (TASK-1256). The owner's store-installed apps — skills
// and web apps — are the owner's: a second ClawBox user's desktop must not
// offer them in the icon grid, the launcher or the shelf, whatever the box
// answers. And it must not ASK for them, or for anything else the server only
// refuses a non-owner: the lab1 hardware test counted ~15 owner-only requests
// (each a 403, several on a poll) from a non-owner's desktop on load.

// The widgets that fetch on mount are counted rather than rendered, so a case
// can tell "mounted and quiet" from "never mounted".
const mounted = vi.hoisted(() => ({ chat: 0, mascot: 0, timezone: 0 }));
vi.mock("@/components/Mascot", () => ({ default: () => { mounted.mascot++; return null; } }));
vi.mock("@/components/ChatPopup", () => ({
  default: () => { mounted.chat++; return null; },
  CHAT_PANEL_GAP: 12,
  noticeColumnInset: () => 0,
}));
vi.mock("@/components/TimezoneAdopter", () => ({ default: () => { mounted.timezone++; return null; } }));

// Mounts the whole desktop shell per case — see test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const APP_NAME = "Weather Now";
const OWNER = { username: "clawbox", isOwner: true, multiUser: true };
const ALICE = { username: "alice", isOwner: false, multiUser: true };
let me: unknown = {};
let updateLocked = false;

function answer(body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/users/me")) return answer(me, updateLocked ? { [UPDATE_LOCK_HEADER]: "1" } : {});
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

/** Every request the desktop has made so far, as `METHOD path?query`. */
function requests(): { method: string; url: URL; label: string }[] {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => {
    const url = new URL(String(input), "http://clawbox.local");
    const method = (init?.method ?? "GET").toUpperCase();
    return { method, url, label: `${method} ${url.pathname}${url.search}` };
  });
}

function asked(fragment: string): boolean {
  return requests().some((r) => r.label.includes(fragment));
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An owner's desktop leaves debounced writes behind — client-kv's 500 ms
 * flush (a MODULE-level timer, so it outlives the render) and the preference
 * writer's. Let them land in the case that caused them, or they fire into the
 * next case's fetch mock and read as that desktop's requests.
 */
const drainOwnerWrites = () => wait(650);

async function openLauncher() {
  fireEvent.click((await screen.findAllByTestId("shelf-launcher-button"))[0]);
}

beforeEach(() => {
  resetHarnessCache();
  _resetSessionUserForTest();
  mounted.chat = 0;
  mounted.mascot = 0;
  mounted.timezone = 0;
  updateLocked = false;
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
  window.history.replaceState(null, "", "/");
});

describe("the desktop's installed apps — owner only", () => {
  it("offers the owner their installed app (so the case below means something)", async () => {
    me = OWNER;
    render(<ChromeDesktop />);
    expect((await screen.findAllByText(APP_NAME)).length).toBeGreaterThan(0);
    await openLauncher();
    await wait(150);
    expect((await screen.findAllByText(APP_NAME)).length).toBeGreaterThan(0);
    await drainOwnerWrites();
  });

  it("offers a second ClawBox user none of them — not on the desktop, not in the launcher", async () => {
    me = ALICE;
    render(<ChromeDesktop />);
    expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
    await wait(50);
    expect(screen.queryAllByText(APP_NAME)).toHaveLength(0);

    await openLauncher();
    const launcher = await screen.findByTestId("app-launcher");
    // Past the launcher's 50 ms opening timer, so it settles inside this case.
    await wait(150);
    expect(screen.queryAllByText(APP_NAME)).toHaveLength(0);
    // What the launcher does offer is the Terminal.
    expect(launcher.textContent ?? "").toMatch(/terminal/i);
  });
});

describe("the desktop's requests — only what the signed-in user may ask", () => {
  it("a second ClawBox user's desktop sends nothing the server would refuse them", async () => {
    me = ALICE;
    render(<ChromeDesktop />);
    expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
    // Past the preference writer's 500 ms debounce, so a write it would have
    // sent is on the record too.
    await wait(700);

    // Judged by the very table the middleware answers with, so this cannot
    // pass while the desktop asks for something the server would 403.
    const refused = requests().filter(({ method, url }) =>
      nonOwnerVerdict({ pathname: url.pathname, method, searchParams: url.searchParams, intent: "fetch" }) !== "allow");
    expect(refused.map((r) => r.label)).toEqual([]);

    // The ones the lab saw, by name.
    for (const fragment of [
      "/setup-api/preferences?all=1",
      "POST /setup-api/preferences",
      "/setup-api/kv",
      "/setup-api/harness/active",
      "/setup-api/update/versions",
      "/setup-api/telegram/pairing",
      "/setup-api/whats-new",
      "/setup-api/ai-models/status",
      "/setup-api/clawkeep",
      "/setup-api/system/power/approval",
      "/setup-api/system/timezone",
      "/setup-api/chat/capabilities",
      "/setup-api/gateway/ws-config",
    ]) {
      expect(asked(fragment), fragment).toBe(false);
    }
    // The assistant, the mascot and the timezone adopter are not mounted at all.
    expect(mounted.chat).toBe(0);
    expect(mounted.mascot).toBe(0);
    expect(mounted.timezone).toBe(0);
  });

  it("the owner's desktop still asks for all of it", async () => {
    me = OWNER;
    render(<ChromeDesktop />);
    await waitFor(() => {
      for (const fragment of [
        "GET /setup-api/preferences?all=1",
        "GET /setup-api/kv",
        "/setup-api/harness/active",
        "/setup-api/update/versions",
        "/setup-api/telegram/pairing?poll=1",
        "/setup-api/whats-new",
        "/setup-api/ai-models/status",
        "/setup-api/clawkeep",
        "/setup-api/system/power/approval",
      ]) {
        expect(asked(fragment), fragment).toBe(true);
      }
    });
    expect(mounted.chat).toBeGreaterThan(0);
    expect(mounted.mascot).toBeGreaterThan(0);
    expect(mounted.timezone).toBeGreaterThan(0);
    await drainOwnerWrites();
  });

  it("a desktop that cannot learn who is signed in behaves as the owner's always did", async () => {
    me = {};
    render(<ChromeDesktop />);
    await waitFor(() => expect(asked("GET /setup-api/preferences?all=1")).toBe(true));
    await waitFor(() => expect(asked("/setup-api/update/versions")).toBe(true));
    await drainOwnerWrites();
  });

  it("a second ClawBox user's desktop still follows an update to the updating page", async () => {
    me = ALICE;
    const saved = Object.getOwnPropertyDescriptor(window, "location");
    const real = window.location;
    const replace = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: real.href,
        origin: real.origin,
        protocol: real.protocol,
        host: real.host,
        hostname: real.hostname,
        port: real.port,
        pathname: real.pathname,
        search: real.search,
        hash: real.hash,
        assign: vi.fn(),
        reload: vi.fn(),
        replace,
        toString: () => real.href,
      },
    });
    try {
      render(<ChromeDesktop />);
      expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
      updateLocked = true;
      // The desktop's 2 s poll: /users/me for a non-owner, which the
      // middleware stamps with the update lock like any /setup-api answer.
      await waitFor(() => expect(replace).toHaveBeenCalledWith(UPDATING_PAGE), { timeout: 6_000 });
      expect(asked("/setup-api/kv")).toBe(false);
    } finally {
      if (saved) Object.defineProperty(window, "location", saved);
    }
  });
});

describe("the owner-only notice", () => {
  it("tells a non-owner sent back from an owner page why, once, and clears it from the address", async () => {
    me = ALICE;
    window.history.replaceState(null, "", "/?notice=owner-only");
    render(<ChromeDesktop />);
    expect(await screen.findByText(/Only the box owner can open that page/)).toBeInTheDocument();
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/");
  });

  it("says nothing on an ordinary load", async () => {
    me = ALICE;
    render(<ChromeDesktop />);
    expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
    await wait(100);
    expect(screen.queryByText(/Only the box owner can open that page/)).toBeNull();
  });
});
