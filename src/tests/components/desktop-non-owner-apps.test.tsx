import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { nonOwnerVerdict } from "@/lib/non-owner-scope";
import { UPDATE_LOCK_HEADER, UPDATING_PAGE } from "@/lib/update-constants";

// Multi-user ClawBox OS. A second ClawBox user gets the owner's desktop: the
// store-installed apps — skills and web apps — in the icon grid, the launcher
// and the shelf, the assistant (their own chat), the mascot, the notices. And
// it still asks the server nothing the server would refuse them: every
// request is judged by the very table the middleware answers with.

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
let signedOut = false;

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
    // The middleware's answer to a session the box no longer accepts, on every
    // /setup-api request alike.
    if (signedOut && url.includes("/setup-api/")) {
      return { ok: false, status: 401, headers: new Headers(), json: async () => ({ error: "Unauthorized" }), text: async () => "" };
    }
    // The middleware stamps the update lock on every /setup-api answer alike.
    const lock: Record<string, string> = updateLocked && url.includes("/setup-api/") ? { [UPDATE_LOCK_HEADER]: "1" } : {};
    if (url.includes("/setup-api/users/me")) return answer(me, lock);
    if (url.includes("/setup-api/kv")) return answer({}, lock);
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
  signedOut = false;
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

describe("the desktop's installed apps — every signed-in person's", () => {
  it("offers the owner their installed app (so the case below means something)", async () => {
    me = OWNER;
    render(<ChromeDesktop />);
    expect((await screen.findAllByText(APP_NAME)).length).toBeGreaterThan(0);
    await openLauncher();
    await wait(150);
    expect((await screen.findAllByText(APP_NAME)).length).toBeGreaterThan(0);
    await drainOwnerWrites();
  });

  it("offers a second ClawBox user the same installed apps, and every built-in app but the harness console", async () => {
    me = ALICE;
    render(<ChromeDesktop />);
    expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
    expect((await screen.findAllByText(APP_NAME)).length).toBeGreaterThan(0);

    await openLauncher();
    const launcher = await screen.findByTestId("app-launcher");
    // The launcher's list once the harness and the copy have landed.
    await waitFor(() => {
      const offered = launcher.textContent ?? "";
      for (const name of ["Settings", "Terminal", "Files", "Coding Agent", "ClawKeep", "Memory Shard", "Prime Radiant"]) {
        expect(offered, name).toContain(name);
      }
    });
    // The harness's own console lists every conversation on the box.
    expect(launcher.textContent ?? "").not.toContain("OpenClaw");
    await drainOwnerWrites();
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
      nonOwnerVerdict({ pathname: url.pathname, method, searchParams: url.searchParams, intent: "fetch", username: "alice" }) !== "allow");
    expect(refused.map((r) => r.label)).toEqual([]);

    // …while asking what the owner's desktop asks: it IS the owner's desktop.
    await waitFor(() => {
      for (const fragment of [
        "GET /setup-api/preferences?all=1",
        "GET /setup-api/kv",
        "/setup-api/harness/active",
        "/setup-api/update/versions",
        "/setup-api/ai-models/status",
        "/setup-api/clawkeep",
      ]) {
        expect(asked(fragment), fragment).toBe(true);
      }
    });
    // The assistant (their own chat), the mascot and the timezone adopter are mounted.
    expect(mounted.chat).toBeGreaterThan(0);
    expect(mounted.mascot).toBeGreaterThan(0);
    expect(mounted.timezone).toBeGreaterThan(0);
    await drainOwnerWrites();
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
        "GET /setup-api/system/battery",
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
      // The desktop's 2 s poll of the notice ring, which the middleware
      // stamps with the update lock like any /setup-api answer.
      await waitFor(() => expect(replace).toHaveBeenCalledWith(UPDATING_PAGE), { timeout: 6_000 });
    } finally {
      if (saved) Object.defineProperty(window, "location", saved);
    }
  });
});

describe("a desktop whose session is gone", () => {
  // The poll the desktop makes anyway (the notice ring for the owner,
  // /users/me for another user) is answered 401 once the session has expired
  // or been revoked. An open page never navigates, so without this it stayed a
  // frozen desktop and kept asking every route it polls, refused each time.
  function stubLocation() {
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
    return { replace, restore: () => { if (saved) Object.defineProperty(window, "location", saved); } };
  }

  it("the owner's desktop goes to the login page, carrying where it was", async () => {
    me = OWNER;
    const { replace, restore } = stubLocation();
    try {
      render(<ChromeDesktop />);
      expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
      await waitFor(() => expect(asked("/setup-api/kv")).toBe(true), { timeout: 6_000 });
      signedOut = true;
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?redirect=%2F"), { timeout: 6_000 });
    } finally {
      restore();
    }
  });

  it("a second ClawBox user's desktop does too, off its own poll", async () => {
    me = ALICE;
    const { replace, restore } = stubLocation();
    try {
      render(<ChromeDesktop />);
      expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
      signedOut = true;
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/login?redirect=%2F"), { timeout: 6_000 });
    } finally {
      restore();
    }
  });

  it("a second ClawBox user's ordinary desktop is not sent to login", async () => {
    // Their session is fine; the few owner-only routes answer them 403, never
    // 401, and the desktop must stay where it is.
    me = ALICE;
    const { replace, restore } = stubLocation();
    try {
      render(<ChromeDesktop />);
      expect(await screen.findByTestId("shelf-user-badge")).toBeInTheDocument();
      // Wait for the desktop's own notice-ring poll (the one that would carry
      // a 401) to be made and answered, rather than for a fixed time.
      const polls = () => requests().filter((r) => r.url.pathname === "/setup-api/kv").length;
      const before = polls();
      await waitFor(() => expect(polls()).toBeGreaterThan(before), { timeout: 6_000 });
      const results = vi.mocked(fetch).mock.results;
      await Promise.all(results.map((r) => r.value));
      await act(async () => {});
      expect(replace).not.toHaveBeenCalled();
    } finally {
      restore();
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
