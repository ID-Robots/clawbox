// @vitest-environment jsdom
/**
 * `/app/installed-<id>` — the standalone page behind "Open in new tab" and a
 * bookmark, for an app the owner installed.
 *
 * The id alone says nothing about what the app is; the desktop decides from
 * installed_meta, and this page has to reach the same answer: a webapp is
 * framed (never with allow-same-origin), a store skill opens its settings, an
 * id nothing is installed under fails closed. It used to frame every
 * `installed-*` id as a webapp, painting a 404 in an empty frame for a skill.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";
import { render, screen } from "@/tests/helpers/test-utils";
import StandaloneAppPage from "@/app/app/[id]/page";
import { WEBAPP_IFRAME_SANDBOX } from "@/lib/webapp-sandbox";

let routeId = "installed-weather";
let installedMeta: Record<string, unknown> = {};

vi.mock("next/navigation", () => ({ useParams: () => ({ id: routeId }) }));
vi.mock("next/link", () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}));
vi.mock("next/image", () => ({ default: () => null }));
vi.mock("@/lib/client-harness", () => ({ fetchHarness: vi.fn(async () => ({ active: "openclaw" })) }));
// The settings window's own behaviour is pinned elsewhere; here only WHICH
// view the page picks matters.
vi.mock("@/components/InstalledAppSettings", () => ({
  default: ({ appId, storeApp }: { appId: string; storeApp: { name: string } }) => (
    <div data-testid="installed-app-settings">{`${appId}:${storeApp.name}`}</div>
  ),
}));
vi.mock("@/components/InstalledAppIcon", () => ({ default: () => null }));

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("keys=installed_meta")) return { ok: true, json: async () => ({ installed_meta: installedMeta }) };
      return { ok: true, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("/app/installed-<id>", () => {
  it("opens a store skill on its settings, titled with the app's name", async () => {
    routeId = "installed-weather";
    installedMeta = { weather: { name: "Weather Forecast", color: "#06b6d4", iconUrl: "" } };
    render(<StandaloneAppPage />);
    const view = await screen.findByTestId("installed-app-settings", {}, { timeout: 5000 });
    expect(view.textContent).toBe("weather:Weather Forecast");
    expect(screen.getByText("Weather Forecast")).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("frames a webapp at its own URL without allow-same-origin", async () => {
    routeId = "installed-notes";
    installedMeta = { notes: { name: "Notes", color: "#f97316", iconUrl: "", webappUrl: "/setup-api/webapps?app=notes" } };
    render(<StandaloneAppPage />);
    const frame = await screen.findByTitle("Notes");
    expect(frame.getAttribute("sandbox")).toBe(WEBAPP_IFRAME_SANDBOX);
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("data-webapp-id")).toBe("notes");
    expect(frame.getAttribute("src")).toContain("/setup-api/webapps?app=notes");
    expect(screen.queryByTestId("installed-app-settings")).toBeNull();
  });

  it("fails closed for an id nothing is installed under", async () => {
    routeId = "installed-ghost";
    installedMeta = {};
    render(<StandaloneAppPage />);
    await screen.findByText(/App not found/);
    expect(document.querySelector("iframe")).toBeNull();
  });
});
