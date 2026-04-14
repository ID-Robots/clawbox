import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import CredentialsStep from "@/components/CredentialsStep";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "credentials.title": "Security",
        "credentials.description": "Set a system password and configure your hotspot.",
        "credentials.localUrl": "Local URL",
        "credentials.localUrlLabel": "Device name",
        "credentials.localUrlHelp": "Lowercase letters, digits, and hyphens only. Max 63 characters.",
        "credentials.systemPassword": "System Password",
        "credentials.newPassword": "New Password",
        "credentials.minChars": "Minimum 8 characters",
        "credentials.confirmPassword": "Confirm Password",
        "credentials.reenterPassword": "Re-enter password",
        "credentials.hotspotSettings": "Hotspot Settings",
        "credentials.hotspotChangesApply": "Changes apply next time the hotspot starts.",
        "credentials.hotspotDisabled": "Hotspot will not start automatically.",
        "credentials.hotspotName": "Hotspot Name",
        "credentials.hotspotPassword": "Hotspot Password",
        "credentials.confirmHotspotPassword": "Confirm Hotspot Password",
        "credentials.reenterHotspot": "Re-enter hotspot password",
        "settings.connect": "Connect",
        skip: "Skip",
      };
      return translations[key] ?? key;
    },
  }),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/StatusMessage", () => ({
  default: ({ message }: { message: string }) => <div>{message}</div>,
}));

describe("CredentialsStep", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/setup-api/system/hotspot") {
        return {
          ok: true,
          json: async () => ({ ssid: "ClawBox-Setup", enabled: true }),
        } as Response;
      }
      if (url === "/setup-api/system/hostname") {
        return {
          ok: true,
          json: async () => ({ hostname: "clawbox" }),
        } as Response;
      }
      if (url === "/setup-api/setup/status") {
        return {
          ok: true,
          json: async () => ({ requires_current_password: false }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({}),
      } as Response;
    }));
  });

  it("advances immediately when skip is clicked without posting credentials", async () => {
    const onNext = vi.fn();
    const fetchMock = vi.mocked(fetch);
    const { getByRole } = render(<CredentialsStep onNext={onNext} />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/setup/status", expect.any(Object));
    });

    fireEvent.click(getByRole("button", { name: "Skip" }));

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([input, init]) =>
        typeof input === "string"
        && (input === "/setup-api/system/credentials" || input === "/setup-api/system/hotspot")
        && init?.method === "POST"),
    ).toBe(false);
  });
});
