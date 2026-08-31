import type { ReactNode } from "react";
import { render, screen } from "@/tests/helpers/test-utils";
import { describe, expect, it, vi } from "vitest";
import WifiHandoffOverlay from "@/components/WifiHandoffOverlay";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ t: (key: string, params?: Record<string, string>) => params?.url ? `${key}:${params.url}` : key }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/hooks/useReconnect", () => ({ useReconnect: () => "probing" }));

describe("WifiHandoffOverlay", () => {
  it("offers the manual setup URL while automatic probing is still waiting", () => {
    render(<WifiHandoffOverlay ssid="Home WiFi" targetUrl="http://clawbox.local" />);

    expect(screen.getByRole("link", { name: "wifi.openUrl:clawbox.local" }))
      .toHaveAttribute("href", "http://clawbox.local/setup");
  });
});
