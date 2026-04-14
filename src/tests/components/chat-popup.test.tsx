import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "chat.setupRequiredTitle": "Finish setup to start chat",
        "chat.setupRequiredBody": "The AI gateway starts after initial setup. Complete the setup window, then open chat again.",
        "chat.openSetup": "Open setup",
      };
      return translations[key] ?? key;
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/client-kv", () => ({
  getJSON: vi.fn(() => null),
  setJSON: vi.fn(),
}));

vi.mock("@/lib/chat-markdown", () => ({
  renderText: (text: string) => text,
}));

describe("ChatPopup", () => {
  it("shows setup guidance instead of attempting a gateway connection", async () => {
    const onOpenSetup = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      value: vi.fn(),
      configurable: true,
    });

    const { getByText } = render(
      <ChatPopup
        isOpen
        onClose={() => {}}
        setupRequired
        onOpenSetup={onOpenSetup}
      />,
    );

    await waitFor(() => {
      expect(getByText("Finish setup to start chat")).toBeInTheDocument();
    });

    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(getByText("Open setup"));
    expect(onOpenSetup).toHaveBeenCalledTimes(1);
  });
});
