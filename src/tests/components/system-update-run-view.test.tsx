import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@/tests/helpers/test-utils";
import SystemUpdateApp from "@/components/SystemUpdateApp";
import UpdateStep, { describeUpdateFailure } from "@/components/UpdateStep";
import UpdateWhatsNewPanel, {
  pickHighlights,
  UPDATE_COMPACT_PICKS,
  UPDATE_GRID_PICKS,
} from "@/components/UpdateWhatsNewPanel";
import { whatsNewEn } from "@/lib/edition-translations/en-whats-new";
import { RESTART_STEP_ID } from "@/lib/update-constants";
import { releasePageUrl, updateWhatsNewPanel, type UpdateWhatsNew } from "@/lib/update-whats-new";
import type { StepState, UpdateState } from "@/lib/updater";
import { WHATS_NEW_HIGHLIGHTS, WHATS_NEW_RELEASE } from "@/lib/whats-new";

/**
 * The System Update window while a run is on screen: the steps on the left,
 * the version being installed on the right, "don't power off" across the
 * bottom; and a failed run said as its step, its real reason and the way on —
 * never as the updater's bare "Unknown error".
 */

const TARGET = `${WHATS_NEW_RELEASE}.0`;
const NO_REASON = "The device did not say why the update stopped.";

const LABELS: [string, string][] = [
  ["bootstrap_updater", "Refreshing updater scripts"],
  ["apt_update", "Updating system packages"],
  ["chromium_install", "Installing Chromium"],
  ["vnc_install", "Installing VNC (Remote Desktop)"],
  ["openclaw_install", "Updating OpenClaw"],
  ["openclaw_patch", "Patching OpenClaw gateway"],
  ["gateway_service", "Configuring gateway service"],
  [RESTART_STEP_ID, "Updating ClawBox and restarting"],
  ["system_fixups", "Applying system fixups"],
  ["gateway_health", "Verifying gateway health"],
];

/** Ten steps: the first `done` completed, the next one `at`, the rest pending. */
function steps(done: number, at: Partial<StepState> = { status: "running" }): StepState[] {
  return LABELS.map(([id, label], index) => ({
    id,
    label,
    status: index < done ? "completed" : "pending",
    ...(index === done ? at : {}),
  }));
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const WHATS_NEW: UpdateWhatsNew = {
  version: TARGET,
  channel: "beta",
  source: "none",
  highlights: [],
  releaseUrl: releasePageUrl(TARGET),
};

function mount(status: Partial<UpdateState>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/setup-api/update/versions")) {
        return jsonResponse({
          clawbox: { current: "4.2.5", target: TARGET, updateAvailable: true },
          openclaw: { current: "2026.10.3", target: "2026.10.7", updateAvailable: true },
          edition: "openclaw",
          remote: { reachable: true },
        });
      }
      if (url.includes("/setup-api/system/update-branch")) return jsonResponse({ branch: "beta" });
      if (url.includes("/setup-api/update/whats-new")) return jsonResponse(WHATS_NEW);
      if (url.includes("/setup-api/update/status")) return jsonResponse({ currentStepIndex: -1, ...status });
      return jsonResponse({});
    }),
  );
  return render(<SystemUpdateApp />);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SystemUpdateApp — a run in progress", () => {
  it("lays out the eyebrow, title, versions, count, meter and every step by number", async () => {
    mount({ phase: "running", currentStepIndex: 4, steps: steps(4, { status: "running", detail: "Installing openclaw@2026.10.7" }) });

    await screen.findByText("Updating your device");
    expect(screen.getByText("System Update")).toBeInTheDocument();
    expect(screen.getByText(/Updating your ClawBox with the latest software/)).toBeInTheDocument();

    const versions = await screen.findByTestId("update-run-versions");
    expect(versions.textContent).toContain("4.2.5");
    expect(versions.textContent).toContain(TARGET);
    expect(within(versions).getByTestId("update-run-channel")).toHaveTextContent("beta channel");

    const panel = screen.getByTestId("update-steps-panel");
    expect(within(panel).getByTestId("update-step-count")).toHaveTextContent("4 / 10 steps complete");
    // The current step is named above the meter and marked in the list.
    expect(within(panel).getAllByText("Updating OpenClaw")).toHaveLength(2);
    const meter = within(panel).getByRole("progressbar");
    expect(meter).toHaveAttribute("aria-valuenow", "4");
    expect(meter).toHaveAttribute("aria-valuemax", "10");

    const rows = within(screen.getByTestId("update-step-list")).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-status"))).toEqual([
      "completed", "completed", "completed", "completed", "running",
      "pending", "pending", "pending", "pending", "pending",
    ]);
    expect(rows[4]).toHaveAttribute("aria-current", "step");
    expect(within(rows[4]).getByText("In progress")).toBeInTheDocument();
    expect(rows[4].textContent).toContain("05");
    expect(rows[9].textContent).toContain("10");
    expect(within(rows[4]).getByTestId("update-step-detail")).toHaveTextContent("Installing openclaw@2026.10.7");

    const notice = screen.getByTestId("update-run-notice");
    expect(notice).toHaveTextContent("Don't power off until this finishes.");
    expect(notice).toHaveTextContent("This page reconnects automatically.");
    // Nothing that could start a second update is on screen while one runs.
    expect(screen.queryByRole("button", { name: /Advanced options/ })).toBeNull();
  });

  it("shows four feature cards of the version being installed, with their screenshots", async () => {
    mount({ phase: "running", currentStepIndex: 4, steps: steps(4) });

    const region = await screen.findByRole("region", { name: `What's new in ClawBox ${TARGET}` });
    expect(region).toHaveAttribute("data-variant", "grid");
    const expected = pickHighlights(UPDATE_GRID_PICKS, 4);
    const cards = within(region).getAllByRole("listitem");
    expect(cards).toHaveLength(Math.min(4, WHATS_NEW_HIGHLIGHTS.length));
    // The heading's first child is the icon's ligature, hidden from the name.
    expect(cards.map((card) => within(card).getByRole("heading").lastElementChild?.textContent))
      .toEqual(expected.map((item) => whatsNewEn[item.title]));
    expect(within(region).getAllByTestId("update-whats-new-image").map((img) => img.getAttribute("src")))
      .toEqual(expected.map((item) => item.image));
    expect(within(region).getByRole("link", { name: "Read the full release notes" }))
      .toHaveAttribute("href", releasePageUrl(TARGET));
  });
});

describe("SystemUpdateApp — a failed run", () => {
  it("names the failed step and the run's real reason, never the updater's placeholder", async () => {
    const reason = "openclaw@2026.10.7 could not be installed: npm ERR! code ENOSPC (no space left on device)";
    mount({ phase: "failed", error: reason, steps: steps(4, { status: "failed", error: "Unknown error" }) });

    await screen.findByText("Update failed");
    expect(screen.getByText("One step couldn't complete. See the steps below.")).toBeInTheDocument();

    const panel = screen.getByTestId("update-error-panel");
    expect(within(panel).getByRole("heading", { name: "Updating OpenClaw" })).toBeInTheDocument();
    expect(within(panel).getByTestId("update-error-reason")).toHaveTextContent(reason);
    expect(document.body.textContent).not.toContain("Unknown error");
    // An ordinary failure starts over on a fresh run, so it is not a "resume".
    expect(within(panel).queryByRole("button", { name: "Resume update" })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    const stepsPanel = screen.getByTestId("update-steps-panel");
    expect(within(stepsPanel).getByText("Update stopped")).toBeInTheDocument();
    const failedRow = within(stepsPanel).getAllByRole("listitem")[4];
    expect(failedRow).toHaveAttribute("data-status", "failed");
    expect(within(failedRow).getByText("Stopped")).toBeInTheDocument();
    // The failure is read before the steps, wherever the columns put it.
    expect(panel.compareDocumentPosition(stepsPanel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const log = within(screen.getByTestId("update-log")).getAllByRole("listitem");
    expect(log.map((line) => line.textContent?.slice(0, 2))).toEqual(["01", "02", "03", "04", "05"]);
    expect(log[4].textContent).toContain(`Updating OpenClaw: ${reason}`);
  });

  it("says the device gave no reason, rather than 'Unknown error', when it gave none", async () => {
    mount({ phase: "failed", steps: steps(2, { status: "failed", error: "Unknown error" }) });

    const panel = await screen.findByTestId("update-error-panel");
    expect(within(panel).getByRole("heading", { name: "Installing Chromium" })).toBeInTheDocument();
    expect(within(panel).getByTestId("update-error-reason").textContent).toContain(NO_REASON);
    expect(document.body.textContent).not.toContain("Unknown error");
  });

  it("marks a step the run died in as stopped, not in progress", async () => {
    const reason = "TypeError: Cannot read properties of undefined (reading 'pid')";
    mount({ phase: "failed", error: reason, steps: steps(7) });

    const panel = await screen.findByTestId("update-error-panel");
    expect(within(panel).getByRole("heading", { name: "Updating ClawBox and restarting" })).toBeInTheDocument();
    expect(within(panel).getByTestId("update-error-reason")).toHaveTextContent(reason);
    const row = within(screen.getByTestId("update-step-list")).getAllByRole("listitem")[7];
    expect(row).toHaveAttribute("data-status", "failed");
    expect(screen.queryByText("In progress")).toBeNull();
    expect(screen.queryByTestId("update-run-notice")).toBeNull();
  });

  it("offers Resume with the step's reason and the run's verdict for an interrupted run", async () => {
    const verdict = "The update was interrupted before it could finish: the box restarted — or lost power — while "
      + "\"Updating OpenClaw\" was running. Nothing was rolled back — Resume continues the update from there.";
    mount({
      phase: "failed",
      error: verdict,
      steps: steps(4, { status: "failed", error: "The box restarted — or lost power — while this step was running." }),
    });

    const panel = await screen.findByTestId("update-error-panel");
    expect(within(panel).getByTestId("update-error-reason")).toHaveTextContent("The box restarted — or lost power — while this step was running.");
    expect(within(panel).getByTestId("update-error-context")).toHaveTextContent(verdict);
    expect(within(panel).getByRole("button", { name: "Resume update" })).toBeInTheDocument();
  });

  it("keeps one feature beside the failure", async () => {
    mount({ phase: "failed", error: "Rebuild failed", steps: steps(7, { status: "failed", error: "Rebuild failed" }) });

    const region = await screen.findByRole("region", { name: `What's new in ClawBox ${TARGET}` });
    expect(region).toHaveAttribute("data-variant", "compact");
    const [feature] = pickHighlights(UPDATE_COMPACT_PICKS, 1);
    expect(within(region).getByText(whatsNewEn[feature.title])).toBeInTheDocument();
    expect(within(region).getByTestId("update-whats-new-image")).toHaveAttribute("src", feature.image);
  });
});

describe("describeUpdateFailure", () => {
  const base = (over: Partial<UpdateState>): UpdateState => ({ phase: "failed", currentStepIndex: -1, steps: [], ...over });

  it("prefers the step's own reason and keeps a different verdict as context", () => {
    const failure = describeUpdateFailure(base({ error: "verdict", steps: steps(1, { status: "failed", error: "step said" }) }));
    expect(failure.step?.id).toBe("apt_update");
    expect(failure).toMatchObject({ reason: "step said", context: "verdict" });
  });

  it("skips the placeholder and says one sentence once", () => {
    expect(describeUpdateFailure(base({ error: "same", steps: steps(1, { status: "failed", error: "same" }) })))
      .toMatchObject({ reason: "same", context: null });
    expect(describeUpdateFailure(base({ error: "Unknown error", steps: steps(1, { status: "failed", error: " Unknown error " }) })))
      .toMatchObject({ reason: null, context: null });
  });

  it("falls back to this screen's own error when there is no run", () => {
    expect(describeUpdateFailure(null, "Failed to start update (HTTP 409)"))
      .toEqual({ step: null, reason: "Failed to start update (HTTP 409)", context: null });
  });
});

describe("UpdateWhatsNewPanel — the window's variants", () => {
  it("draws notes for another release line as cards without pictures, marked as English", () => {
    const highlights = Array.from({ length: 6 }, (_, n) => ({ title: `Feature ${n}`, body: `Body ${n}` }));
    render(
      <UpdateWhatsNewPanel
        variant="grid"
        panel={updateWhatsNewPanel({ ...WHATS_NEW, version: "9.1.0", source: "notes", highlights, releaseUrl: releasePageUrl("9.1.0") })}
      />,
    );
    const region = screen.getByRole("region", { name: "What's new in ClawBox 9.1.0" });
    const list = within(region).getByRole("list");
    expect(list).toHaveAttribute("lang", "en");
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(region).queryByTestId("update-whats-new-image")).toBeNull();
  });

  it("says one plain line and links the releases when nothing could be read", () => {
    render(<UpdateWhatsNewPanel variant="grid" panel={updateWhatsNewPanel(null)} />);
    const region = screen.getByRole("region", { name: "What's new in this update" });
    expect(within(region).queryByRole("list")).toBeNull();
    expect(within(region).getByText(/latest ClawBox improvements and fixes/)).toBeInTheDocument();
  });

  it("picks the chosen highlights first and fills from the catalogue's order", () => {
    const catalogue = WHATS_NEW_HIGHLIGHTS.slice(0, 5);
    expect(pickHighlights([catalogue[3].title, "whatsNew.gone"], 3, catalogue)).toEqual([catalogue[3], catalogue[0], catalogue[1]]);
  });
});

describe("UpdateStep — the wizard's failed step", () => {
  it("says the device gave no reason instead of 'Unknown error'", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ phase: "failed", currentStepIndex: -1, steps: steps(2, { status: "failed", error: "Unknown error" }) })),
    );
    render(<UpdateStep onNext={() => {}} />);

    const error = await screen.findByTestId("update-step-error");
    expect(error.textContent).toContain("Installing Chromium:");
    expect(error.textContent).toContain(NO_REASON);
    expect(document.body.textContent).not.toContain("Unknown error");
    const rows = within(screen.getByTestId("update-step-list")).getAllByRole("listitem");
    expect(rows[2]).toHaveAttribute("data-status", "failed");
    expect(screen.getByTestId("update-step-count")).toHaveTextContent("2 / 10 steps complete");
  });
});

// A run-level error takes a different branch of the wizard: a real one is the
// whole story (no ledger, no per-step box), but the updater's placeholder,
// which a failFast step that threw a non-Error leaves on the run as well as on
// the step, must not stand in for that story.
describe("UpdateStep — the wizard's run-level error", () => {
  function mountWizard(status: Partial<UpdateState>) {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ currentStepIndex: -1, ...status })));
    render(<UpdateStep onNext={() => {}} />);
  }

  it("treats a run-level 'Unknown error' as no reason and keeps the ledger that names the step", async () => {
    mountWizard({ phase: "failed", error: "Unknown error", steps: steps(2, { status: "failed", error: "Unknown error" }) });

    const error = await screen.findByTestId("update-step-error");
    expect(error.textContent).toContain("Installing Chromium:");
    expect(error.textContent).toContain(NO_REASON);
    expect(screen.queryByTestId("update-run-error")).toBeNull();
    expect(screen.getByTestId("update-step-list")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Unknown error");
  });

  it("says a real run-level error alone, without the per-step box", async () => {
    const offline = "No internet connection. Check your WiFi and try again.";
    mountWizard({ phase: "failed", error: offline, steps: steps(0, { status: "pending" }) });

    expect(await screen.findByTestId("update-run-error")).toHaveTextContent(offline);
    expect(screen.queryByTestId("update-step-error")).toBeNull();
    expect(screen.queryByTestId("update-step-list")).toBeNull();
  });
});

describe("UpdateStepList — every row's state in words", () => {
  it("says done and waiting to a screen reader, not by colour alone", async () => {
    mount({ phase: "running", currentStepIndex: 4, steps: steps(4) });

    const rows = within(await screen.findByTestId("update-step-list")).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Completed")).toHaveClass("sr-only");
    expect(within(rows[4]).getByText("In progress")).not.toHaveClass("sr-only");
    expect(within(rows[5]).getByText("Waiting")).toHaveClass("sr-only");
  });
});
