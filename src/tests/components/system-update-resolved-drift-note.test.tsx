import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import SystemUpdateApp from "@/components/SystemUpdateApp";
import { DRIFT_RESOLVED_CODE } from "@/lib/drift-codes";

// The real English strings, resolved the way the app resolves them.
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
 * TASK-757 — the line a finished run leaves behind about drift it RESOLVED is
 * history, not a problem.
 *
 * The completion card drew every warning identically: amber border, amber
 * ground, a warning triangle. Replacing a stale imperative with a past-tense
 * note in that same box would have swapped one alarm for another on a card
 * whose whole job is to stop alarming an owner whose update worked. A drift
 * code that is STILL live keeps the alarm, because that one is a problem.
 */

const STALE_DRIFT = {
  code: "build-from-other-commit",
  message: "This box is running a build made from 673817a but the code on disk is 2153954 — run Update to realign.",
};
const RESOLVED_NOTE = {
  code: DRIFT_RESOLVED_CODE,
  message: "When this update started: The code on disk (673817a) is not the tested commit for beta (2153954). The update resolved that — nothing further is needed.",
};

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function mountWith(warnings: Array<{ code: string; message: string }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/setup-api/update/versions")) {
        return jsonResponse({
          clawbox: { current: "v3.9.0", target: "v3.10.0", updateAvailable: true },
          openclaw: { current: null, target: null, updateAvailable: false },
        });
      }
      if (url.includes("/setup-api/system/build-identity")) return jsonResponse({});
      if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
      if (url.includes("/setup-api/update/run")) return jsonResponse({ started: true });
      if (url.includes("/setup-api/update/status")) {
        return jsonResponse({
          phase: "completed",
          currentStepIndex: -1,
          steps: [{ id: "bootstrap_updater", label: "Refreshing updater scripts", status: "completed" }],
          warnings,
        });
      }
      return jsonResponse({});
    }),
  );
}

/** Start a run and let the first status poll land. */
async function runToCompletion(findByRole: ReturnType<typeof render>["findByRole"]) {
  const button = await findByRole("button", { name: "Update everything" });
  button.click();
  // startPolling's first fetch is one interval in.
  await vi.advanceTimersByTimeAsync(2100);
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the completion card tells a resolved condition from a live one", () => {
  it("draws the resolved line as history, not as another alarm", async () => {
    mountWith([RESOLVED_NOTE]);
    const { findByRole, findByTestId } = render(<SystemUpdateApp />);

    await runToCompletion(findByRole);

    const note = await findByTestId(`update-warning-${DRIFT_RESOLVED_CODE}`);
    await waitFor(() => expect(note.getAttribute("data-tone")).toBe("info"));
    expect(note.className, "no amber ground on a run that worked").not.toContain("amber");
    expect(note.textContent).toContain("When this update started:");
    // …and the imperative the card was filed for is nowhere on it.
    expect(note.textContent).not.toContain("run Update");
  });

  it("keeps the alarm on a drift code that is still live", async () => {
    mountWith([STALE_DRIFT, RESOLVED_NOTE]);
    const { findByRole, findByTestId } = render(<SystemUpdateApp />);

    await runToCompletion(findByRole);

    const live = await findByTestId("update-warning-build-from-other-commit");
    expect(live.getAttribute("data-tone")).toBe("warning");
    expect(live.className).toContain("amber");

    const note = await findByTestId(`update-warning-${DRIFT_RESOLVED_CODE}`);
    expect(note.getAttribute("data-tone")).toBe("info");
  });
});
