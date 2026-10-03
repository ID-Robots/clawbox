/**
 * The two places a session is switched from (TASK-1247): /login, where the
 * duration is picked — 12 hours by default — and the tray's Switch user /
 * Lock. Each tells every other tab before it navigates, and navigates with
 * `replace`, so Back does not land on the form (or the desktop) it just left.
 * A /login tab also FOLLOWS a sign-in made in another tab.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import LoginPage from "@/app/login/page";
import SystemTray from "@/components/SystemTray";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { SESSION_SWITCH_CHANNEL, readSessionSwitch } from "@/lib/session-switch";
import {
  FakeBroadcastChannel,
  announceFromAnotherTab,
  channelTick,
  installFakeBroadcastChannel,
  stubLocation,
  type StubbedLocation,
} from "@/tests/helpers/session-switch";

vi.mock("next/image", () => ({ default: () => null }));

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key }),
}));

let location: StubbedLocation | undefined;
let loginStatus = 200;

function answer(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

beforeEach(() => {
  window.localStorage.clear();
  installFakeBroadcastChannel();
  _resetSessionUserForTest();
  loginStatus = 200;
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url === "/login-api" && init?.method === "POST") {
      return loginStatus === 200
        ? answer(200, { success: true, username: "clawbox" })
        : answer(loginStatus, { error: "Incorrect password", code: "bad_credentials" });
    }
    if (url.startsWith("/login-api/users")) return answer(200, { multiUser: false });
    if (url.startsWith("/setup-api/setup/status")) return answer(200, { setup_complete: true, password_configured: true });
    if (url.startsWith("/login-api/logout")) return answer(200, { success: true });
    return answer(200, {});
  }));
});

afterEach(() => {
  location?.restore();
  location = undefined;
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

async function signIn(password = "correct horse") {
  const input = await screen.findByPlaceholderText("login.passwordPlaceholder");
  fireEvent.change(input, { target: { value: password } });
  fireEvent.click(screen.getByRole("button", { name: "login.logIn" }));
}

describe("/login — the tab that picks the 12-hour session", () => {
  it("sends the 12-hour duration, tells the other tabs, and replaces itself with the page it came for", async () => {
    location = stubLocation("/login?redirect=%2Fapp%2Fterminal");
    render(<LoginPage />);
    // 12 hours is the preselected duration.
    expect(await screen.findByRole("radio", { name: "login.12h" })).toHaveAttribute("aria-checked", "true");
    await signIn();

    await waitFor(() => expect(location!.replace).toHaveBeenCalledWith("/app/terminal"));
    const post = vi.mocked(fetch).mock.calls.find(([u, i]) => u === "/login-api" && i?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toMatchObject({ duration: 43200 });

    const announced = readSessionSwitch();
    expect(announced?.kind).toBe("login");
    expect(FakeBroadcastChannel.posted).toEqual([{ name: SESSION_SWITCH_CHANNEL, data: announced }]);
    // Back from the new session's page must not land on this form again.
    expect(location!.assign).not.toHaveBeenCalled();
  });

  it("goes to the desktop when it was opened without a redirect, and never off the origin", async () => {
    location = stubLocation("/login?redirect=%2F%2Fevil.example%2F");
    render(<LoginPage />);
    await signIn();
    await waitFor(() => expect(location!.replace).toHaveBeenCalledWith("/"));
  });

  it("announces nothing and stays when the password is wrong", async () => {
    loginStatus = 401;
    location = stubLocation("/login?redirect=%2F");
    render(<LoginPage />);
    await signIn("wrong");
    expect(await screen.findByText("login.incorrectPassword")).toBeInTheDocument();
    expect(readSessionSwitch()).toBeNull();
    expect(FakeBroadcastChannel.posted).toHaveLength(0);
    expect(location!.replace).not.toHaveBeenCalled();
  });
});

describe("/login — a tab left on the form while another tab signs in", () => {
  it("follows the sign-in to the page it was sent from", async () => {
    location = stubLocation("/login?redirect=%2Fapp%2Fterminal");
    render(<LoginPage />);
    await screen.findByPlaceholderText("login.passwordPlaceholder");
    announceFromAnotherTab("login", "channel");
    await channelTick();
    expect(location!.replace).toHaveBeenCalledWith("/app/terminal");
  });

  it("stays on the form when another tab signs OUT", async () => {
    location = stubLocation("/login?redirect=%2F");
    render(<LoginPage />);
    await screen.findByPlaceholderText("login.passwordPlaceholder");
    announceFromAnotherTab("logout", "both");
    await channelTick();
    expect(location!.replace).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText("login.passwordPlaceholder")).toBeInTheDocument();
  });
});

describe("the tray's Switch user / Lock — the other way a session is switched", () => {
  it("signs out, tells the other tabs, and replaces the desktop with /login", async () => {
    location = stubLocation("/");
    render(<SystemTray isOpen onClose={() => {}} />);
    fireEvent.click(await screen.findByText("tray.lock"));

    await waitFor(() => expect(location!.replace).toHaveBeenCalledWith("/login"));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith("/login-api/logout", { method: "POST" });
    const announced = readSessionSwitch();
    expect(announced?.kind).toBe("logout");
    expect(FakeBroadcastChannel.posted.map((p) => p.data)).toEqual([announced]);
    // Back must not bring back a desktop whose session just ended.
    expect(location!.assign).not.toHaveBeenCalled();
  });
});
