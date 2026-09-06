/**
 * The Coding Agent's first-run wizard (src/components/CodingAgentSetupWizard.tsx),
 * and in particular the browser step it grew: GitHub, the project folder,
 * WHICH BROWSER a run verifies its work in, then the offered test run.
 *
 * What is pinned here is the step's promise. Enable records the owner's answer
 * and then makes it true — installing Chromium only when the device says it is
 * missing, and opening the window — while Skip records the other answer. And
 * neither button may strand the owner: this is a four-step flow whose last
 * step is only reachable from this one, so a failure that left both buttons
 * refusing would mean closing the window and starting again.
 *
 * The real English strings are used throughout, so a missing key fails here
 * rather than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSetupWizard from "@/components/CodingAgentSetupWizard";
import type { AgentStatus } from "@/components/CodingAgentSettingsPanel";

// One stable `t`, as the real hook provides — a fresh function per render
// would be a different contract.
const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t }),
}));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const STATUS: AgentStatus = {
  setupComplete: false,
  enabled: false,
  ready: true,
  readiness: {
    ready: true,
    wrapperInstalled: true,
    claudeInstalled: true,
    clawaiConnected: true,
    capabilityDropAvailable: true,
    problems: [],
  },
  running: 0,
  defaultDirectory: null,
  suggestedDirectory: "/home/clawbox/Projects",
  effort: "ultracode",
  effortLevels: ["low", "max", "ultracode"],
  subagents: true,
  maxTurns: 150,
  minMaxTurns: 10,
  maxMaxTurns: 2000,
  tokenLimit: null,
  minTokenLimit: 10_000,
  reviewPass: true,
};

let calls: { url: string; body: unknown }[];

/**
 * The device, as far as this wizard can tell.
 *
 * `chromiumInstalled: false` is the fresh box: the manage route answers the
 * open with its own `chromium_not_installed` code, which is how this step
 * learns it has an install to do — it never probes for one.
 */
function stubDevice(
  opts: {
    chromiumInstalled?: boolean;
    installFails?: boolean;
    /** The window refuses to open even with Chromium present — the snap
     *  build, which no system service can start. */
    openFails?: boolean;
    /** The coding-agent route refuses the preference write itself. */
    settingFails?: boolean;
  } = {},
) {
  calls = [];
  let installed = opts.chromiumInstalled ?? true;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "POST") calls.push({ url, body });

    if (url.startsWith("/setup-api/coding-agent/git")) return json({ installed: true, connected: false, login: null, loginCommand: "gh auth login" });
    if (url === "/setup-api/coding-agent/enable") {
      if (opts.settingFails && body && "realBrowser" in body) {
        return json({ error: "Changing the coding agent settings needs a signed-in browser session." }, 403);
      }
      return json({ ok: true });
    }
    if (url === "/setup-api/browser/manage") {
      if (body?.action === "install-chromium") {
        if (opts.installFails) return json({ error: "Failed to install Chromium: no mirror" }, 500);
        installed = true;
        return json({ ok: true });
      }
      if (body?.action === "open-browser") {
        if (!installed) return json({ error: "Chromium not installed", code: "chromium_not_installed" }, 400);
        if (opts.openFails) {
          return json({ error: "Only the snap build of Chromium is installed…", code: "chromium_not_service_safe" }, 400);
        }
        return json({ ok: true });
      }
    }
    return json({ error: `unexpected ${url}` }, 404);
  }));
}

/** The actions posted to the manage route, in the order they were sent. */
const browserActions = () =>
  calls.filter((c) => c.url === "/setup-api/browser/manage").map((c) => (c.body as { action: string }).action);

/** What the wizard wrote about the browser, if anything. */
const browserSettings = () =>
  calls
    .filter((c) => c.url === "/setup-api/coding-agent/enable" && c.body !== undefined && "realBrowser" in (c.body as object))
    .map((c) => c.body);

/** Walk the wizard as an owner does, up to the browser step. */
async function reachBrowserStep() {
  render(<CodingAgentSetupWizard status={STATUS} onDone={vi.fn()} />);
  fireEvent.click(screen.getByTestId("coding-agent-wizard-enable"));
  fireEvent.click(await screen.findByTestId("coding-agent-wizard-next"));
  fireEvent.click(await screen.findByTestId("coding-agent-wizard-next-harness"));
  await screen.findByTestId("coding-agent-wizard-browser-enable");
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the browser step", () => {
  it("sits between the project folder and the test run, as one of four", async () => {
    stubDevice();
    await reachBrowserStep();
    expect(screen.getByText(t("codingAgent.wizardStepOf", { n: 3, total: 4 }))).toBeInTheDocument();
    expect(screen.getByText(translations.en["codingAgent.wizardBrowserTitle"])).toBeInTheDocument();
    // The step says what the owner will SEE, which is the whole difference
    // between the two answers.
    expect(screen.getByText(translations.en["codingAgent.wizardBrowserHint"])).toBeInTheDocument();
    // Nothing is written by arriving here.
    expect(browserSettings()).toEqual([]);
    expect(browserActions()).toEqual([]);
  });

  it("records the answer and opens the device's own window", async () => {
    stubDevice();
    await reachBrowserStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-enable"));

    await waitFor(() => expect(browserSettings()).toEqual([{ realBrowser: true }]));
    await waitFor(() => expect(browserActions()).toEqual(["open-browser"]));
    // And on to the last step, which is where the flow ends.
    expect(await screen.findByTestId("coding-agent-wizard-harness-run")).toBeInTheDocument();
    expect(screen.getByText(t("codingAgent.wizardStepOf", { n: 4, total: 4 }))).toBeInTheDocument();
  });

  it("installs Chromium only when the box answers that it has none", async () => {
    // The refusal IS the probe: a status read before every open would cost
    // each box a round trip to learn what all but a fresh one already answer.
    stubDevice({ chromiumInstalled: false });
    await reachBrowserStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-enable"));

    await waitFor(() => expect(browserActions()).toEqual(["open-browser", "install-chromium", "open-browser"]));
    expect(await screen.findByTestId("coding-agent-wizard-harness-run")).toBeInTheDocument();
  });

  it("keeps the answer and offers a way on when the window will not open", async () => {
    // The setting is the owner's answer to a question; a Chromium that cannot
    // be started today must not turn it into "no" — a run falls back to the
    // invisible browser by itself. And the last step is reachable from nowhere
    // else, so a failure that left both buttons refusing would be a dead end.
    stubDevice({ openFails: true });
    await reachBrowserStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-enable"));

    await waitFor(() => expect(browserSettings()).toEqual([{ realBrowser: true }]));
    expect(await screen.findByText(translations.en["browser.errorNotServiceSafe"])).toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-wizard-browser-enable")).toBeEnabled();

    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-continue"));
    expect(await screen.findByTestId("coding-agent-wizard-harness-run")).toBeInTheDocument();
  });

  it("offers the way on when the setting itself is refused, and never opens a window it did not record", async () => {
    stubDevice({ settingFails: true });
    await reachBrowserStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-enable"));

    expect(await screen.findByText(/signed-in browser session/)).toBeInTheDocument();
    expect(browserActions()).toEqual([]);

    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-continue"));
    expect(await screen.findByTestId("coding-agent-wizard-harness-run")).toBeInTheDocument();
  });

  it("skips by recording the other answer, without touching the screen", async () => {
    stubDevice();
    await reachBrowserStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-skip"));

    await waitFor(() => expect(browserSettings()).toEqual([{ realBrowser: false }]));
    // Skip is an ANSWER, not a deferral: nothing is launched, and the owner
    // still lands on the last step.
    expect(browserActions()).toEqual([]);
    expect(await screen.findByTestId("coding-agent-wizard-harness-run")).toBeInTheDocument();
  });
});
