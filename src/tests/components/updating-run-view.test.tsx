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
import { HANDOVER_MAX_MS, HANDOVER_MIN_MS } from "@/components/UpdateHandover";
import { UPDATE_COMPACT_MEDIA, UPDATE_SCREEN_MEDIA } from "@/components/UpdateRunView";
import { SHOWCASE_NARROW_PX } from "@/components/UpdateWhatsNewShowcase";

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
function stubBox(answer: () => Answer, runAnswer: () => Promise<Response> = async () => respond({ started: true })) {
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
      if (url === "/setup-api/update/run") return runAnswer();
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
    // A stopped run: the one the window still draws itself. A live one it
    // hands to this page (below).
    stubBox(() => ({ body: FAILED, locked: false }));
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
      "ClawBox is restarting and is not answering yet. This screen will return to the desktop on its own.",
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

  it("keeps a verdict the box could not clear — its Resume included — and says why beside it", async () => {
    const { fetchMock, statusPolls } = stubBox(() => ({ body: INTERRUPTED, locked: false }));
    const view = render(<UpdatingPage />);
    await advance();
    const polls = statusPolls();
    fetchMock.mockImplementationOnce(async () => respond({ error: "disk full" }, {}, 500));
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    await advance();
    expect(replace).not.toHaveBeenCalled();
    expect(view.getByTestId("update-dismiss-error")).toHaveTextContent("The device could not clear that result.");
    expect(view.getByTestId("update-error-panel")).toHaveTextContent("Updating OpenClaw");
    expect(view.getByRole("button", { name: "Resume update" })).toBeTruthy();
    // And asks the box again rather than going quiet.
    expect(statusPolls()).toBeGreaterThan(polls);
  });

  it("keeps the verdict on a Dismiss lost to the network too", async () => {
    const { fetchMock } = stubBox(() => ({ body: INTERRUPTED, locked: false }));
    const view = render(<UpdatingPage />);
    await advance();
    fetchMock.mockImplementationOnce(async () => { throw new TypeError("Failed to fetch"); });
    fireEvent.click(view.getByRole("button", { name: "Dismiss" }));
    await advance();
    expect(replace).not.toHaveBeenCalled();
    expect(view.getByTestId("update-dismiss-error")).toBeTruthy();
    expect(view.getByRole("button", { name: "Resume update" })).toBeTruthy();
  });

  it("follows the run a Resume started even when the click's own request was lost", async () => {
    let resumed = false;
    const { fetchMock } = stubBox(() => ({ body: resumed ? { phase: "running", currentStepIndex: 4, steps: steps(4) } : INTERRUPTED, locked: resumed }));
    const view = render(<UpdatingPage />);
    await advance();
    // The box takes the request and starts the run; the answer never arrives.
    fetchMock.mockImplementationOnce(async () => {
      resumed = true;
      throw new TypeError("Failed to fetch");
    });
    fireEvent.click(view.getByRole("button", { name: "Resume update" }));
    await advance();
    await advance(2_000);
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "updating");
    expect(view.getByTestId("update-step-count")).toHaveTextContent("4 / 10 steps complete");
  });

  it("does not give up on a resumed run that answers 'idle' while the lock is held", async () => {
    let resumed = false;
    stubBox(() => (resumed ? { body: IDLE } : { body: INTERRUPTED, locked: false }));
    const view = render(<UpdatingPage />);
    await advance();
    resumed = true;
    fireEvent.click(view.getByRole("button", { name: "Resume update" }));
    await advance();
    await advance(60_000);
    expect(view.queryByText("Failed to start update")).toBeNull();
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "updating");
    expect(replace).not.toHaveBeenCalled();
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

  it("starts the budget again for a run the owner resumes from here", async () => {
    let resumed = false;
    stubBox(() => ({ body: resumed ? { phase: "running", currentStepIndex: 4, steps: steps(4) } : INTERRUPTED, locked: resumed }));
    const view = render(<UpdatingPage />);
    await advance();
    // The verdict sat on screen past the budget.
    await advance(26 * 60_000);
    resumed = true;
    fireEvent.click(view.getByRole("button", { name: "Resume update" }));
    await advance();
    await advance(2_000);
    expect(view.getByTestId("update-run-notice")).not.toHaveAttribute("data-tone");
    expect(view.getByTestId("update-run-notice")).toHaveTextContent("Don't power off until this finishes.");
    await advance(25 * 60_000);
    expect(view.getByTestId("update-run-notice")).toHaveAttribute("data-tone", "warn");
  });

  it("says restart, not 'returning to the desktop', when a finished run's lock is never released", async () => {
    stubBox(() => ({ body: COMPLETED }));
    const view = render(<UpdatingPage />);
    await advance();
    expect(view.getByTestId("update-run-notice")).toHaveTextContent("Returning to the desktop");
    await advance(25 * 60_000 + 2_000);
    const notice = view.getByTestId("update-run-notice");
    expect(notice).toHaveAttribute("data-tone", "warn");
    expect(notice).toHaveTextContent(/restart it/);
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

/**
 * TASK-2137: on a computer's screen the run fills the window top to bottom —
 * no band of nothing under a 1200 px column on a 16:9 screen — and a phone, a
 * tablet held upright or a 1024 px window keeps the layout it had. jsdom lays
 * nothing out, so these pin the contract the CSS keeps; the sizes themselves
 * were measured in a real browser at 1280×720 up to 3840×2160.
 */
describe("/updating fills a computer's screen", () => {
  /** The full-screen layout's CSS (UPDATE_SCREEN_CSS), wherever it is drawn. */
  const screenStyle = () => [...document.querySelectorAll("style")].find((style) => style.textContent?.includes(".us-grid")) ?? null;

  it("lays a live run out for the whole screen, and only where the showcase beside the steps is wide", async () => {
    stubBox(() => ({ body: RUNNING }));
    const view = render(<UpdatingPage />);
    await advance();

    expect(view.getByTestId("updating-screen")).toHaveAttribute("data-update-screen", "updating");
    const run = view.getByTestId("update-run");
    expect(run).toHaveAttribute("data-fill", "true");
    const style = screenStyle();
    expect(style).not.toBeNull();
    // Beside the run view, never in it: the view's text stays the window's.
    expect(run.contains(style)).toBe(false);

    // Every rule is inside the one media query: below it nothing changes.
    const css = style!.textContent!.trim();
    expect(css.startsWith(`@media ${UPDATE_SCREEN_MEDIA}{`)).toBe(true);
    let depth = 0;
    let closed = -1;
    for (let i = 0; i < css.length && closed < 0; i++) {
      if (css[i] === "{") depth++;
      if (css[i] === "}" && --depth === 0) closed = i;
    }
    expect(closed).toBe(css.length - 1);

    // From its first width, the column the steps leave the showcase is wide
    // enough for its wide layout (the one the full-screen rules size).
    const minWidth = Number(/min-width: (\d+)px/.exec(UPDATE_SCREEN_MEDIA)?.[1]);
    const margin = Number(/\.us-page\{[^}]*padding:calc\(\d+\*var\(--update-px\)\) calc\((\d+)\*/.exec(css)?.[1]);
    const stepsColumn = Number(/\.us-grid\{[^}]*grid-template-columns:minmax\(0,calc\((\d+)\*/.exec(css)?.[1]);
    const gap = Number(/\.us-grid\{[^}]*column-gap:calc\((\d+)\*/.exec(css)?.[1]);
    expect(minWidth - 2 * margin - stepsColumn - gap).toBeGreaterThanOrEqual(SHOWCASE_NARROW_PX);
    expect(UPDATE_SCREEN_MEDIA).toContain("(min-height: 720px)");
  });

  it("gives a finished run a scale of its own, with room for Dismiss and the Agent card", async () => {
    stubBox(() => ({ body: COMPLETED }));
    const view = render(<UpdatingPage />);
    await advance();

    expect(view.getByTestId("updating-screen")).toHaveAttribute("data-update-screen", "completed");
    expect(view.getByTestId("update-run")).toHaveAttribute("data-fill", "true");
    expect(screenStyle()?.textContent).toMatch(/\[data-update-screen="completed"\]\{--update-px:/);
  });

  it("keeps the window's layout for a stopped run", async () => {
    stubBox(() => ({ body: FAILED }));
    const view = render(<UpdatingPage />);
    await advance();

    expect(view.getByTestId("updating-screen")).toHaveAttribute("data-update-screen", "failed");
    expect(view.getByTestId("update-run")).not.toHaveAttribute("data-fill");
    expect(screenStyle()).toBeNull();
    expect(document.querySelector("style[data-update-compact]")).toBeNull();
  });

  it("never fills the System Update window", async () => {
    // A finished run, which the window draws when it is still open to see it.
    let clicked = false;
    stubBox(() => (clicked ? { body: COMPLETED } : { body: IDLE, locked: false }));
    const app = render(<SystemUpdateApp />);
    await advance();
    clicked = true;
    fireEvent.click(app.getByRole("button", { name: "Update everything" }));
    await advance(2_000);

    expect(app.getByTestId("update-run")).toHaveAttribute("data-status", "completed");
    expect(app.getByTestId("update-run")).not.toHaveAttribute("data-fill");
    expect(screenStyle()).toBeNull();
    expect(document.querySelector("style[data-update-compact]")).toBeNull();
  });
});

/**
 * TASK-2146: on a computer's window too small for the steps and the showcase
 * side by side — measured at 1030×700, where the last steps went under the
 * "Don't power off" bar and the showcase was cut off — the run is the steps
 * alone. jsdom lays nothing out: these pin the contract; the sizes were
 * measured in a real browser from 800×600 to 2560×1440.
 */
describe("/updating in a window too small for both columns", () => {
  const compactStyle = () => document.querySelector<HTMLStyleElement>("style[data-update-compact]");
  const px = (media: string, feature: string) => [...media.matchAll(new RegExp(`\\(${feature}: ([\\d.]+)px\\)`, "g"))].map((m) => Number(m[1]));

  it("draws the steps alone there, beside the view, for a live run and a finished one", async () => {
    for (const body of [RUNNING, COMPLETED]) {
      stubBox(() => ({ body }));
      const view = render(<UpdatingPage />);
      await advance();
      const style = compactStyle();
      expect(style).not.toBeNull();
      expect(view.getByTestId("update-run").contains(style)).toBe(false);
      const css = style!.textContent!.trim();
      // One media query holds every rule.
      expect(css.startsWith(`@media ${UPDATE_COMPACT_MEDIA}{`)).toBe(true);
      expect(css.indexOf("@media", 1)).toBe(-1);
      // What's new is what goes; the steps and the bar stay.
      expect(css).toContain("[data-update-screen] .us-show{display:none}");
      expect(css).not.toMatch(/\.us-(steps|bar|head)\{[^}]*display:none/);
      view.unmount();
    }
  });

  it("takes exactly the computer windows the full-screen layout leaves out, and no phone", () => {
    const [fillWidth] = px(UPDATE_SCREEN_MEDIA, "min-width");
    const [fillHeight] = px(UPDATE_SCREEN_MEDIA, "min-height");
    expect([fillWidth, fillHeight]).toEqual([1196, 720]);
    const queries = UPDATE_COMPACT_MEDIA.split(", ");
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      // From a tablet's width, taller than a phone held sideways.
      expect(px(query, "min-width")).toEqual([768]);
      expect(px(query, "min-height")).toEqual([501]);
    }
    // Narrower than the full screen, or shorter: never both layouts at once.
    expect(px(queries[0], "max-width")[0]).toBeLessThan(fillWidth);
    expect(px(queries[0], "max-width")[0]).toBeGreaterThan(fillWidth - 1);
    expect(px(queries[1], "max-height")[0]).toBeLessThan(fillHeight);
    expect(px(queries[1], "max-height")[0]).toBeGreaterThan(fillHeight - 1);
  });
});

/**
 * TASK-2146: Update in Settings → System Update went to /updating by way of
 * the window's own run view — "Updating your device · Connecting…" inside the
 * pane, then the same words full screen. The click now goes straight to a
 * short full-screen loader on /updating's ground, which hands over to it.
 */
describe("Update goes straight to /updating", () => {
  const RUN_ANSWER_REFUSED = async () => respond({ error: "A database maintenance pass is running" }, {}, 409);

  /** The window, idle, with an update on offer; the box answers the click with `runAnswer`. */
  async function openWindow(runAnswer?: () => Promise<Response>, embedded = false) {
    let clicked = false;
    const box = stubBox(() => (clicked ? { body: RUNNING } : { body: IDLE, locked: false }), runAnswer);
    const app = render(<div style={{ transform: "translate(40px, 40px)" }}><SystemUpdateApp embedded={embedded} /></div>);
    await advance();
    const click = () => {
      clicked = true;
      fireEvent.click(app.getByRole("button", { name: "Update everything" }));
    };
    return { app, click, ...box };
  }

  it("shows the loader over the whole screen at the click, never the window's run view, then /updating", async () => {
    const { app, click } = await openWindow();
    click();
    const loader = document.querySelector<HTMLElement>('[data-testid="update-handover"]');
    expect(loader).not.toBeNull();
    // On the page, not in the (transformed) window: `fixed` covers the screen.
    expect(loader!.parentElement).toBe(document.body);
    expect(app.container.contains(loader)).toBe(false);
    expect(loader!.className).toMatch(/\bfixed inset-0\b/);
    expect(loader!.style.zIndex).toBe("2147483647");
    expect(within(loader!).getByTestId("update-handover-logo").querySelector("img")).toHaveAttribute("src", "/clawbox-icon.png");
    expect(loader!.querySelector(".motion-safe\\:animate-spin")).not.toBeNull();
    expect(loader).toHaveAttribute("role", "status");
    expect(loader).toHaveTextContent("Updating your device");
    expect(document.querySelector('[data-testid="update-run"]')).toBeNull();

    // A moment on the loader, then the page — once, by replace.
    await advance(HANDOVER_MIN_MS - 1);
    expect(document.querySelector('[data-testid="update-run"]')).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    await advance(1);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(replace).toHaveBeenCalledWith("/updating");
    await advance(HANDOVER_MAX_MS);
    expect(replace).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-testid="update-run"]')).toBeNull();
  });

  it("does the same from Settings, whose pane embeds the window", async () => {
    const { app, click } = await openWindow(undefined, true);
    click();
    const loader = document.querySelector<HTMLElement>('[data-testid="update-handover"]');
    expect(loader?.parentElement).toBe(document.body);
    expect(app.container.contains(loader)).toBe(false);
    expect(app.queryByTestId("update-run")).toBeNull();
    await advance(HANDOVER_MIN_MS);
    expect(replace).toHaveBeenCalledWith("/updating");
  });

  it("waits for the box to take the run before it leaves", async () => {
    let answer: (res: Response) => void = () => {};
    const { click } = await openWindow(() => new Promise<Response>((resolve) => { answer = resolve; }));
    click();
    await advance(HANDOVER_MIN_MS + 2_000);
    expect(replace).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="update-handover"]')).not.toBeNull();
    answer(respond({ started: true }));
    await advance();
    expect(replace).toHaveBeenCalledWith("/updating");
  });

  it("keeps a start the box refused in the window, with its reason, and never leaves", async () => {
    const { app, click } = await openWindow(RUN_ANSWER_REFUSED);
    click();
    await advance();
    await advance(HANDOVER_MAX_MS);
    expect(replace).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="update-handover"]')).toBeNull();
    expect(app.getByTestId("update-run")).toHaveAttribute("data-status", "failed");
    expect(app.getByTestId("update-error-reason")).toHaveTextContent("A database maintenance pass is running");
    expect(app.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("asks first while agents are working (GitHub #1269): Cancel starts nothing, Update anyway sends ignoreBusy", async () => {
    const bodies: unknown[] = [];
    let anyway = false;
    const box = stubBox(
      () => (anyway ? { body: RUNNING } : { body: IDLE, locked: false }),
      async () => {
        const call = box.fetchMock.mock.calls.filter(([u]) => String(u) === "/setup-api/update/run").at(-1);
        const body = JSON.parse(String(call?.[1]?.body ?? "{}"));
        bodies.push(body);
        if (body.ignoreBusy === true) { anyway = true; return respond({ started: true }); }
        return respond({ started: false, busy: true, work: { coding: 1, agents: 1, total: 2 } }, {}, 409);
      },
    );
    const app = render(<SystemUpdateApp />);
    await advance();
    fireEvent.click(app.getByRole("button", { name: "Update everything" }));
    await advance();
    const dialog = app.getByRole("dialog");
    expect(dialog).toHaveTextContent("Agents are working right now");
    expect(dialog).toHaveTextContent("2 agent runs are active");
    expect(bodies).toEqual([{ force: true }]);
    expect(replace).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="update-handover"]')).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await advance();
    expect(app.queryByRole("dialog")).toBeNull();
    expect(bodies).toHaveLength(1);
    expect(app.getByRole("button", { name: "Update everything" })).toBeTruthy();

    fireEvent.click(app.getByRole("button", { name: "Update everything" }));
    await advance();
    fireEvent.click(within(app.getByRole("dialog")).getByRole("button", { name: "Update anyway" }));
    await advance();
    expect(bodies.at(-1)).toEqual({ force: true, ignoreBusy: true });
    expect(document.querySelector('[data-testid="update-handover"]')).not.toBeNull();
  });

  it("leaves anyway when the click's request never answers: /updating follows what the box has", async () => {
    const { click } = await openWindow(() => new Promise<Response>(() => {}));
    click();
    await advance(HANDOVER_MAX_MS - 1);
    expect(replace).not.toHaveBeenCalled();
    await advance(1);
    expect(replace).toHaveBeenCalledWith("/updating");
  });

  it("hands over a run that was already going when the window opened — a reload mid-update included", async () => {
    stubBox(() => ({ body: RUNNING }));
    const app = render(<SystemUpdateApp />);
    await advance();
    expect(document.querySelector('[data-testid="update-handover"]')).not.toBeNull();
    expect(app.queryByTestId("update-run")).toBeNull();
    await advance(HANDOVER_MIN_MS);
    expect(replace).toHaveBeenCalledWith("/updating");
  });
});

/**
 * TASK-2146: the drift the run was started over ("The code on disk (…) is not
 * the tested commit for beta (…)") is what the run is fixing. Said under the
 * steps while it ran, it read as an error.
 */
describe("/updating and the drift a run was started over", () => {
  const DRIFT = { code: "checkout-behind-pin", message: "The code on disk (673817a) is not the tested commit for beta (2153954)." };
  const OTHER = { code: "openclaw-doctor-fix-failed", message: "`openclaw doctor --fix` did not complete." };

  it("says nothing about it while the run is live, and keeps the run's other warnings", async () => {
    stubBox(() => ({ body: { ...RUNNING, warnings: [DRIFT, OTHER] } }));
    const view = render(<UpdatingPage />);
    await advance();
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "updating");
    expect(view.queryByTestId("update-warning-checkout-behind-pin")).toBeNull();
    expect(document.body.textContent).not.toContain("is not the tested commit");
    expect(view.getByTestId("update-warning-openclaw-doctor-fix-failed")).toHaveTextContent("did not complete");
  });

  it("says nothing about it while the box is restarting either", async () => {
    stubBox(inOrder({ body: { ...RUNNING, warnings: [DRIFT] } }, "down"));
    const view = render(<UpdatingPage />);
    await advance();
    await advance(2_000);
    expect(view.getByTestId("update-steps-panel")).toHaveAttribute("data-offline", "true");
    expect(document.body.textContent).not.toContain("is not the tested commit");
  });

  it("says it once the run has finished and the drift is still there", async () => {
    stubBox(inOrder({ body: { ...RUNNING, warnings: [DRIFT] } }, { body: { ...COMPLETED, warnings: [DRIFT] } }));
    const view = render(<UpdatingPage />);
    await advance();
    expect(view.queryByTestId("update-warning-checkout-behind-pin")).toBeNull();
    await advance(2_000);
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "completed");
    expect(view.getByTestId("update-warning-checkout-behind-pin")).toHaveTextContent(DRIFT.message);
  });

  it("says it on a run that stopped", async () => {
    stubBox(() => ({ body: { ...FAILED, warnings: [DRIFT] }, locked: false }));
    const view = render(<UpdatingPage />);
    await advance();
    expect(view.getByTestId("update-run")).toHaveAttribute("data-status", "failed");
    expect(view.getByTestId("update-warning-checkout-behind-pin")).toHaveTextContent(DRIFT.message);
  });
});
