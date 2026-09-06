import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import SystemUpdateApp from "@/components/SystemUpdateApp";

/**
 * 2026-09-05, on the box: the update died at the "Updating ClawBox and
 * restarting" step, and every System Update window opened afterwards said
 * "1 update available — Update everything" with no trace of it. The mount
 * effect adopted the server's state only while `phase === "running"`, and the
 * one step whose failure nobody can be watching for is the one that restarts
 * the server.
 */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const FAILED_STATE = {
  phase: "failed",
  currentStepIndex: -1,
  error: "Error: rebuild failed (exit 137)",
  steps: [
    { id: "check_internet", label: "Checking internet connection", status: "completed" },
    { id: "restart", label: "Updating ClawBox and restarting", status: "failed", error: "Error: rebuild failed (exit 137)" },
    { id: "post_update", label: "Finishing up", status: "pending" },
  ],
};

describe("SystemUpdateApp — a failure that was already on the server", () => {
  let statusBody: unknown;
  let dismissCalls: number;

  beforeEach(() => {
    statusBody = FAILED_STATE;
    dismissCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "4.0.0", target: "4.1.0", updateAvailable: true },
            openclaw: { current: "2026.7.1", target: "2026.7.1", updateAvailable: false },
            edition: "openclaw",
            remote: { reachable: true },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
        if (url.includes("/setup-api/update/dismiss")) {
          if (init?.method === "POST") dismissCalls++;
          return jsonResponse({ dismissed: true });
        }
        if (url.includes("/setup-api/update/status")) return jsonResponse(statusBody);
        return jsonResponse({});
      }),
    );
  });

  it("renders the stopped update instead of offering the version it never installed", async () => {
    const { findByText, findAllByText, queryByText } = render(<SystemUpdateApp />);

    await findByText("Update failed");
    await findByText("Update stopped");
    // The real reason is said twice — the hero subhead and the failed step.
    expect(await findAllByText("Error: rebuild failed (exit 137)")).not.toHaveLength(0);
    expect(queryByText("1 update available")).toBeNull();
  });

  it("dismisses it on the server too, so a reload does not raise the same dead run", async () => {
    const { findByText, findByRole, queryByText } = render(<SystemUpdateApp />);

    await findByText("Update failed");
    fireEvent.click(await findByRole("button", { name: "Dismiss" }));

    await waitFor(() => expect(dismissCalls).toBe(1));
    await waitFor(() => expect(queryByText("Update failed")).toBeNull());
    // With the run forgotten, the page is back to what it can offer.
    await findByText("1 update available");
  });

  it("leaves a box with nothing wrong alone", async () => {
    statusBody = { phase: "idle", steps: [], currentStepIndex: -1 };

    const { findByText, queryByText } = render(<SystemUpdateApp />);

    await findByText("1 update available");
    expect(queryByText("Update failed")).toBeNull();
    expect(dismissCalls).toBe(0);
  });

  it("does not adopt 'completed' — the status route synthesises that for an idle box", async () => {
    // A box whose `update_completed` flag is set and has nothing to do gets
    // `phase: "completed"` from /update/status on every poll. Adopting it would
    // paint "Update complete" over a device that has just been sitting there.
    statusBody = {
      phase: "completed",
      currentStepIndex: -1,
      steps: [{ id: "check_internet", label: "Checking internet connection", status: "completed" }],
    };

    const { findByText, queryByText } = render(<SystemUpdateApp />);

    await findByText("1 update available");
    expect(queryByText("Update complete")).toBeNull();
  });
});
