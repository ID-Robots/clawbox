import type { ReactNode } from "react";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, waitFor } from "@/tests/helpers/test-utils";
import LoginPage from "@/app/login/page";

vi.mock("next/image", () => ({
  default: () => null,
}));

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key }),
}));

describe("LoginPage", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ setup_complete: false }),
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("redirects incomplete setups to /setup instead of looping back to /login", async () => {
    const replaceMock = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      href: "http://localhost/login?redirect=%2F",
      pathname: "/login",
      search: "?redirect=%2F",
      replace: replaceMock,
    });

    render(<LoginPage />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/setup/status");
    });
    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith("/setup");
    });
  });

  // Once a password exists, middleware puts /setup behind the session gate, so
  // bouncing there unauthenticated would 307 straight back to /login — the two
  // redirects loop forever and the owner can never reach the form to log in.
  it("shows the login form when a password exists but setup is unfinished", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ setup_complete: false, password_configured: true }),
    }));
    const replaceMock = vi.fn();
    vi.stubGlobal("location", {
      ...window.location,
      href: "http://localhost/login?redirect=%2Fsetup",
      pathname: "/login",
      search: "?redirect=%2Fsetup",
      replace: replaceMock,
    });

    const { container } = render(<LoginPage />);

    await waitFor(() => {
      expect(container.querySelector("#login-password")).not.toBeNull();
    });
    expect(replaceMock).not.toHaveBeenCalled();
  });
});

/**
 * Over a row of monitors (TASK-2850) the page — its spinner too — is drawn on
 * the main monitor only, from the geometry /login-api/monitors answers with no
 * session; with one screen there is no box at all and the page is as it was.
 */
describe("LoginPage over a row of monitors", () => {
  /** Two monitors in a row, the main one (1920x1080) on the right: the window is the row. */
  const ROW = {
    available: true,
    main: "2",
    box: { width: 4480, height: 1440 },
    mirror: false,
    monitors: [
      { id: "1", label: "", enabled: true, rect: { x: 0, y: 0, width: 2560, height: 1440 } },
      { id: "2", label: "", enabled: true, rect: { x: 2560, y: 0, width: 1920, height: 1080 } },
    ],
  };
  const viewport = { width: window.innerWidth, height: window.innerHeight };

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 4480, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 1440, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: viewport.width, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: viewport.height, configurable: true });
    vi.unstubAllGlobals();
  });

  /** The box's answers; the setup status waits for `release`, so the spinner can be seen. */
  function serve(monitors: unknown) {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url === "/login-api/monitors") return json(monitors);
      if (url === "/setup-api/setup/status") {
        await held;
        return json({ setup_complete: true, password_configured: true });
      }
      return json({ multiUser: false });
    }));
    return release;
  }

  it("draws the spinner, then the sign-in panel, inside the main monitor's rect", async () => {
    const release = serve(ROW);
    const { findByTestId, getByTestId } = render(<LoginPage />);
    const box = await findByTestId("login-main-screen");
    await waitFor(() => expect(box.style.left).toBe("2560px"));
    expect(box.style.top).toBe("0px");
    expect(box.style.width).toBe("1920px");
    expect(box.style.height).toBe("1080px");
    expect(box.className).toContain("absolute");
    expect(box.querySelector('[role="status"]')).not.toBeNull();

    release();
    await waitFor(() => expect(getByTestId("login-main-screen").querySelector("#login-password")).not.toBeNull());
    expect(getByTestId("login-main-screen").style.left).toBe("2560px");
    expect(fetch).toHaveBeenCalledWith("/login-api/monitors", { cache: "no-store" });
    expect(fetch).not.toHaveBeenCalledWith("/setup-api/monitors", expect.anything());
  });

  it("with one screen draws no box at all: the page is as it always was", async () => {
    const release = serve({ available: false });
    release();
    const { container, getByTestId } = render(<LoginPage />);
    await waitFor(() => expect(container.querySelector("#login-password")).not.toBeNull());
    expect(fetch).toHaveBeenCalledWith("/login-api/monitors", { cache: "no-store" });
    const box = getByTestId("login-main-screen");
    expect(box.className).toBe("contents");
    expect(box.getAttribute("style")).toBeNull();
    expect(box.parentElement!.className).toBe("contents");
    expect(box.parentElement!.getAttribute("style")).toBeNull();
  });
});
