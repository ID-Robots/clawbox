import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@/tests/helpers/test-utils";
import UpdateStep from "@/components/UpdateStep";

/** The step's own flash before it auto-advances on an up-to-date box. */
const AUTO_ADVANCE_MS = 1_500;

function upToDateStatus(): Response {
  return {
    ok: true,
    json: async () => ({
      phase: "idle",
      steps: [],
      currentStepIndex: -1,
      versions: {
        clawbox: { current: "v4.0.0", target: null, updateAvailable: false },
        openclaw: { current: "2026.9.3", target: null, updateAvailable: false },
        remote: { reachable: true },
      },
    }),
  } as Response;
}

vi.mock("@/lib/i18n", () => ({
  useT: () => ({
    t: (key: string) => {
      const translations: Record<string, string> = {
        "update.title": "System Update",
        "update.updateDescription": "Install the latest updates before finishing setup.",
        "update.startUpdate": "Start Update",
        "update.skipUpdates": "Skip updates",
        "update.upToDate": "Up to date",
        "update.latestVersion": "You already have the latest version.",
        continue: "Continue",
        skip: "Skip",
      };
      return translations[key] ?? key;
    },
  }),
}));

describe("UpdateStep", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/setup-api/update/status") {
        return {
          ok: true,
          json: async () => ({
            phase: "idle",
            steps: [],
            currentStepIndex: -1,
            versions: {
              clawbox: { current: "v1.0.0", target: "v1.1.0" },
              openclaw: { current: "v1.0.0", target: null },
            },
          }),
        } as Response;
      }

      return {
        ok: false,
        status: 404,
        json: async () => ({ error: "Not found" }),
      } as Response;
    }));
  });

  it("hides the skip button when an update is available so the user must update", async () => {
    const onNext = vi.fn();
    const { queryByRole } = render(<UpdateStep onNext={onNext} />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/setup-api/update/status", expect.any(Object));
    });

    // Skip used to short-circuit the wizard's Update step; now the only way
    // forward is to actually run the update (or, on a downgrade, click skip).
    // Cover both copy variants — the bare "Skip" used on downgrade and the
    // regular "Skip updates" used on the idle path.
    expect(queryByRole("button", { name: /^(skip|skip updates)$/i })).toBeNull();
  });

  // The wizard's `onNext` is what persists the step the owner has reached, and
  // /setup-api/setup/status derives "the Update step is done" from exactly that
  // record — no update runs on a box that is already current, so nothing else
  // on the device marks the step passed (TASK-863). If this auto-advance ever
  // stops calling onNext, the flag goes quiet again.
  it("advances the wizard on a box that is already up to date", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (input.toString() === "/setup-api/update/status") return upToDateStatus();
      return { ok: false, status: 404, json: async () => ({ error: "Not found" }) } as Response;
    }));

    const onNext = vi.fn();
    const { findByText } = render(<UpdateStep onNext={onNext} />);

    await findByText("Up to date");
    expect(onNext).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTO_ADVANCE_MS);
    });

    await waitFor(() => expect(onNext).toHaveBeenCalledTimes(1));
  });
});
