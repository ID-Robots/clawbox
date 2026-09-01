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
});
