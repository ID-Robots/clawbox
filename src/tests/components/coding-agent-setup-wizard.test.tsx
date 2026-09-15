/**
 * The Coding Agent's first-run wizard (src/components/CodingAgentSetupWizard.tsx),
 * and in particular the two steps it grew: GitHub, the IMPROVEMENT PROGRAM,
 * the project folder, WHICH BROWSER a run verifies its work in, then the
 * offered test run.
 *
 * What is pinned here is the step's promise. Enable records the owner's answer
 * and then makes it true — installing Chromium only when the device says it is
 * missing, and opening the window — while Skip records the other answer. And
 * neither button may strand the owner: this is a five-step flow whose last
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
    /** The Improvement Program route refuses the mode write. */
    improvementFails?: boolean;
    /** The mode the box already holds; `off` is its stored default. */
    improvementMode?: "off" | "ask" | "auto";
    /** Whether the box holds an ANSWER; defaults to true for ask/auto, false otherwise. */
    answered?: boolean;
    /** Holds the Improvement Program GET until it settles — a read that lands late. */
    holdImprovementRead?: Promise<void>;
    /**
     * The ClawBox AI account this box is on. The wizard's first step is behind
     * the paid-plan gate (owner's decision, 2026-09-14), so the default here is
     * a paid plan; "free" and "none" are the two refusals.
     */
    plan?: "flash" | "pro" | "free" | "none";
  } = {},
) {
  calls = [];
  let installed = opts.chromiumInstalled ?? true;
  let improvementMode: string = opts.improvementMode ?? "off";
  let improvementAnswered = opts.answered ?? (opts.improvementMode === "ask" || opts.improvementMode === "auto");
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (init?.method === "POST") calls.push({ url, body });

    if (url === "/setup-api/ai-models/status") {
      const plan = opts.plan ?? "flash";
      return json({
        clawaiConfigured: plan !== "none",
        clawaiAccountTier: plan === "flash" || plan === "pro" ? plan : null,
      });
    }
    if (url.startsWith("/setup-api/coding-agent/git")) return json({ installed: true, connected: false, login: null, loginCommand: "gh auth login" });
    // The Improvement Program: read on mount for the daily cap and any answer
    // the box already holds, written once on the step's Next.
    if (url === "/setup-api/improvement-program") {
      if (init?.method === "POST") {
        if (opts.improvementFails) {
          return json({ error: "Changing the Improvement Program needs a signed-in browser session.", code: "owner_only" }, 403);
        }
        improvementMode = body.mode;
        improvementAnswered = true;
      } else if (opts.holdImprovementRead) {
        await opts.holdImprovementRead;
      }
      return json({
        mode: improvementMode, answered: improvementAnswered, repo: "ID-Robots/clawbox", pending: 0, reported: 0, total: 0,
        maxIssuesPerDay: 5, remainingToday: 5,
        github: { installed: true, connected: false, login: null }, incidents: [],
      });
    }
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

/** What the wizard wrote to the Improvement Program, if anything. */
const improvementWrites = () =>
  calls.filter((c) => c.url === "/setup-api/improvement-program").map((c) => c.body);

/** What the wizard wrote about the browser, if anything. */
const browserSettings = () =>
  calls
    .filter((c) => c.url === "/setup-api/coding-agent/enable" && c.body !== undefined && "realBrowser" in (c.body as object))
    .map((c) => c.body);

/** Walk the wizard as an owner does, up to the improvement step. */
async function reachImprovementStep() {
  render(<CodingAgentSetupWizard status={STATUS} onDone={vi.fn()} />);
  // The first step is behind the paid-plan gate, and the gate's own poll has
  // to answer before the button is anything but disabled — the hook starts
  // every mount at "not signed in" and only the first tick settles it.
  const enable = screen.getByTestId("coding-agent-wizard-enable");
  await waitFor(() => expect(enable).not.toBeDisabled());
  fireEvent.click(enable);
  fireEvent.click(await screen.findByTestId("coding-agent-wizard-next"));
  await screen.findByTestId("coding-agent-wizard-improvement-next");
}

/** ...and on to the browser step, past the programme and the folder. */
async function reachBrowserStep() {
  await reachImprovementStep();
  fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-next"));
  fireEvent.click(await screen.findByTestId("coding-agent-wizard-next-harness"));
  await screen.findByTestId("coding-agent-wizard-browser-enable");
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe("the improvement step", () => {
  it("sits between GitHub and the project folder, as the second of five, with Automatic proposed", async () => {
    stubDevice();
    await reachImprovementStep();
    expect(screen.getByText(t("codingAgent.wizardStepOf", { n: 2, total: 5 }))).toBeInTheDocument();
    expect(screen.getByText(translations.en["codingAgent.wizardImprovementTitle"])).toBeInTheDocument();
    // The consent is the two lists, in the settings card's own words.
    expect(screen.getByText(translations.en["improvement.sends1"])).toBeInTheDocument();
    expect(screen.getByText(translations.en["improvement.never3"])).toBeInTheDocument();
    // Automatic is the WIZARD's proposal; the stored default is still off.
    expect(screen.getByTestId("coding-agent-wizard-improvement-auto")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("coding-agent-wizard-improvement-ask")).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("coding-agent-wizard-improvement-off")).toHaveAttribute("aria-checked", "false");
    // The daily cap the box enforces is the number the hint names.
    expect(screen.getByText(t("improvement.modeAutoHint", { n: 5 }))).toBeInTheDocument();
    // Nothing is written by arriving here, and there is no Skip: Next with
    // Off chosen is the way to decline.
    expect(improvementWrites()).toEqual([]);
    expect(screen.queryByText(translations.en["codingAgent.wizardSkip"])).toBeNull();
  });

  it("writes Automatic on Next and moves on to the project folder", async () => {
    stubDevice();
    await reachImprovementStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-next"));

    await waitFor(() => expect(improvementWrites()).toEqual([{ mode: "auto" }]));
    expect(await screen.findByTestId("coding-agent-wizard-folder")).toBeInTheDocument();
    expect(screen.getByText(t("codingAgent.wizardStepOf", { n: 3, total: 5 }))).toBeInTheDocument();
  });

  it("declines by writing Off explicitly, rather than by writing nothing", async () => {
    stubDevice();
    await reachImprovementStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-off"));
    expect(screen.getByTestId("coding-agent-wizard-improvement-off")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-next"));

    await waitFor(() => expect(improvementWrites()).toEqual([{ mode: "off" }]));
    expect(await screen.findByTestId("coding-agent-wizard-folder")).toBeInTheDocument();
  });

  it("goes back to GitHub without writing, and is where the folder step's Back lands", async () => {
    stubDevice();
    await reachImprovementStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-back"));
    expect(await screen.findByTestId("coding-agent-wizard-next")).toBeInTheDocument();
    expect(screen.getByText(t("codingAgent.wizardStepOf", { n: 1, total: 5 }))).toBeInTheDocument();
    expect(improvementWrites()).toEqual([]);

    // Forward again, through the step, then Back from the folder.
    fireEvent.click(screen.getByTestId("coding-agent-wizard-next"));
    fireEvent.click(await screen.findByTestId("coding-agent-wizard-improvement-next"));
    await screen.findByTestId("coding-agent-wizard-folder");
    fireEvent.click(screen.getByText(translations.en["codingAgent.wizardBack"]));
    expect(await screen.findByTestId("coding-agent-wizard-improvement-next")).toBeInTheDocument();
    // Only Next writes: coming back does not.
    expect(improvementWrites()).toEqual([{ mode: "auto" }]);
  });

  it("stays put and shows the route's own words when the write is refused", async () => {
    stubDevice({ improvementFails: true });
    await reachImprovementStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-next"));

    expect(await screen.findByText(/signed-in browser session/)).toBeInTheDocument();
    // Still on the step, its buttons live again — not on the folder: an
    // answer the box did not record is not an answer.
    expect(screen.getByTestId("coding-agent-wizard-improvement-next")).toBeEnabled();
    expect(screen.queryByTestId("coding-agent-wizard-folder")).toBeNull();
  });

  it("keeps an answer the box already holds, proposing Automatic only over the stored default", async () => {
    // Start over runs this wizard again; an owner who chose "ask me" must not
    // find it quietly widened to Automatic on Next.
    stubDevice({ improvementMode: "ask" });
    await reachImprovementStep();
    await waitFor(() =>
      expect(screen.getByTestId("coding-agent-wizard-improvement-ask")).toHaveAttribute("aria-checked", "true"),
    );
  });

  it("keeps an explicit earlier Off rather than proposing Automatic over a decline", async () => {
    stubDevice({ improvementMode: "off", answered: true });
    await reachImprovementStep();
    await waitFor(() =>
      expect(screen.getByTestId("coding-agent-wizard-improvement-off")).toHaveAttribute("aria-checked", "true"),
    );
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-next"));
    await waitFor(() => expect(improvementWrites()).toEqual([{ mode: "off" }]));
  });

  it("lets the owner's pick win over a read that lands after it", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => { release = resolve; });
    stubDevice({ improvementMode: "ask", holdImprovementRead: hold });
    await reachImprovementStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-off"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByTestId("coding-agent-wizard-improvement-off")).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-next"));
    await waitFor(() => expect(improvementWrites()).toEqual([{ mode: "off" }]));
  });

  it("says GitHub is missing beside an answer that would send, and not beside Off", async () => {
    stubDevice();
    await reachImprovementStep();
    expect(screen.getByTestId("coding-agent-wizard-improvement-github").textContent)
      .toBe(translations.en["improvement.githubMissing"]);
    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-off"));
    expect(screen.queryByTestId("coding-agent-wizard-improvement-github")).toBeNull();
  });
});

describe("what the wizard never offers", () => {
  it("never mentions Vercel, on any step", async () => {
    // The Vercel integration is a BETA flag, off by default, offered in ONE
    // place — Coding Agent → Settings, behind a Beta badge — and never as part
    // of setup. Every step's rendered text is read, case-insensitively, so a
    // deploy step added to this flow fails here rather than on a new owner's
    // screen.
    stubDevice();
    const mentions = () => expect(document.body.textContent ?? "").not.toMatch(/vercel/i);

    render(<CodingAgentSetupWizard status={STATUS} onDone={vi.fn()} />);
    const enable = screen.getByTestId("coding-agent-wizard-enable");
    await waitFor(() => expect(enable).not.toBeDisabled());
    mentions(); // intro

    fireEvent.click(enable);
    await screen.findByTestId("coding-agent-wizard-next");
    mentions(); // github

    fireEvent.click(screen.getByTestId("coding-agent-wizard-next"));
    await screen.findByTestId("coding-agent-wizard-improvement-next");
    mentions(); // the Improvement Program

    fireEvent.click(screen.getByTestId("coding-agent-wizard-improvement-next"));
    await screen.findByTestId("coding-agent-wizard-next-harness");
    mentions(); // project folder

    fireEvent.click(screen.getByTestId("coding-agent-wizard-next-harness"));
    await screen.findByTestId("coding-agent-wizard-browser-enable");
    mentions(); // browser

    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-skip"));
    await screen.findByTestId("coding-agent-wizard-harness-run");
    mentions(); // harness, the last step
    // And the wizard wrote nothing about the integration on the way through.
    expect(calls.filter((c) => c.body !== undefined && "vercelEnabled" in (c.body as object))).toEqual([]);
  });
});

describe("the browser step", () => {
  it("sits between the project folder and the test run, as one of five", async () => {
    stubDevice();
    await reachBrowserStep();
    expect(screen.getByText(t("codingAgent.wizardStepOf", { n: 4, total: 5 }))).toBeInTheDocument();
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
    expect(screen.getByText(t("codingAgent.wizardStepOf", { n: 5, total: 5 }))).toBeInTheDocument();
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
