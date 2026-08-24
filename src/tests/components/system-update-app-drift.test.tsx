import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SystemUpdateApp from "@/components/SystemUpdateApp";

// The real English strings, resolved the way the app resolves them — so a
// renamed or missing key fails here instead of shipping a raw "update.foo" to
// the owner. Mirrors src/tests/components/build-identity-panel.test.tsx.
vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    locale: "en",
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations.en[key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

/**
 * TASK-447 round 2, defect 1 (hwtest-round1, 2026-08-24).
 *
 * With `build-from-other-commit` live and the checkout 11+ commits behind its
 * tested branch, the System Update app rendered a green tick, "You're up to
 * date — Every component is on the latest release", and a disabled "Up to date"
 * button — while Settings → About said "run Update to realign". Version numbers
 * are blind to drift: package.json does not change commit-to-commit, so
 * `clawbox.target` was null and the app concluded there was nothing to do.
 *
 * The one screen whose job is "should I update?" must not deny the drift.
 */

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const DRIFT_IDENTITY = {
  build: { shortCommit: "1dc29ef", branch: "beta", builtAt: "2026-08-24T15:12:02.000Z" },
  deployedBuildId: "6lvAbUpp0QIu",
  checkout: { commit: "d285cfd8", shortCommit: "d285cfd", branch: "beta", dirty: false, committedAt: null },
  pin: { branch: "beta", source: "checkout-branch", commit: null, pinned: false },
  drift: {
    buildVsCheckout: "drift",
    checkoutVsPin: "unknown",
    detected: true,
    reasons: ["This box is running a build made from 1dc29ef but the code on disk is d285cfd — run Update to realign."],
    codes: ["build-from-other-commit"],
  },
};

const HEALTHY_IDENTITY = {
  ...DRIFT_IDENTITY,
  drift: { buildVsCheckout: "match", checkoutVsPin: "match", detected: false, reasons: [], codes: [] },
};

function mountWith(identity: unknown) {
  let runCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      // No version delta whatsoever — exactly the box in the report.
      if (url.includes("/setup-api/update/versions")) {
        return jsonResponse({
          clawbox: { current: "v3.9.0", target: null, updateAvailable: false },
          openclaw: { current: null, target: "2026.7.1-2", updateAvailable: false },
        });
      }
      if (url.includes("/setup-api/system/build-identity")) return jsonResponse(identity);
      if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
      if (url.includes("/setup-api/update/run")) {
        runCalls++;
        return jsonResponse({ started: true });
      }
      if (url.includes("/setup-api/update/status")) return jsonResponse({ phase: "idle", steps: [] });
      return jsonResponse({});
    }),
  );
  return { runCalls: () => runCalls };
}

describe("SystemUpdateApp — drift is not 'up to date'", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not claim the box is up to date while it is not running its own code", async () => {
    mountWith(DRIFT_IDENTITY);
    const { queryByText, findByText } = render(<SystemUpdateApp />);

    await findByText(translations.en["update.driftHeadline"]);
    expect(queryByText("You're up to date")).toBeNull();
    expect(queryByText("Every component is on the latest release.")).toBeNull();
  });

  it("says which drift, in the same words the About screen uses", async () => {
    mountWith(DRIFT_IDENTITY);
    const { findByText } = render(<SystemUpdateApp />);

    await findByText(translations.en["settings.driftTitle"]);
    await findByText(/running a build from 1dc29ef but the code on disk is d285cfd/);
  });

  it("offers the update, and running it starts the real update", async () => {
    const h = mountWith(DRIFT_IDENTITY);
    const { findByRole, queryByRole } = render(<SystemUpdateApp />);

    const button = await findByRole("button", { name: "Update everything" });
    // …and the card below no longer carries a disabled "Up to date" button.
    expect(queryByRole("button", { name: "Up to date" })).toBeNull();

    button.click();
    await waitFor(() => expect(h.runCalls()).toBe(1));
  });

  it("leaves the happy path alone when there is no drift", async () => {
    mountWith(HEALTHY_IDENTITY);
    const { findByText, queryByText } = render(<SystemUpdateApp />);

    await findByText("You're up to date");
    expect(queryByText(translations.en["update.driftHeadline"])).toBeNull();
    expect(queryByText(translations.en["settings.driftTitle"])).toBeNull();
  });
});
