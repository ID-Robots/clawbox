// `update/run` can answer 200 and still start nothing: the assistant's database
// maintenance holds the box, another run does, or the update is already done.
// The wizard's Update step read only `res.ok`, then polled; the poll saw "idle"
// and stopped while `starting` stayed set, so the step sat on "Preparing
// update..." with no button, and only a reload got the owner out. System Update
// already reads this 200; the wizard's copy of the click did not.
//
// Held here: the server's refusal is shown with Retry and Skip, a run that is
// already going is joined, and a 200 that did start a run still polls it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import UpdateStep from "@/components/UpdateStep";

vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t: (key: string) => translations.en[key] ?? key }) }));

const START = translations.en["update.startUpdate"];
const PREPARING = translations.en["update.preparingUpdate"];
const REFUSAL = "The assistant's database maintenance is running.";

const VERSIONS = {
  clawbox: { current: "v4.3.0", target: "v4.3.1", updateAvailable: true },
  openclaw: { current: "2026.10.7", target: null, updateAvailable: false },
  remote: { reachable: true },
};
const IDLE = { phase: "idle", steps: [], currentStepIndex: -1, warnings: [], versions: VERSIONS };
const RUNNING = {
  phase: "running",
  steps: [{ id: "fetch", label: "Downloading the update", status: "running" }],
  currentStepIndex: 0,
  warnings: [],
  versions: VERSIONS,
};

let runAnswer: Record<string, unknown>;
let statusAfterRun: Record<string, unknown>;
let runCalls: number;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  runCalls = 0;
  statusAfterRun = IDLE;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url === "/setup-api/update/status") {
      return { ok: true, json: async () => (runCalls > 0 ? statusAfterRun : IDLE) } as Response;
    }
    if (url === "/setup-api/update/run") {
      runCalls++;
      return { ok: true, status: 200, json: async () => runAnswer } as Response;
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function clickStartAndWait() {
  const view = render(<UpdateStep onNext={vi.fn()} />);
  fireEvent.click(await view.findByRole("button", { name: START }));
  await waitFor(() => expect(runCalls).toBe(1));
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  return view;
}

it("shows the server's refusal, with Retry and Skip, when update/run started nothing", async () => {
  runAnswer = { started: false, error: REFUSAL };
  const view = await clickStartAndWait();

  expect(view.queryByText(PREPARING)).toBeNull();
  expect(view.getByText(REFUSAL)).toBeTruthy();
  expect(view.getByText(translations.en["update.startFailed"])).toBeTruthy();
  expect(view.getByRole("button", { name: translations.en["update.skipUpdates"] })).toBeTruthy();

  // Retry re-reads the status and offers the Start button again.
  fireEvent.click(view.getByRole("button", { name: translations.en.retry }));
  expect(await view.findByRole("button", { name: START })).toBeTruthy();
  expect(view.queryByText(REFUSAL)).toBeNull();
});

it("joins the run that is already going when update/run says it started nothing", async () => {
  runAnswer = { started: false, error: "Update already in progress" };
  statusAfterRun = RUNNING;
  const view = await clickStartAndWait();

  expect(view.queryByText(PREPARING)).toBeNull();
  expect(view.getAllByText("Downloading the update").length).toBeGreaterThan(0);
});

it("still polls the run a 200 {started:true} began", async () => {
  runAnswer = { started: true };
  statusAfterRun = RUNNING;
  const view = await clickStartAndWait();

  expect(view.getAllByText("Downloading the update").length).toBeGreaterThan(0);
});
