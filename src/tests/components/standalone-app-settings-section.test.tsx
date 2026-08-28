// @vitest-environment jsdom
/**
 * `/app/settings?section=…` — the standalone Settings page opening on a
 * named section.
 *
 * The desktop opens a section by dispatching an event into a listening
 * window manager. The standalone page (`src/app/app/[id]/page.tsx`, the one
 * behind "Open in new tab") has no such listener, so the Coding Agent's
 * Settings link navigates there with the section in the URL, and the page
 * must hand it to Settings the same two ways the desktop does — the pending
 * value it reads on mount, and the event an already-mounted one hears.
 *
 * Settings itself is stubbed with exactly that reading side: the real app's
 * half is pinned in settings-app.test.tsx, and mounting every panel here
 * would test the wrong thing slowly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import type React from "react";
import { render, screen } from "@/tests/helpers/test-utils";
import StandaloneAppPage from "@/app/app/[id]/page";
import { OPEN_SETTINGS_SECTION_EVENT } from "@/lib/ui-events";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "settings" }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/client-harness", () => ({ fetchHarness: vi.fn(async () => ({ active: "openclaw" })) }));
vi.mock("@/components/SettingsApp", () => ({
  default: function SettingsStub() {
    const [section, setSection] = useState<string>("");
    useEffect(() => {
      const w = window as Window & { __clawboxPendingSettingsSection?: unknown };
      if (typeof w.__clawboxPendingSettingsSection === "string") {
        setSection(w.__clawboxPendingSettingsSection);
        delete w.__clawboxPendingSettingsSection;
      }
      const handler = (e: Event) => setSection((e as CustomEvent<{ section?: string }>).detail?.section ?? "");
      window.addEventListener(OPEN_SETTINGS_SECTION_EVENT, handler);
      return () => window.removeEventListener(OPEN_SETTINGS_SECTION_EVENT, handler);
    }, []);
    return <div data-testid="settings-section">{section}</div>;
  },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection;
  window.history.pushState({}, "", "/");
});

describe("/app/settings?section=…", () => {
  it("opens Settings on the section named in the URL", async () => {
    window.history.pushState({}, "", "/app/settings?section=codingAgent");
    render(<StandaloneAppPage />);
    expect((await screen.findByTestId("settings-section", {}, { timeout: 5000 })).textContent).toBe("codingAgent");
  });

  it("hands nothing over when the URL names no section", async () => {
    window.history.pushState({}, "", "/app/settings");
    render(<StandaloneAppPage />);
    expect((await screen.findByTestId("settings-section", {}, { timeout: 5000 })).textContent).toBe("");
    expect((window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection).toBeUndefined();
  });
});
