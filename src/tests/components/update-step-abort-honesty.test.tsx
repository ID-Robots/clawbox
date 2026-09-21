import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import UpdateStep from "@/components/UpdateStep";
import { deferred } from "@/tests/helpers/deferred";

// Resolve the real English strings the way the app does, so a renamed key
// fails here instead of shipping a raw "update.foo" to the owner.
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

const FAILED_BANNER = translations.en["update.failedToCheck"];
const CHECKING = translations.en["update.checkingUpdates"];

// A settled status the box is already current on, so the second (kept) mount
// renders a real screen rather than staying on the spinner.
const IDLE_UP_TO_DATE = {
  phase: "idle",
  currentStepIndex: -1,
  steps: [],
  versions: {
    clawbox: { current: "3.0.0", target: null },
    openclaw: { current: "1.2.3", target: null },
  },
};

function okJson(json: () => Promise<unknown>) {
  return { ok: true, status: 200, json };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("UpdateStep — an aborted status read is not a failure", () => {
  it("does not show the failure banner when the effect aborts its own in-flight status read", async () => {
    // The init effect re-issues its status GET (StrictMode's mount→unmount→mount
    // is the shipped trigger: Next renders the wizard under StrictMode). When it
    // re-runs it calls abort() on the FIRST request's controller. On a cold box
    // that request's git-fetch-backed body arrives ~1.8s later, and an abort
    // DURING the body read does not surface as a DOMException/AbortError — real
    // engines throw a TypeError. The old catch sniffed the error type, so the
    // aborted read fell through to the failure banner even though every request
    // to the server returned 200.
    const firstJson = deferred<unknown>();
    let call = 0;
    const fetchMock = vi.fn(() => {
      call += 1;
      if (call === 1) return Promise.resolve(okJson(() => firstJson.promise));
      return Promise.resolve(okJson(() => Promise.resolve(IDLE_UP_TO_DATE)));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <StrictMode>
        <UpdateStep onNext={() => {}} />
      </StrictMode>,
    );

    // The kept mount's request resolves and the spinner goes away.
    await waitFor(() => {
      expect(screen.queryByText(CHECKING)).not.toBeInTheDocument();
    });

    // Now the first request — the one the effect aborted — has its body read
    // fail the way a real aborted read fails: a TypeError, not an AbortError.
    await act(async () => {
      firstJson.reject(new TypeError("terminated"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText(FAILED_BANNER)).not.toBeInTheDocument();
  });

  it("still shows the failure banner when the status read genuinely fails", async () => {
    // The other half of the fix: a real failure must NOT be hidden. Here the
    // request was never aborted — the body simply could not be parsed — so the
    // banner has to appear.
    const fetchMock = vi.fn(() =>
      Promise.resolve(okJson(() => Promise.reject(new Error("Unexpected end of JSON input")))),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<UpdateStep onNext={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(FAILED_BANNER)).toBeInTheDocument();
    });
  });
});
