/**
 * The Coding Agent's first-run wizard (src/components/CodingAgentSetupWizard.tsx),
 * and in particular the steps it grew: GitHub,
 * the project folder, WHICH BROWSER a run verifies its work in, then the
 * offered test run.
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
import { fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSetupWizard from "@/components/CodingAgentSetupWizard";
import type { AgentStatus } from "@/components/CodingAgentSettingsPanel";
import { CHAT_MESSAGE_EVENT, buildHarnessTestPrompt } from "@/lib/ui-events";

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
    /** Whether step 1 actually connected GitHub; skipping it is the default. */
    githubConnected?: boolean;
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
    if (url.startsWith("/setup-api/coding-agent/browse")) {
      // The picker's listing: the folder asked for, or the root when it is
      // not there yet (the proposed ~/Projects before anything saved it).
      const dir = new URL(url, "http://box").searchParams.get("dir");
      if (dir && dir !== "/home/clawbox/Projects" && dir !== "/home/clawbox") {
        return json({ error: "Folder not found", kind: "not_found" }, 404);
      }
      const path = dir ?? "/home/clawbox";
      return json({
        root: "/home/clawbox",
        path,
        parent: path === "/home/clawbox" ? null : "/home/clawbox",
        entries: path === "/home/clawbox" ? [{ name: "Projects", path: "/home/clawbox/Projects" }] : [],
      });
    }
    if (url.startsWith("/setup-api/coding-agent/git")) {
      const connected = opts.githubConnected ?? false;
      return json({
        installed: true,
        connected,
        login: connected ? "octocat" : null,
        loginCommand: "gh auth login",
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


/** What the wizard wrote about the browser, if anything. */
const browserSettings = () =>
  calls
    .filter((c) => c.url === "/setup-api/coding-agent/enable" && c.body !== undefined && "realBrowser" in (c.body as object))
    .map((c) => c.body);


/** Walk the wizard as an owner does, up to the project step. */
async function reachProjectStep(onDone = vi.fn()) {
  render(<CodingAgentSetupWizard status={STATUS} onDone={onDone} />);
  // The first step is behind the paid-plan gate, and the gate's own poll has
  // to answer before the button is anything but disabled — the hook starts
  // every mount at "not signed in" and only the first tick settles it.
  const enable = screen.getByTestId("coding-agent-wizard-enable");
  await waitFor(() => expect(enable).not.toBeDisabled());
  fireEvent.click(enable);
  fireEvent.click(await screen.findByTestId("coding-agent-wizard-next"));
  await screen.findByTestId("coding-agent-wizard-folder");
  return onDone;
}

/** Every chat hand-off heard while the test ran, newest last. */
function listenForChat() {
  const heard: string[] = [];
  const onMessage = (e: Event) => heard.push((e as CustomEvent<{ text: string }>).detail.text);
  window.addEventListener(CHAT_MESSAGE_EVENT, onMessage);
  return { heard, stop: () => window.removeEventListener(CHAT_MESSAGE_EVENT, onMessage) };
}

/** Walk the wizard as an owner does, up to the browser step. */
async function reachBrowserStep() {
  render(<CodingAgentSetupWizard status={STATUS} onDone={vi.fn()} />);
  // The first step is behind the paid-plan gate, and the gate's own poll has
  // to answer before the button is anything but disabled — the hook starts
  // every mount at "not signed in" and only the first tick settles it.
  const enable = screen.getByTestId("coding-agent-wizard-enable");
  await waitFor(() => expect(enable).not.toBeDisabled());
  fireEvent.click(enable);
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
    expect(await screen.findByTestId("coding-agent-wizard-try-chat")).toBeInTheDocument();
    expect(screen.getByText(t("codingAgent.wizardStepOf", { n: 4, total: 4 }))).toBeInTheDocument();
  });

  it("installs Chromium only when the box answers that it has none", async () => {
    // The refusal IS the probe: a status read before every open would cost
    // each box a round trip to learn what all but a fresh one already answer.
    stubDevice({ chromiumInstalled: false });
    await reachBrowserStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-enable"));

    await waitFor(() => expect(browserActions()).toEqual(["open-browser", "install-chromium", "open-browser"]));
    expect(await screen.findByTestId("coding-agent-wizard-try-chat")).toBeInTheDocument();
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
    expect(await screen.findByTestId("coding-agent-wizard-try-chat")).toBeInTheDocument();
  });

  it("offers the way on when the setting itself is refused, and never opens a window it did not record", async () => {
    stubDevice({ settingFails: true });
    await reachBrowserStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-enable"));

    expect(await screen.findByText(/signed-in browser session/)).toBeInTheDocument();
    expect(browserActions()).toEqual([]);

    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-continue"));
    expect(await screen.findByTestId("coding-agent-wizard-try-chat")).toBeInTheDocument();
  });

  it("skips by recording the other answer, without touching the screen", async () => {
    stubDevice();
    await reachBrowserStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browser-skip"));

    await waitFor(() => expect(browserSettings()).toEqual([{ realBrowser: false }]));
    // Skip is an ANSWER, not a deferral: nothing is launched, and the owner
    // still lands on the last step.
    expect(browserActions()).toEqual([]);
    expect(await screen.findByTestId("coding-agent-wizard-try-chat")).toBeInTheDocument();
  });
});

describe("the project step", () => {
  // The 2026-10-30 redesign: the folder is TEXT plus Browse — no typed path,
  // no "Create folder" field; a folder that is not there yet is made at the
  // proposed name when the step saves — and the review pass is a Switch.
  it("shows the proposed folder as text and no field to type in", async () => {
    stubDevice();
    await reachProjectStep();
    const folder = screen.getByTestId("coding-agent-wizard-folder");
    expect(folder).toHaveTextContent("/home/clawbox/Projects");
    expect(folder).toHaveAttribute("data-value", "/home/clawbox/Projects");
    expect(folder.tagName).not.toBe("INPUT");
    expect(screen.getByTestId("coding-agent-wizard")?.querySelectorAll("input, textarea, select")).toHaveLength(0);
    expect(screen.queryByTestId("coding-agent-wizard-newfolder")).toBeNull();
  });

  it("opens the picker from Browse, as a sheet with no field, and takes the folder picked", async () => {
    stubDevice();
    await reachProjectStep();
    fireEvent.click(screen.getByTestId("coding-agent-wizard-browse"));
    const picker = await screen.findByTestId("coding-agent-wizard-picker");
    expect(within(picker).getByRole("dialog")).toBeInTheDocument();
    expect(picker.querySelectorAll("input, textarea, select")).toHaveLength(0);
    // It opens where the proposed folder is; Up is the root.
    await waitFor(() => expect(screen.getByTestId("coding-agent-wizard-picker-path")).toHaveTextContent("/home/clawbox/Projects"));
    fireEvent.click(screen.getByTestId("coding-agent-wizard-picker-up"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-wizard-picker-path")).toHaveTextContent("/home/clawbox"));
    fireEvent.click(screen.getByTestId("coding-agent-wizard-picker-use"));
    expect(screen.queryByTestId("coding-agent-wizard-picker")).toBeNull();
    expect(screen.getByTestId("coding-agent-wizard-folder")).toHaveTextContent("/home/clawbox");
    expect(screen.getByTestId("coding-agent-wizard-folder")).toHaveAttribute("data-value", "/home/clawbox");
  });

  it("falls back to the root when the proposed folder is not there yet", async () => {
    stubDevice();
    render(<CodingAgentSetupWizard status={{ ...STATUS, suggestedDirectory: "/home/clawbox/Nowhere" }} onDone={vi.fn()} />);
    const enable = screen.getByTestId("coding-agent-wizard-enable");
    await waitFor(() => expect(enable).not.toBeDisabled());
    fireEvent.click(enable);
    fireEvent.click(await screen.findByTestId("coding-agent-wizard-next"));
    fireEvent.click(await screen.findByTestId("coding-agent-wizard-browse"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-wizard-picker-path")).toHaveTextContent("/home/clawbox"));
    expect(screen.getByTestId("coding-agent-wizard-picker-entry")).toHaveTextContent("Projects");
  });

  it("draws the review pass as a switch, and saves the folder shown with it", async () => {
    stubDevice();
    await reachProjectStep();
    const review = screen.getByTestId("coding-agent-wizard-review");
    expect(review).toHaveAttribute("role", "switch");
    expect(review).toHaveAttribute("aria-checked", "true");
    fireEvent.click(review);
    expect(review).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByTestId("coding-agent-wizard-next-harness"));
    await waitFor(() => expect(calls.some((c) => c.url === "/setup-api/coding-agent/enable")).toBe(true));
    expect(calls.find((c) => c.url === "/setup-api/coding-agent/enable")!.body).toEqual({
      defaultDirectory: "/home/clawbox/Projects",
      reviewPass: false,
      enabled: true,
      setupComplete: false,
    });
  });
});

describe("the last step", () => {
  // "Try it in the chat" (2026-10-30): the wizard starts no run of its own.
  // It finishes setup and hands the chat the one message that asks the
  // assistant for the smoke run, so the first run appears as a card there.
  it("finishes setup, hands the harness test to the chat and closes", async () => {
    stubDevice();
    const onDone = vi.fn();
    const chat = listenForChat();
    try {
      render(<CodingAgentSetupWizard status={STATUS} onDone={onDone} />);
      const enable = screen.getByTestId("coding-agent-wizard-enable");
      await waitFor(() => expect(enable).not.toBeDisabled());
      fireEvent.click(enable);
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-next"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-next-harness"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-browser-skip"));
      const tryIt = await screen.findByTestId("coding-agent-wizard-try-chat");
      expect(tryIt).toHaveTextContent(translations.en["codingAgent.wizardTryInChat"]);
      fireEvent.click(tryIt);
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      // The flag went FIRST, then the hand-off — never a run in the chat
      // under a wizard that could not close.
      expect(calls.at(-1)!.body).toEqual({ setupComplete: true });
      expect(chat.heard).toEqual([buildHarnessTestPrompt()]);
      expect(chat.heard[0]).toContain("smoke test");
      expect(chat.heard[0]).toContain("harness-test");
      // Nothing was posted to the run route from here.
      expect(calls.some((c) => c.url === "/setup-api/coding-agent/run")).toBe(false);
      expect(calls.some((c) => c.url === "/setup-api/coding-agent/browse")).toBe(false);
    } finally {
      chat.stop();
    }
  });

  it("hands nothing to the chat when the flag is refused", async () => {
    stubDevice({ settingFails: true });
    // The stub refuses only the browser write; refuse the flag by hand.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (input.toString() === "/setup-api/coding-agent/enable" && body?.setupComplete === true) {
        calls.push({ url: input.toString(), body });
        return json({ error: "Finishing setup needs a signed-in browser session." }, 403);
      }
      return real(input, init);
    }));
    const onDone = vi.fn();
    const chat = listenForChat();
    try {
      render(<CodingAgentSetupWizard status={STATUS} onDone={onDone} />);
      const enable = screen.getByTestId("coding-agent-wizard-enable");
      await waitFor(() => expect(enable).not.toBeDisabled());
      fireEvent.click(enable);
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-next"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-next-harness"));
      // The browser step: Enable's setting write is the one this stub refuses,
      // so Continue is the way on.
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-browser-enable"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-browser-continue"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-try-chat"));
      expect(await screen.findByText(/signed-in browser session/)).toBeInTheDocument();
      expect(onDone).not.toHaveBeenCalled();
      expect(chat.heard).toEqual([]);
    } finally {
      chat.stop();
    }
  });

  it("skips by finishing setup alone, with nothing handed to the chat", async () => {
    stubDevice();
    const onDone = vi.fn();
    const chat = listenForChat();
    try {
      render(<CodingAgentSetupWizard status={STATUS} onDone={onDone} />);
      const enable = screen.getByTestId("coding-agent-wizard-enable");
      await waitFor(() => expect(enable).not.toBeDisabled());
      fireEvent.click(enable);
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-next"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-next-harness"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-browser-skip"));
      fireEvent.click(await screen.findByTestId("coding-agent-wizard-harness-skip"));
      await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
      expect(calls.at(-1)!.body).toEqual({ setupComplete: true });
      expect(chat.heard).toEqual([]);
    } finally {
      chat.stop();
    }
  });
});
