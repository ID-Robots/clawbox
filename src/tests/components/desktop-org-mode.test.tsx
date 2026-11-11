import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChromeDesktop from "@/app/page";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { nonOwnerVerdict } from "@/lib/non-owner-scope";

/**
 * The desktop on an organisation box (TASK-2435, src/lib/org-mode.ts), and
 * the update and offer cards on every box:
 *   - a member of staff gets Chat, Files and Settings — desktop, shelf and
 *     launcher — no installed app, and asks the box for nothing the server
 *     refuses them;
 *   - "Update available" is the owner's alone, on every box;
 *   - the ClawBox AI offer is hidden for everyone on an organisation box,
 *     the owner included, and shown as before on a home box.
 */

vi.mock("@/components/Mascot", () => ({ default: () => null }));
vi.mock("@/components/ChatPopup", () => ({ default: () => null, CHAT_PANEL_GAP: 12 }));
vi.mock("@/components/TimezoneAdopter", () => ({ default: () => null }));

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const APP_NAME = "Weather Now";
const OWNER = { username: "clawbox", isOwner: true, multiUser: true };
const ALICE = { username: "alice", isOwner: false, multiUser: true };
let me: Record<string, unknown> = OWNER;

function answer(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) };
}

let fetchStub = vi.fn();

function installFetch() {
  fetchStub = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/setup-api/users/me")) return answer(me);
    if (url.includes("/setup-api/setup/status")) return answer({ setup_complete: true });
    if (url.includes("/setup-api/harness/active")) return answer({ active: "openclaw", edition: "openclaw", activeKnown: true });
    // No ClawBox AI on this box: the offer's own condition holds.
    if (url.includes("/setup-api/ai-models/status")) return answer({ clawaiConfigured: false, provider: "openai" });
    // An update is waiting, and nothing dismissed it.
    if (url.includes("/setup-api/update/versions")) {
      return answer({ clawbox: { current: "4.3.0", target: "4.3.1", updateAvailable: true }, openclaw: null, edition: "hermes" });
    }
    if (url.includes("/setup-api/update/dismissal")) return answer({ fingerprint: null });
    if (url.includes("/setup-api/preferences?all=1")) {
      return answer({
        installed_apps: ["weather"],
        installed_meta: { weather: { name: APP_NAME, color: "#0ea5e9", webappUrl: "/setup-api/webapps?app=weather" } },
      });
    }
    return answer({});
  });
  vi.stubGlobal("fetch", fetchStub);
}

function requests(): { method: string; url: URL; label: string }[] {
  return (fetchStub.mock.calls as [unknown, RequestInit | undefined][]).map(([input, init]) => {
    const url = new URL(String(input), "http://clawbox.local");
    const method = (init?.method ?? "GET").toUpperCase();
    return { method, url, label: `${method} ${url.pathname}${url.search}` };
  });
}
const asked = (fragment: string) => requests().some((r) => r.label.includes(fragment));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const OFFER = "Free backup with ClawBox AI";
const updateCard = () => screen.queryByRole("button", { name: "Dismiss" });

async function launcherText(): Promise<string> {
  fireEvent.click((await screen.findAllByTestId("shelf-launcher-button"))[0]);
  const launcher = await screen.findByTestId("app-launcher");
  await waitFor(() => expect(launcher.textContent ?? "").toContain("Settings"));
  return launcher.textContent ?? "";
}

beforeEach(() => {
  resetHarnessCache();
  _resetSessionUserForTest();
  window.localStorage.clear();
  installFetch();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a member of staff on an organisation box", () => {
  beforeEach(() => {
    me = { ...ALICE, orgMode: true };
  });

  it("gets Chat, Files and Settings in the launcher, and no installed app", async () => {
    render(<ChromeDesktop />);
    const offered = await launcherText();
    for (const name of ["Chat", "Files", "Settings"]) expect(offered, name).toContain(name);
    for (const name of ["Terminal", "Coding Agent", "ClawKeep", "Memory Shard", "Prime Radiant", "System Update", "Agent Browser", APP_NAME]) {
      expect(offered, name).not.toContain(name);
    }
    await wait(300);
  });

  it("gets exactly those three icons on the desktop", async () => {
    render(<ChromeDesktop />);
    await screen.findByTestId("shelf-user-badge");
    await waitFor(() => {
      const ids = [...document.querySelectorAll("[data-desktop-icon-id]")].map((el) => el.getAttribute("data-desktop-icon-id"));
      expect(ids.sort()).toEqual(["desktop-clawbox", "desktop-files", "desktop-settings"]);
    });
    await wait(300);
  });

  it("sees no update card and no ClawBox AI offer, and never asks for them", async () => {
    render(<ChromeDesktop />);
    await screen.findByTestId("shelf-user-badge");
    await wait(800);
    expect(screen.queryByText(OFFER)).toBeNull();
    expect(updateCard()).toBeNull();
    expect(asked("/setup-api/update/versions")).toBe(false);
    expect(asked("/setup-api/whats-new")).toBe(false);
  });

  it("asks the box for nothing the server would refuse them", async () => {
    render(<ChromeDesktop />);
    await screen.findByTestId("shelf-user-badge");
    await wait(800);
    const refused = requests().filter(({ method, url }) =>
      nonOwnerVerdict({ pathname: url.pathname, method, searchParams: url.searchParams, intent: "fetch", username: "alice", orgMode: true }) !== "allow");
    expect(refused.map((r) => r.label)).toEqual([]);
    // Its notice ring is /users/me, not the box's kv.
    expect(asked("/setup-api/kv")).toBe(false);
    expect(asked("GET /setup-api/users/me")).toBe(true);
  });
});

describe("the owner of an organisation box", () => {
  beforeEach(() => {
    me = { ...OWNER, orgMode: true };
  });

  it("keeps every app and still sees the update card", async () => {
    render(<ChromeDesktop />);
    expect(await screen.findByText("4.3.1", { exact: false })).toBeInTheDocument();
    const offered = await launcherText();
    for (const name of ["Terminal", "Coding Agent", "ClawKeep"]) expect(offered, name).toContain(name);
    // The installed app is the owner's too.
    expect((await screen.findAllByText(APP_NAME)).length).toBeGreaterThan(0);
    await wait(650);
  });

  it("is not shown the ClawBox AI offer", async () => {
    render(<ChromeDesktop />);
    expect(await screen.findByText("4.3.1", { exact: false })).toBeInTheDocument();
    await wait(500);
    expect(screen.queryByText(OFFER)).toBeNull();
    await wait(650);
  });
});

describe("a home box", () => {
  it("shows its owner the update card and the ClawBox AI offer, as before", async () => {
    me = OWNER;
    render(<ChromeDesktop />);
    expect(await screen.findByText(OFFER)).toBeInTheDocument();
    expect(await screen.findByText("4.3.1", { exact: false })).toBeInTheDocument();
    await wait(650);
  });

  it("never shows another user the update card", async () => {
    me = ALICE;
    render(<ChromeDesktop />);
    await screen.findByTestId("shelf-user-badge");
    await wait(800);
    expect(screen.queryByText("4.3.1", { exact: false })).toBeNull();
    expect(asked("/setup-api/update/versions")).toBe(false);
    // Their launcher has no System Update either.
    expect(await launcherText()).not.toContain("System Update");
    await wait(650);
  });
});
