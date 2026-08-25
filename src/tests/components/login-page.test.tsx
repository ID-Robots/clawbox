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
