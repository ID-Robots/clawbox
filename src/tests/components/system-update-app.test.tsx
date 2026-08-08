import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import SystemUpdateApp from "@/components/SystemUpdateApp";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

// A device recovered by force-update.sh is at the current git version but may
// still have a stale OpenClaw / systemd unit. In that "up-to-date" state the UI
// must still offer a way to re-run the full update — behind Advanced options and
// a confirmation, since it reboots.
describe("SystemUpdateApp — force-full-update recovery affordance", () => {
  let runBody: string | null;

  beforeEach(() => {
    runBody = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "3.1.11", target: "3.1.11", updateAvailable: false },
            openclaw: { current: "2026.7.1", target: "2026.7.1", updateAvailable: false },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) {
          return jsonResponse({ branch: null });
        }
        if (url.includes("/setup-api/update/run")) {
          runBody = typeof init?.body === "string" ? init.body : null;
          return jsonResponse({ started: true });
        }
        if (url.includes("/setup-api/update/status")) {
          // Not "running" — otherwise the mount effect would join a live poll
          // and render the "updating" hero instead of "up to date".
          return jsonResponse({ phase: "idle", steps: [] });
        }
        return jsonResponse({});
      }),
    );
  });

  it("offers 'Force full update' under Advanced options and forces only after confirming", async () => {
    const { getByRole, findByText } = render(<SystemUpdateApp />);

    await findByText("You're up to date");

    // Recovery affordance lives under Advanced options, not on the happy path.
    fireEvent.click(getByRole("button", { name: /Advanced options/ }));
    fireEvent.click(getByRole("button", { name: "Force full update" }));

    // Confirmation gates the reboot — the confirm has a distinct name, and
    // nothing fires until it's clicked.
    getByRole("dialog");
    expect(runBody).toBeNull();

    fireEvent.click(getByRole("button", { name: "Yes, run full update" }));

    await waitFor(() => {
      expect(runBody).not.toBeNull();
    });
    expect(JSON.parse(runBody as string)).toMatchObject({ force: true });
  });

  it("dismisses the confirm dialog on Escape without forcing an update", async () => {
    const { getByRole, queryByRole, findByText } = render(<SystemUpdateApp />);

    await findByText("You're up to date");
    fireEvent.click(getByRole("button", { name: /Advanced options/ }));
    fireEvent.click(getByRole("button", { name: "Force full update" }));
    getByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(queryByRole("dialog")).toBeNull();
    });
    expect(runBody).toBeNull();
  });
});
