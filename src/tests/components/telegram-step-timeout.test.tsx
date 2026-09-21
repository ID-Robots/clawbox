import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import TelegramStep from "@/components/TelegramStep";

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

vi.mock("qrcode.react", () => ({ QRCodeSVG: () => null }));

// Keep TelegramStep's request and recovery state real while exposing the
// overlay callback that normally fires only after its one-minute health poll.
vi.mock("@/components/TelegramConfiguringOverlay", () => ({
  default: ({ onTimeout }: { onTimeout: () => void }) => (
    <button type="button" data-testid="telegram-force-timeout" onClick={onTimeout}>
      Force timeout
    </button>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TelegramStep readiness recovery", () => {
  it("aborts a pending save and re-enables Connect after readiness times out", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TelegramStep onNext={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("telegram.botToken"), {
      target: { value: "123456789:test-token" },
    });
    const connect = screen.getByRole("button", { name: "settings.connect" });
    fireEvent.click(connect);

    await waitFor(() => expect(connect).toBeDisabled());
    fireEvent.click(await screen.findByTestId("telegram-force-timeout"));

    await waitFor(() => expect(connect).toBeEnabled());
    expect(screen.getByText("telegram.readinessTimeout")).toBeInTheDocument();
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.signal;
    expect(signal?.aborted).toBe(true);
  });

  /**
   * The 502 exception on this save is for the ROUTE's own pending answer —
   * `success` plus the warning that explains it. A cloudflared or nginx 502 has
   * an HTML body and may never have reached the box, so it must not carry the
   * first-run wizard past the step whose whole job is to prove the token works.
   * SettingsApp's copy of this save carries the same guard.
   */
  it("does not take a bare proxy 502 for a saved token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 })));
    const onNext = vi.fn();

    render(<TelegramStep onNext={onNext} />);
    fireEvent.change(screen.getByLabelText("telegram.botToken"), {
      target: { value: "123456789:test-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.connect" }));

    expect(await screen.findByText("Failed to save")).toBeInTheDocument();
    expect(onNext).not.toHaveBeenCalled();
  });

  it("does not take a 502 without the route's warning for a saved token", async () => {
    // `{success: true}` and no sentence is not the pending answer — the route
    // only sends that 502 WITH the warning. Accepting it on the status alone
    // resolves the configure promise and lets the overlay finish the step.
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })));
    const onNext = vi.fn();

    render(<TelegramStep onNext={onNext} />);
    fireEvent.change(screen.getByLabelText("telegram.botToken"), {
      target: { value: "123456789:test-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "settings.connect" }));

    expect(await screen.findByText("Failed to save")).toBeInTheDocument();
    expect(onNext).not.toHaveBeenCalled();
  });
});
