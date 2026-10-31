import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

// Dismiss clears the settled run the web server is holding. It can be refused:
// another surface (Settings, the wizard, the MCP tools) may have started an
// update between the click and the POST, and the state being cleared then
// belongs to that live run. `fetch` resolves for a 409, so ignoring the answer
// left this screen offering "Update everything" over an update in progress.
describe("SystemUpdateApp — a dismissal refused by a live update", () => {
  it("rejoins the running update instead of showing the update controls", async () => {
    let statusCalls = 0;
    let dismissCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "3.1.11", target: "3.1.11", updateAvailable: false },
            openclaw: { current: "2026.7.1", target: "2026.7.1", updateAvailable: false },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: null });
        if (url.includes("/setup-api/update/dismiss")) {
          dismissCalls += 1;
          return jsonResponse({ dismissed: false, error: "An update is in progress" }, false, 409);
        }
        if (url.includes("/setup-api/update/status")) {
          statusCalls += 1;
          // The run this page adopted had already failed; by the time Dismiss
          // is pressed, somebody else has started a new one.
          return statusCalls === 1
            ? jsonResponse({ phase: "failed", steps: [{ id: "restart", label: "Restart", status: "failed" }] })
            : jsonResponse({ phase: "running", steps: [{ id: "build", label: "Build", status: "running" }] });
        }
        return jsonResponse({});
      }),
    );

    const { getByRole, queryByRole, findByText } = render(<SystemUpdateApp />);
    await findByText("Update stopped");

    fireEvent.click(getByRole("button", { name: "Dismiss" }));

    await findByText("In progress");
    expect(dismissCalls).toBe(1);
    // Nothing that could start a second update is on screen while one runs.
    expect(queryByRole("button", { name: /Advanced options/ })).toBeNull();
  });
});

// 2026-09-16 — three field boxes died mid-update and came back reporting the
// interrupted verdict. The server RESUMES such a run from the step it died on
// when a fresh run is started, and its sentence says so; but the failed panel
// offered Dismiss alone (which forgets the position) and the hero's update
// button is hidden while a run is settled, so the resume was reachable by no
// gesture. The Resume button is that gesture, and only an interrupted run
// gets it: any other failure keeps the panel it had.
describe("SystemUpdateApp — an interrupted run offers Resume", () => {
  const INTERRUPTED =
    "The update was interrupted before it could finish: the box restarted — or lost power — while "
    + "\"Updating OpenClaw\" was running. Nothing was rolled back — Resume continues the update from there.";

  function mount(status: unknown) {
    let runBody: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "4.0.0", target: "4.0.0", updateAvailable: false },
            openclaw: { current: null, target: "2026.9.3", updateAvailable: true },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
        if (url.includes("/setup-api/update/run")) {
          runBody = typeof init?.body === "string" ? init.body : null;
          return jsonResponse({ started: true });
        }
        if (url.includes("/setup-api/update/status")) return jsonResponse(status);
        return jsonResponse({});
      }),
    );
    return { view: render(<SystemUpdateApp />), runBody: () => runBody };
  }

  it("resumes an interrupted run from the failed panel, through the ordinary run route", async () => {
    const { view, runBody } = mount({
      phase: "failed",
      error: INTERRUPTED,
      currentStepIndex: -1,
      steps: [
        { id: "bootstrap_updater", label: "Refreshing updater scripts", status: "completed" },
        { id: "apt_update", label: "Updating system packages", status: "completed" },
        { id: "openclaw_install", label: "Updating OpenClaw", status: "failed", error: "The box restarted — or lost power — while this step was running." },
        { id: "restart", label: "Updating ClawBox and restarting", status: "pending" },
      ],
    });
    await view.findByText(/Resume continues the update from there/);
    // Dismiss stays beside it: the owner may prefer a clean start.
    expect(view.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Resume update" }));
    await waitFor(() => expect(runBody()).not.toBeNull());
    expect(JSON.parse(runBody()!)).toEqual({ force: true });
  });

  it("says 'again' rather than 'resume' when the verdict names no step", async () => {
    const { view } = mount({
      phase: "failed",
      error: "The update was interrupted before it could finish: the process running it went away while it ran, "
        + "and no step is left to resume. Nothing was rolled back — start the update again.",
      currentStepIndex: -1,
      steps: [{ id: "bootstrap_updater", label: "Refreshing updater scripts", status: "pending" }],
    });
    await view.findByText(/start the update again/);
    expect(view.getByRole("button", { name: "Start the update again" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Resume update" })).toBeNull();
  });

  it("offers no Resume for a failure with a cause of its own", async () => {
    const { view } = mount({
      phase: "failed",
      error: "Rebuild failed — see clawbox-root-update@rebuild_reboot logs",
      currentStepIndex: -1,
      steps: [{ id: "restart", label: "Updating ClawBox and restarting", status: "failed", error: "Rebuild failed" }],
    });
    // The sentence is on the hero AND on the failed step.
    await view.findAllByText(/Rebuild failed/);
    expect(view.queryByRole("button", { name: "Resume update" })).toBeNull();
    expect(view.queryByRole("button", { name: "Start the update again" })).toBeNull();
    expect(view.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });
});

// On a board, the web server was replaced while "Installing Chromium" ran. The
// one that came back answered "idle" until it had judged the dead run's lock,
// and then "failed" with the step to resume from — but this screen had stopped
// polling at the first "idle" and sat on "Don't power off" with every step
// waiting, for good, over a run nothing was running.
describe("SystemUpdateApp — a poll that answers idle mid-run", () => {
  const RUN = [
    { id: "bootstrap_updater", label: "Refreshing updater scripts" },
    { id: "apt_update", label: "Updating system packages" },
    { id: "chromium_install", label: "Installing Chromium" },
    { id: "restart", label: "Updating ClawBox and restarting" },
  ];
  const at = (done: number, current: "running" | "failed" | "pending") =>
    RUN.map((s, i) => ({ ...s, status: i < done ? "completed" : i === done ? current : "pending" }));
  const INTERRUPTED =
    "The update was interrupted before it could finish: the web server was replaced while "
    + "\"Installing Chromium\" was running. Nothing was rolled back — Resume continues the update from there.";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the progress it saw and keeps asking until the server's verdict", async () => {
    const answers = [
      { phase: "running", currentStepIndex: 2, steps: at(2, "running") },
      { phase: "idle", currentStepIndex: -1, steps: at(0, "pending") },
      { phase: "idle", currentStepIndex: -1, steps: at(0, "pending") },
      { phase: "failed", error: INTERRUPTED, currentStepIndex: -1, steps: at(2, "failed") },
    ];
    let statusCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "v4.3.0", target: "beta@a2c1718", updateAvailable: true },
            openclaw: { current: "2026.10.7", target: null, updateAvailable: false },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
        if (url.includes("/setup-api/update/status")) {
          return jsonResponse(answers[Math.min(statusCalls++, answers.length - 1)]);
        }
        return jsonResponse({});
      }),
    );

    const view = render(<SystemUpdateApp />);
    expect(await view.findByTestId("update-step-count")).toHaveTextContent("2 / 4 steps complete");

    // Two "idle" answers (the poll runs every 2 s): the run seen last stays on
    // screen, and the poll goes on.
    await waitFor(() => expect(statusCalls).toBe(3), { timeout: 6_000 });
    expect(view.getByTestId("update-step-count")).toHaveTextContent("2 / 4 steps complete");
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "updating");

    await view.findAllByText(/Resume continues the update from there/, undefined, { timeout: 4_000 });
    expect(view.getByRole("button", { name: "Resume update" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Dismiss" })).toBeTruthy();
    expect(view.queryByTestId("update-run-notice")).toBeNull();
  }, 15_000);
});

// The run route answers 200 for a click that started nothing — another run
// holds the box, or a database compaction does. With a poll that waits out
// "idle" (above), following that click blindly would wait for ever.
describe("SystemUpdateApp — a click the run route did not start", () => {
  function mount(run: unknown, statusAfterClick: unknown) {
    let clicked = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/setup-api/update/versions")) {
          return jsonResponse({
            clawbox: { current: "v4.3.0", target: "beta@a2c1718", updateAvailable: true },
            openclaw: { current: "2026.10.7", target: null, updateAvailable: false },
          });
        }
        if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
        if (url.includes("/setup-api/update/run")) {
          clicked = true;
          return jsonResponse(run);
        }
        if (url.includes("/setup-api/update/status")) {
          return jsonResponse(clicked ? statusAfterClick : { phase: "idle", steps: [] });
        }
        return jsonResponse({});
      }),
    );
    return render(<SystemUpdateApp />);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says the server's reason when no run is going", async () => {
    const view = mount(
      { started: false, error: "A database maintenance pass is running" },
      { phase: "idle", steps: [] },
    );
    fireEvent.click(await view.findByRole("button", { name: "Update everything" }));
    await view.findByText("A database maintenance pass is running");
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "failed");
    expect(view.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("joins the run that holds the box", async () => {
    const view = mount(
      { started: false, error: "Update already in progress" },
      { phase: "running", currentStepIndex: 0, steps: [{ id: "apt_update", label: "Updating system packages", status: "running" }] },
    );
    fireEvent.click(await view.findByRole("button", { name: "Update everything" }));
    await view.findAllByText("Updating system packages");
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "updating");
    expect(view.queryByText("Update already in progress")).toBeNull();
  });
});
