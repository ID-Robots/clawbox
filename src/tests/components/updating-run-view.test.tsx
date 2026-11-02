import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { act, fireEvent, render, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import { RESTART_STEP_ID, UPDATE_LOCK_HEADER } from "@/lib/update-constants";
import { releasePageUrl, UPDATE_WHATS_NEW_ENDPOINT, type UpdateWhatsNew } from "@/lib/update-whats-new";
import type { StepState, UpdateState } from "@/lib/updater";

/**
 * TASK-2111: the update screen is ONE screen, from the click to the desktop.
 *
 * The owner starts a run in Settings → System Update and watches its run view;
 * seconds later the desktop's notice poll and the middleware send them to
 * /updating, for the rest of the update. /updating used to be an older wait
 * screen of its own. It now draws the same run view and follows the run with
 * the same poll — and keeps every guarantee it documents: it fails closed
 * while the web server is down, names the restart escape once the run has
 * outlasted its budget, says what is true, and goes back to the desktop when
 * the lock is released (not before, which would only bounce).
 */

let locale: "en" | "de" = "en";

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    locale,
    localeResolved: true,
    setLocale: vi.fn(),
    t: (key: string, params?: Record<string, string | number>) => {
      let str = translations[locale][key] ?? key;
      if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
      return str;
    },
  }),
}));

import UpdatingPage from "@/app/updating/page";
import SystemUpdateApp from "@/components/SystemUpdateApp";

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

const RUNNING: Partial<UpdateState> = {
  phase: "running",
  currentStepIndex: 7,
  steps: steps(7, { status: "running", detail: "Building the web app" }),
};
const POST_RESTART: Partial<UpdateState> = { phase: "running", currentStepIndex: 8, steps: steps(8) };
const COMPLETED: Partial<UpdateState> = { phase: "completed", currentStepIndex: -1, steps: steps(10) };
const IDLE: Partial<UpdateState> = { phase: "idle", currentStepIndex: -1, steps: steps(0, { status: "pending" }) };
const INTERRUPTED: Partial<UpdateState> = {
  phase: "failed",
  currentStepIndex: -1,
  error: "The update was interrupted before it could finish: the box restarted — or lost power — while "
    + "\"Updating OpenClaw\" was running. Nothing was rolled back — Resume continues the update from there.",
  steps: steps(4, { status: "failed" }),
};
const FAILED: Partial<UpdateState> = {
  phase: "failed",
  currentStepIndex: -1,
  error: "chromium_install exited with code 100",
  steps: steps(2, { status: "failed", error: "apt could not reach the mirror" }),
};

/** A beta box on its release's version: the row names the build being installed. */
const VERSIONS = {
  clawbox: { current: "4.3.0", target: "beta@a2c1718", updateAvailable: true },
  openclaw: { current: "2026.10.7", target: "2026.10.7", updateAvailable: false },
  edition: "openclaw",
  remote: { reachable: true },
};
const WHATS_NEW: UpdateWhatsNew = {
  version: "4.3.0",
  channel: "beta",
  source: "none",
  highlights: [],
  releaseUrl: releasePageUrl("4.3.0"),
};

/** What the box answers the status poll: a body (with the lock still marked unless `locked: false`), or nothing. */
type Answer = { body: Partial<UpdateState>; locked?: boolean } | "down";

function respond(body: unknown, headers: Record<string, string> = {}, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json", ...headers }),
    json: async () => body,
  } as unknown as Response;
}

/**
 * The box. `answer()` is asked for every status poll; everything else the
 * screens ask for is answered as a healthy box would.
 */
function stubBox(answer: () => Answer) {
  const posts: string[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/setup-api/update/status")) {
      const a = answer();
      if (a === "down") throw new TypeError("Failed to fetch");
      return respond(
        { currentStepIndex: -1, steps: [], ...a.body },
        a.locked === false ? {} : { [UPDATE_LOCK_HEADER]: "1" },
      );
    }
    if (url.startsWith("/setup-api/update/versions")) return respond(VERSIONS);
    if (url.startsWith("/setup-api/system/update-branch")) return respond({ branch: "beta", effective: { branch: "beta", source: "pin-file" } });
    if (url === UPDATE_WHATS_NEW_ENDPOINT) return respond(WHATS_NEW);
    if (init?.method === "POST") {
      posts.push(url);
      if (url === "/setup-api/update/run") return respond({ started: true });
      if (url === "/setup-api/update/dismiss") return respond({ ok: true });
    }
    return respond({});
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, posts, statusPolls: () => fetchMock.mock.calls.filter(([u]) => String(u).startsWith("/setup-api/update/status")).length };
}

/** Answers in order, the last one for ever. */
function inOrder(...answers: Answer[]): () => Answer {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)];
}

/** Let the clock run `ms`, settling every fetch and render on the way. */
async function advance(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

let replace: ReturnType<typeof vi.fn>;
let reload: ReturnType<typeof vi.fn>;
let savedLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  locale = "en";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  savedLocation = Object.getOwnPropertyDescriptor(window, "location");
  const real = window.location;
  replace = vi.fn();
  reload = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: `${real.origin}/updating`, origin: real.origin, pathname: "/updating", search: "", hash: "", replace, reload, assign: vi.fn() },
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (savedLocation) Object.defineProperty(window, "location", savedLocation);
  vi.unstubAllGlobals();
});

describe("/updating draws the System Update run view", () => {
  it("shows the run as the run view: title, versions, numbered steps, What's new, and 'don't power off'", async () => {
    stubBox(() => ({ body: RUNNING }));
    const view = render(<UpdatingPage />);
    await advance();

    const run = view.getByTestId("update-run");
    expect(run).toHaveAttribute("data-status", "updating");
    expect(within(run).getByRole("heading", { level: 1, name: "Updating your device" })).toBeTruthy();
    expect(within(run).getByTestId("update-step-count")).toHaveTextContent("7 / 10 steps complete");
    // The step the box is on, by name, with the line it last logged.
    expect(within(run).getAllByText("Updating ClawBox and restarting").length).toBeGreaterThan(0);
    expect(within(run).getByTestId("update-step-detail")).toHaveTextContent("Building the web app");
    // The version row of the run view: `v4.3.0 → beta@a2c1718`, on the beta channel.
    const versions = within(run).getByTestId("update-run-versions");
    expect(versions).toHaveTextContent("v4.3.0");
    expect(versions).toHaveTextContent("beta@a2c1718");
    expect(within(versions).getByTestId("update-run-channel")).toHaveTextContent("beta channel");
    expect(within(run).getByRole("region", { name: "What's new in ClawBox 4.3.0" })).toBeTruthy();
    expect(within(run).getByTestId("update-run-notice")).toHaveTextContent("Don't power off until this finishes.");
    // Not the older wait screen.
    expect(view.queryByTestId("reconnect-stage-with-aside")).toBeNull();
    expect(document.querySelector("[data-testid^='reconnect-stage']")).toBeNull();
  });

  it("is the System Update app's own run view, word for word", async () => {
    stubBox(() => ({ body: RUNNING }));
    const page = render(<UpdatingPage />);
    await advance();
    const onPage = page.getByTestId("update-run").textContent;
    page.unmount();

    const app = render(<SystemUpdateApp />);
    await advance();
    expect(app.getByTestId("update-run").textContent).toBe(onPage);
  });

  it("holds the screen while the web server is down, and claims no progress it cannot see", async () => {
    const { statusPolls } = stubBox(inOrder({ body: RUNNING }, "down"));
    const view = render(<UpdatingPage />);
    await advance();
    expect(view.getByTestId("update-step-detail")).toBeTruthy();

    // The rebuild stops the server, for minutes.
    await advance(2_000);
    const panel = view.getByTestId("update-steps-panel");
    expect(panel).toHaveAttribute("data-offline", "true");
    expect(within(panel).getByText("Restarting — not answering yet")).toBeTruthy();
    // The progress last seen stays; the line the step last logged does not.
    expect(within(panel).getByTestId("update-step-count")).toHaveTextContent("7 / 10 steps complete");
    expect(view.queryByTestId("update-step-detail")).toBeNull();
    expect(view.getByTestId("update-run-notice")).toHaveTextContent(
      "The device is restarting and is not answering yet. This screen will return to the desktop on its own.",
    );

    await advance(5 * 60_000);
    expect(statusPolls()).toBeGreaterThan(100);
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "updating");
    expect(replace).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("reloads onto the new build on the first answer that names the run after an outage — not on 'idle'", async () => {
    stubBox(inOrder({ body: RUNNING }, "down", "down", "down", { body: IDLE }, { body: POST_RESTART }));
    render(<UpdatingPage />);
    await advance();
    await advance(3 * 2_000);
    // "idle" from the server that came back is no verdict: no reload over it.
    await advance(2_000);
    expect(reload).not.toHaveBeenCalled();
    // While the answer is "idle" the box is asked every 10 s.
    await advance(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
  });

  it("goes back to the desktop when the run completes and the lock is released — not before", async () => {
    stubBox(inOrder(
      { body: RUNNING },
      { body: COMPLETED },
      { body: COMPLETED },
      { body: COMPLETED, locked: false },
    ));
    const view = render(<UpdatingPage />);
    await advance();

    // Completed, but the middleware still holds the lock: the desktop would
    // only send the owner straight back here.
    await advance(2_000);
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "completed");
    expect(view.getByRole("heading", { level: 1, name: "Update complete" })).toBeTruthy();
    expect(view.getByTestId("update-run-notice")).toHaveTextContent("Update complete. Returning to the desktop…");
    await advance(2_000);
    await advance(2_900);
    expect(replace).not.toHaveBeenCalled();

    // The answer without the lock: a moment on "Update complete", then the desktop.
    await advance(100);
    await advance(2_000);
    expect(replace).not.toHaveBeenCalled();
    await advance(1_000);
    expect(replace).toHaveBeenCalledWith("/");
    expect(reload).not.toHaveBeenCalled();
  });

  it("goes back at once when no run is going and the lock is gone", async () => {
    stubBox(() => ({ body: IDLE, locked: false }));
    render(<UpdatingPage />);
    await advance();
    await advance(0);
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("stays while the lock is held, even with no run in this server's memory", async () => {
    stubBox(() => ({ body: IDLE }));
    const view = render(<UpdatingPage />);
    await advance();
    await advance(60_000);
    expect(replace).not.toHaveBeenCalled();
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "updating");
  });

  it("shows an interrupted run's verdict with Resume, and follows the run Resume starts", async () => {
    let resumed = false;
    const { posts } = stubBox(() => ({ body: resumed ? { phase: "running", currentStepIndex: 4, steps: steps(4) } : INTERRUPTED, locked: resumed }));
    const view = render(<UpdatingPage />);
    await advance();

    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "failed");
    expect(view.getByTestId("update-error-panel")).toHaveTextContent("Updating OpenClaw");
    expect(view.getAllByText(/Resume continues the update from there/).length).toBeGreaterThan(0);
    // A stopped run is not a reason to leave: the owner has something to decide.
    expect(replace).not.toHaveBeenCalled();

    resumed = true;
    fireEvent.click(view.getByRole("button", { name: "Resume update" }));
    await advance();
    expect(posts).toEqual(["/setup-api/update/run"]);
    await advance(2_000);
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "updating");
    expect(view.getByTestId("update-step-count")).toHaveTextContent("4 / 10 steps complete");
    expect(replace).not.toHaveBeenCalled();
  });

  it("offers no Resume for a failure with a cause of its own; Dismiss clears it and goes to the desktop", async () => {
    const { posts } = stubBox(() => ({ body: FAILED, locked: false }));
    const view = render(<UpdatingPage />);
    await advance();

    expect(view.getByTestId("update-error-panel")).toHaveTextContent("Installing Chromium");
    expect(view.getByTestId("update-error-reason")).toHaveTextContent("apt could not reach the mirror");
    expect(view.queryByRole("button", { name: /Resume|again/ })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    await advance();
    expect(posts).toEqual(["/setup-api/update/dismiss"]);
    expect(replace).toHaveBeenCalledWith("/");
  });

  it("stays, and says so, when the box could not clear the result", async () => {
    const { fetchMock } = stubBox(() => ({ body: FAILED, locked: false }));
    const view = render(<UpdatingPage />);
    await advance();
    fetchMock.mockImplementationOnce(async () => respond({ error: "disk full" }, {}, 500));
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    await advance();
    expect(replace).not.toHaveBeenCalled();
    expect(view.getByTestId("update-error-panel")).toHaveTextContent("The device could not clear that result.");
  });

  it("names the restart escape once the run has outlasted its budget, and offers no link the lock would bounce", async () => {
    stubBox(() => ({ body: RUNNING }));
    const view = render(<UpdatingPage />);
    await advance();
    expect(view.getByTestId("update-run-notice")).not.toHaveAttribute("data-tone");

    await advance(25 * 60_000 + 2_000);
    const notice = view.getByTestId("update-run-notice");
    expect(notice).toHaveAttribute("data-tone", "warn");
    expect(notice).toHaveTextContent(/restart it — the desktop unlocks by itself on the next start/);
    expect(document.querySelector('a[href="/"]')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it("renders the run view on the server, so a chunk that loses the race to the outage still leaves words", () => {
    stubBox(() => "down");
    const html = renderToString(<UpdatingPage />);
    expect(html).toContain("System Update");
    expect(html).toContain("Updating your device");
    expect(html).toContain("Connecting…");
    expect(html).toContain("Don&#x27;t power off until this finishes.");
    expect(html).not.toContain("update.");
  });

  it("speaks the owner's language, the new lines included", async () => {
    locale = "de";
    stubBox(inOrder({ body: RUNNING }, "down"));
    const view = render(<UpdatingPage />);
    await advance();
    expect(view.getByRole("heading", { level: 1, name: translations.de["update.heroUpdating"] })).toBeTruthy();
    await advance(2_000);
    expect(view.getByText(translations.de["update.notAnswering"])).toBeTruthy();
    expect(view.getByTestId("update-run-notice")).toHaveTextContent(translations.de["update.offlineHint"]);
    expect(document.body.textContent).not.toMatch(/\bupdate\.[a-zA-Z]/);
  });
});
