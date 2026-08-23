import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/tests/helpers/test-utils";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";

vi.mock("@/lib/i18n", () => ({
  LANGUAGES: [{ code: "en", name: "English" }],
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("next/image", () => ({
  default: () => null,
}));

const defaultUi: UISettings = {
  wallpaperId: "default",
  wpFit: "fill",
  wpBgColor: "#000000",
  wpOpacity: 100,
  mascotHidden: false,
  wallpapers: [{ id: "default", name: "Default" }],
  customWallpapers: [],
  onWallpaperChange: vi.fn(),
  onWpFitChange: vi.fn(),
  onWpBgColorChange: vi.fn(),
  onWpOpacityChange: vi.fn(),
  onMascotToggle: vi.fn(),
  onWallpaperUpload: vi.fn(),
  onCustomWallpaperDelete: vi.fn(),
};

function jsonResponse(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

// About renders `${arch} ${platform}` unguarded, so the stats payload has to
// be shaped even though this suite is not about it.
const statsResponse = {
  overview: { hostname: "clawbox-test", os: "TestOS", kernel: "6.8.0", uptime: "1h", arch: "arm64", platform: "linux" },
  cpu: { usage: 12, model: "Test CPU", cores: 4, loadAvg: ["0.10", "0.12", "0.14"], speed: 1800 },
  memory: { total: 8e9, used: 2e9, free: 6e9, usedPercent: 25, swap: { used: 0, total: 0, percent: 0 } },
  temperature: { value: 42, display: "42C" },
  gpu: { usage: 0 },
  storage: [],
  network: [],
  processes: [],
  timestamp: Date.now(),
};

/**
 * The About screen's version block, scoped so "OpenClaw" appearing anywhere
 * else on the page cannot make an assertion pass or fail by accident.
 */
async function openAboutVersions(versions: unknown) {
  vi.stubGlobal("fetch", vi.fn((input: string | URL) => {
    const url = input.toString();
    if (url === "/setup-api/update/versions") return jsonResponse(versions);
    if (url === "/setup-api/update/status") return jsonResponse({ phase: "idle", steps: [] });
    if (url === "/setup-api/system/stats") return jsonResponse(statsResponse);
    return jsonResponse({});
  }));

  render(<SettingsApp ui={defaultUi} />);
  fireEvent.click(screen.getByRole("button", { name: /settings\.about$/ }));

  const label = await screen.findByText("settings.version");
  const block = label.closest(".space-y-2");
  if (!block) throw new Error("About version block not found");
  return within(block as HTMLElement);
}

/** Read the value cell of a version row by its label. */
function rowValue(block: ReturnType<typeof within>, label: string): string {
  const cell = block.getByText(label).parentElement?.lastElementChild;
  return cell?.textContent ?? "";
}

/**
 * On the Hermes edition the OpenClaw harness is not installed at all, so the
 * About screen's "OpenClaw" row could only ever read "not installed" — a fact
 * about software this SKU was never supposed to have, and no information about
 * the agent the box actually runs. The row now follows the edition.
 */
describe("SettingsApp About — harness version row", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the Hermes version and no OpenClaw row on the hermes edition", async () => {
    const block = await openAboutVersions({
      clawbox: { current: "v3.1.0", target: null },
      openclaw: { current: null, target: null },
      hermes: { current: "v0.20.5", target: null, updateAvailable: false },
      edition: "hermes",
    });

    expect(block.queryByText("OpenClaw")).not.toBeInTheDocument();
    expect(block.getByText("Hermes")).toBeInTheDocument();
    expect(rowValue(block, "Hermes")).toBe("v0.20.5");
  });

  it("still says 'not installed' on hermes when the agent cannot be probed", async () => {
    const block = await openAboutVersions({
      clawbox: { current: "v3.1.0", target: null },
      openclaw: { current: null, target: null },
      hermes: { current: null, target: null, updateAvailable: false },
      edition: "hermes",
    });

    expect(block.queryByText("OpenClaw")).not.toBeInTheDocument();
    expect(rowValue(block, "Hermes")).toBe("settings.notInstalled");
  });

  it("is unchanged on the openclaw edition — OpenClaw only, no Hermes row", async () => {
    const block = await openAboutVersions({
      clawbox: { current: "v3.1.0", target: null },
      openclaw: { current: "OpenClaw 2026.7.1 (3e72c03)", target: null },
      edition: "openclaw",
    });

    expect(block.queryByText("Hermes")).not.toBeInTheDocument();
    expect(rowValue(block, "OpenClaw")).toBe("2026.7.1");
  });

  it("labels both harnesses on the dual edition", async () => {
    const block = await openAboutVersions({
      clawbox: { current: "v3.1.0", target: null },
      openclaw: { current: "OpenClaw 2026.7.1 (3e72c03)", target: null },
      hermes: { current: "v0.20.5", target: null, updateAvailable: false },
      edition: "dual",
    });

    expect(rowValue(block, "OpenClaw")).toBe("2026.7.1");
    expect(rowValue(block, "Hermes")).toBe("v0.20.5");
  });

  it("falls back to the old OpenClaw-only row when the server predates the edition field", async () => {
    // A device that has not been updated yet answers with the two-key shape.
    const block = await openAboutVersions({
      clawbox: { current: "v3.0.3", target: null },
      openclaw: { current: "2026.7.1", target: null },
    });

    expect(rowValue(block, "OpenClaw")).toBe("2026.7.1");
    expect(block.queryByText("Hermes")).not.toBeInTheDocument();
  });
});
