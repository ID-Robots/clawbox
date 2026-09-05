import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SystemUpdateApp from "@/components/SystemUpdateApp";
import SettingsApp, { type UISettings } from "@/components/SettingsApp";
import UpdateStep from "@/components/UpdateStep";

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  useT: () => ({
    locale: "en",
    setLocale: () => {},
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));
vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => <img alt="" {...props} /> }));
vi.mock("@/components/TelegramConfiguringOverlay", () => ({ default: () => null }));

/**
 * TASK-655. GitHub refuses anonymous `git-upload-pack` POSTs from an address
 * that has used up its allowance — 401, "Repository not found.", for a PUBLIC
 * repo — and every ClawBox fetches anonymously.
 *
 * The device then compares HEAD against the STALE `origin/<branch>` the last
 * successful fetch left, finds no delta, and the one screen whose job is
 * "should I update?" answers "You're up to date. Every component is on the
 * latest release." A box that cannot reach its update remote is told it is
 * current, indefinitely and with a green tick.
 */

const REFUSAL_REASON =
  "GitHub refused this ClawBox's anonymous request for the update repository. "
  + "The repository is public and the device needs no password — GitHub answers 401 to anonymous git "
  + "requests from an address that has made too many. Try again in a few minutes.";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const HEALTHY_IDENTITY = {
  build: { shortCommit: "1dc29ef", branch: "beta", builtAt: "2026-08-24T15:12:02.000Z" },
  deployedBuildId: "6lvAbUpp0QIu",
  checkout: { commit: "1dc29ef0", shortCommit: "1dc29ef", branch: "beta", dirty: false, committedAt: null },
  pin: { branch: "beta", source: "pin-file", commit: null, pinned: true },
  drift: { buildVsCheckout: "match", checkoutVsPin: "match", detected: false, reasons: [], codes: [] },
};

function mountWith(remote: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/setup-api/update/versions")) {
        return jsonResponse({
          clawbox: { current: "v3.9.0", target: null, updateAvailable: false },
          openclaw: { current: "2026.8.1", target: null, updateAvailable: false },
          edition: "openclaw",
          ...(remote === undefined ? {} : { remote }),
        });
      }
      if (url.includes("/setup-api/system/build-identity")) return jsonResponse(HEALTHY_IDENTITY);
      if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
      if (url.includes("/setup-api/update/status")) return jsonResponse({ phase: "idle", steps: [] });
      return jsonResponse({});
    }),
  );
}

describe("SystemUpdateApp — a remote it could not reach is not 'up to date'", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("says the check failed instead of claiming every component is current", async () => {
    mountWith({ reachable: false, refusedAnonymously: true, reason: REFUSAL_REASON });
    const { findByText, queryByText } = render(<SystemUpdateApp />);

    await findByText("Couldn't reach the update server");
    expect(queryByText("You're up to date")).toBeNull();
    expect(queryByText("Every component is on the latest release.")).toBeNull();
  });

  it("tells the owner GitHub refused the anonymous request, not that a password is missing", async () => {
    mountWith({ reachable: false, refusedAnonymously: true, reason: REFUSAL_REASON });
    const { findByText } = render(<SystemUpdateApp />);

    await findByText(REFUSAL_REASON);
  });

  it("still says 'up to date' when the remote answered", async () => {
    mountWith({ reachable: true });
    const { findByText } = render(<SystemUpdateApp />);

    await findByText("You're up to date");
  });

  it("keeps offering the update to a drifted box the remote refused", async () => {
    // Drift is LOCAL evidence — the build on disk disagrees with the checkout —
    // and it stays actionable whatever GitHub is doing. Hiding the button
    // behind an unreachable remote would take the one repair the owner can run
    // away from the box that needs it.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "v3.9.0", target: null, updateAvailable: false },
            openclaw: { current: "2026.8.1", target: null, updateAvailable: false },
            edition: "openclaw",
            remote: { reachable: false, refusedAnonymously: true, reason: REFUSAL_REASON },
          });
        }
        if (url.includes("/setup-api/system/build-identity")) {
          return jsonResponse({
            ...HEALTHY_IDENTITY,
            checkout: { commit: "d285cfd8", shortCommit: "d285cfd", branch: "beta", dirty: false, committedAt: null },
            drift: {
              buildVsCheckout: "drift",
              checkoutVsPin: "unknown",
              detected: true,
              reasons: ["This box is running a build made from 1dc29ef but the code on disk is d285cfd — run Update to realign."],
              codes: ["build-from-other-commit"],
            },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
        if (url.includes("/setup-api/update/status")) return jsonResponse({ phase: "idle", steps: [] });
        return jsonResponse({});
      }),
    );
    const { findByRole } = render(<SystemUpdateApp />);

    await findByRole("button", { name: "Update everything" });
  });

  it("still says 'up to date' for a device whose server predates the field", async () => {
    // An older /update/versions payload carries no `remote` at all. Absent is
    // not "unreachable" — treating it as one would alarm every box mid-fleet
    // update.
    mountWith(undefined);
    const { findByText } = render(<SystemUpdateApp />);

    await findByText("You're up to date");
  });
});

/**
 * The same claim, one screen over. Settings' sidebar puts "Up to date" under
 * the System Update entry from the same payload, so a box GitHub was refusing
 * carried the lie in two places at once — and the sidebar's copy sits beside a
 * page that has stopped making it.
 */
const settingsUi: UISettings = {
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

function stubSettingsFetch(remote: unknown): void {
  vi.stubGlobal("fetch", vi.fn((input: string | URL | undefined) => {
    const url = String(input ?? "");
    if (url.startsWith("/setup-api/update/versions")) {
      return Promise.resolve(jsonResponse({
        clawbox: { current: "v4.0.0", target: null, updateAvailable: false },
        openclaw: { current: "2026.8.1", target: null, updateAvailable: false },
        edition: "openclaw",
        ...(remote === undefined ? {} : { remote }),
      }));
    }
    if (url === "/setup-api/update/status") return Promise.resolve(jsonResponse({ phase: "idle", steps: [] }));
    if (url === "/setup-api/system/update-branch") return Promise.resolve(jsonResponse({ branch: "beta" }));
    if (url === "/setup-api/providers/status") {
      return Promise.resolve(jsonResponse({ harness: "openclaw", defaultProvider: "clawai", degraded: false, providers: [] }));
    }
    return Promise.resolve(jsonResponse({}));
  }));
}

describe("Settings sidebar — the same claim, one screen over", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops the 'Up to date' subtitle when the device could not reach the remote", async () => {
    stubSettingsFetch({ reachable: false, refusedAnonymously: true, reason: REFUSAL_REASON });
    render(<SettingsApp ui={settingsUi} />);

    const nav = await screen.findByRole("navigation");
    await waitFor(() => expect(nav.textContent).toContain(translations.en["settings.systemUpdate"]));
    expect(nav.textContent).not.toContain(translations.en["settings.upToDate"]);
  });

  it("keeps it for a device that did reach the remote", async () => {
    stubSettingsFetch({ reachable: true });
    render(<SettingsApp ui={settingsUi} />);

    const nav = await screen.findByRole("navigation");
    await waitFor(() => expect(nav.textContent).toContain(translations.en["settings.upToDate"]));
  });
});

/**
 * The onboarding wizard, where the same claim also SKIPS WORK.
 *
 * `UpdateStep` reads /setup-api/update/status, whose `versions` object is the
 * whole `getVersionInfo()` payload. On a first boot behind an address GitHub is
 * refusing, HEAD matched the stale refs the image shipped with, the step
 * printed "Up to date" and auto-advanced after 1.5 s — the customer onboarded
 * onto whatever was in the image, with no update attempted and nothing said.
 */
function stubWizardStatus(remote: unknown) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "/setup-api/update/status") {
      return jsonResponse({
        phase: "idle",
        steps: [],
        currentStepIndex: -1,
        versions: {
          clawbox: { current: "v4.0.0", target: null, updateAvailable: false },
          openclaw: { current: "2026.8.1", target: null, updateAvailable: false },
          ...(remote === undefined ? {} : { remote }),
        },
      });
    }
    return jsonResponse({ error: "Not found" }, false, 404);
  }));
}

describe("SetupWizard update step — a refused check does not skip the step", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("does not auto-advance past the update step on a box that could not check", async () => {
    stubWizardStatus({ reachable: false, refusedAnonymously: true, reason: REFUSAL_REASON });
    const onNext = vi.fn();

    const { findByText } = render(<UpdateStep onNext={onNext} />);

    await findByText(REFUSAL_REASON);
    // The auto-advance fires 1.5 s after the step decides it is up to date.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(onNext).not.toHaveBeenCalled();
  }, 20_000);

  it("still auto-advances a box that reached GitHub and is current", async () => {
    stubWizardStatus({ reachable: true });
    const onNext = vi.fn();

    render(<UpdateStep onNext={onNext} />);

    await waitFor(() => expect(onNext).toHaveBeenCalled(), { timeout: 6_000 });
  }, 20_000);

  it("still auto-advances a device whose server predates the field", async () => {
    stubWizardStatus(undefined);
    const onNext = vi.fn();

    render(<UpdateStep onNext={onNext} />);

    await waitFor(() => expect(onNext).toHaveBeenCalled(), { timeout: 6_000 });
  }, 20_000);
});
