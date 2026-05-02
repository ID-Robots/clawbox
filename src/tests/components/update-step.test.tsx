import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import UpdateStep from "@/components/UpdateStep";

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
    expect(queryByRole("button", { name: "Skip updates" })).toBeNull();
  });
});
