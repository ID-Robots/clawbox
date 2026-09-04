/**
 * Settings → Coding Agent (src/components/CodingAgentSettingsPanel.tsx): the
 * owner's switch, the default project folder, the effort and the two
 * ceilings — moved here from the Coding Agent app, which keeps the runs.
 *
 * The switch renders what the route answers — never what was clicked — and
 * every field posts to the same enable route and renders back the status it
 * returns, using the real English strings so a missing key fails here rather
 * than on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSettingsPanel from "@/components/CodingAgentSettingsPanel";
import { CODING_AGENT_CHANGED_EVENT } from "@/lib/ui-events";

// One stable `t`, as the real hook provides (it is memoised on the locale
// table) — a fresh function per render would be a different contract.
const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t }),
}));

const READY = { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, capabilityDropAvailable: true, problems: [] as string[] };
const NOT_READY = {
  ready: false, wrapperInstalled: true, claudeInstalled: false, clawaiConnected: true, capabilityDropAvailable: true,
  problems: ["Claude Code is not installed on this ClawBox. Run: sudo bash install.sh --step coding_harness"],
};
const GH_OFF = { installed: true, connected: false, login: null, loginCommand: "gh auth login --hostname github.com --git-protocol https" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let posts: { url: string; body: unknown }[];

/**
 * The device, as far as this panel can tell.
 *
 * `resolveTo` stands in for the route resolving a symlink to its real folder,
 * `rejectDir` for the containment rules refusing one, and `forbidSwitch` for
 * the owner-only refusal — all answers the real route gives, and all things
 * the panel has to render.
 */
function stubFetch(
  status: {
    enabled: boolean;
    readiness: typeof READY | typeof NOT_READY;
    defaultDirectory?: string | null;
    effort?: string;
    maxTurns?: number;
    tokenLimit?: number | null;
    reviewPass?: boolean;
    generateImages?: boolean;
    generateAudio?: boolean;
  },
  opts: {
    resolveTo?: string;
    rejectDir?: string;
    forbidSwitch?: boolean;
    github?: Record<string, unknown>;
    /** How the GitHub read fails: a non-2xx answer, or no answer at all. */
    gitStatus?: number;
    gitThrows?: boolean;
  } = {},
) {
  posts = [];
  let stored: string | null = status.defaultDirectory ?? null;
  let effort = status.effort ?? "max";
  let maxTurns = status.maxTurns ?? 150;
  let tokenLimit: number | null = status.tokenLimit ?? null;
  let reviewPass = status.reviewPass ?? false;
  // The two that are ON when the device has never stored them.
  let generateImages = status.generateImages ?? true;
  let generateAudio = status.generateAudio ?? true;
  const payload = () => ({
    enabled: status.enabled,
    ready: status.enabled && status.readiness.ready,
    readiness: status.readiness,
    running: 0,
    harnessCommand: "claude-ds",
    maxTaskChars: 4000,
    defaultDirectory: stored,
    effort,
    effortLevels: ["low", "xhigh", "max"],
    subagents: true,
    maxTurns,
    minMaxTurns: 10,
    maxMaxTurns: 2000,
    tokenLimit,
    minTokenLimit: 10_000,
    reviewPass,
    generateImages,
    generateAudio,
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) return json(payload());
    if (url.startsWith("/setup-api/coding-agent/git")) {
      if (opts.gitThrows) throw new TypeError("Failed to fetch");
      if (opts.gitStatus && opts.gitStatus !== 200) return json({ error: "gh fell over" }, opts.gitStatus);
      return json(opts.github ?? GH_OFF);
    }
    if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push({ url, body });
      if (typeof body.enabled === "boolean") {
        if (opts.forbidSwitch) {
          return json({ error: "Changing the coding agent switch needs a signed-in browser session.", kind: "owner_only" }, 403);
        }
        status = { ...status, enabled: body.enabled };
      }
      if ("defaultDirectory" in body) {
        if (opts.rejectDir && body.defaultDirectory !== null) {
          return json({ error: opts.rejectDir, kind: "invalid" }, 400);
        }
        stored = body.defaultDirectory === null ? null : (opts.resolveTo ?? body.defaultDirectory);
      }
      if (typeof body.effort === "string") effort = body.effort;
      if (typeof body.maxTurns === "number") {
        // The route's own bounds, in its own words.
        if (body.maxTurns < 10 || body.maxTurns > 2000) {
          return json({ error: "Steps must be between 10 and 2000.", kind: "invalid" }, 400);
        }
        maxTurns = body.maxTurns;
      }
      if ("tokenLimit" in body) tokenLimit = body.tokenLimit;
      if (typeof body.reviewPass === "boolean") reviewPass = body.reviewPass;
      if (typeof body.generateImages === "boolean") generateImages = body.generateImages;
      if (typeof body.generateAudio === "boolean") generateAudio = body.generateAudio;
      return json(payload());
    }
    return json({ error: "unexpected" }, 404);
  }));
}

beforeEach(() => {
  posts = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SWITCH = translations.en["codingAgent.switchLabel"];
const SAVE = translations.en["codingAgent.folderSave"];

/** Let a handler's promise chain settle: a save that WOULD have posted has by now. */
async function flush() {
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

describe("the owner's switch", () => {
  it("renders off and turns on only after the route says so", async () => {
    stubFetch({ enabled: false, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: SWITCH });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    fireEvent.click(toggle);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { enabled: true } }]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("stays off and shows the route's own words when the switch is refused", async () => {
    // The route refuses anything but a browser session; the panel must not
    // pretend the click took.
    stubFetch({ enabled: false, readiness: READY }, { forbidSwitch: true });
    render(<CodingAgentSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: SWITCH });
    fireEvent.click(toggle);
    expect(await screen.findByText(/signed-in browser session/)).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("hands every status the route answers to the sidebar", async () => {
    const onStatus = vi.fn();
    stubFetch({ enabled: false, readiness: READY });
    render(<CodingAgentSettingsPanel onStatus={onStatus} />);
    const toggle = await screen.findByRole("switch", { name: SWITCH });
    await waitFor(() => expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
    fireEvent.click(toggle);
    await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true, effort: "max" })));
  });

  it("tells the desktop after a saved change, and not after a refused one", async () => {
    // The Coding Agent app is a different window; this signal is how its
    // On/Off chip follows the switch. It fires on the route's answer, never
    // on the click — a refused switch changed nothing worth re-reading.
    let heard = 0;
    const onChanged = () => { heard += 1; };
    window.addEventListener(CODING_AGENT_CHANGED_EVENT, onChanged);
    try {
      stubFetch({ enabled: false, readiness: READY });
      const { unmount } = render(<CodingAgentSettingsPanel />);
      const toggle = await screen.findByRole("switch", { name: SWITCH });
      expect(heard).toBe(0);
      fireEvent.click(toggle);
      await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
      expect(heard).toBe(1);
      unmount();

      stubFetch({ enabled: false, readiness: READY }, { forbidSwitch: true });
      render(<CodingAgentSettingsPanel />);
      fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
      await screen.findByText(/signed-in browser session/);
      expect(heard).toBe(1);
    } finally {
      window.removeEventListener(CODING_AGENT_CHANGED_EVENT, onChanged);
    }
  });

  it("says what is missing when the switch is on over a harness that cannot run", async () => {
    stubFetch({ enabled: true, readiness: NOT_READY });
    render(<CodingAgentSettingsPanel />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Claude Code is not installed/);
  });

  it("says nothing about readiness while the switch is off", async () => {
    // Off is off: the owner has not asked for anything, so there is nothing
    // to be missing yet.
    stubFetch({ enabled: false, readiness: NOT_READY });
    render(<CodingAgentSettingsPanel />);
    await screen.findByRole("switch", { name: SWITCH });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("the default project folder", () => {
  it("shows what the device has stored", async () => {
    stubFetch({ enabled: true, readiness: READY, defaultDirectory: "/home/clawbox/projects" });
    render(<CodingAgentSettingsPanel />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-folder")).toHaveValue("/home/clawbox/projects"));
  });

  it("saves what was typed, and renders back what the device recorded", async () => {
    // The route resolves symlinks, so what comes back may not be what was
    // typed — the field must show the device's answer, not the draft.
    stubFetch({ enabled: true, readiness: READY }, { resolveTo: "/home/clawbox/real" });
    render(<CodingAgentSettingsPanel />);
    const field = await screen.findByTestId("coding-agent-folder");
    fireEvent.change(field, { target: { value: "/home/clawbox/link" } });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));

    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/coding-agent/enable", body: { defaultDirectory: "/home/clawbox/link" },
    }));
    await waitFor(() => expect(field).toHaveValue("/home/clawbox/real"));
  });

  it("clears the default with an empty field, rather than saving a blank path", async () => {
    stubFetch({ enabled: true, readiness: READY, defaultDirectory: "/home/clawbox/projects" });
    render(<CodingAgentSettingsPanel />);
    const field = await screen.findByTestId("coding-agent-folder");
    await waitFor(() => expect(field).toHaveValue("/home/clawbox/projects"));
    fireEvent.change(field, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/coding-agent/enable", body: { defaultDirectory: null },
    }));
  });

  it("shows the device's own refusal when the folder is not allowed", async () => {
    stubFetch({ enabled: true, readiness: READY }, { rejectDir: "The ClawBox OS checkout itself is off limits." });
    render(<CodingAgentSettingsPanel />);
    fireEvent.change(await screen.findByTestId("coding-agent-folder"), { target: { value: "/home/clawbox/clawbox" } });
    fireEvent.click(screen.getByRole("button", { name: SAVE }));
    expect(await screen.findByText(/off limits/)).toBeInTheDocument();
  });
});

describe("effort and the ceilings", () => {
  it("offers the levels the route lists and marks the new one only after it is saved", async () => {
    stubFetch({ enabled: true, readiness: READY, effort: "max" });
    render(<CodingAgentSettingsPanel />);
    const low = await screen.findByTestId("coding-agent-effort-low");
    expect(screen.getByTestId("coding-agent-effort-max")).toHaveAttribute("aria-pressed", "true");
    expect(low).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(low);
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/enable", body: { effort: "low" } }));
    await waitFor(() => expect(low).toHaveAttribute("aria-pressed", "true"));
  });

  it("saves the step limit when the field is left, and only if it changed", async () => {
    stubFetch({ enabled: true, readiness: READY, maxTurns: 150 });
    render(<CodingAgentSettingsPanel />);
    const turns = await screen.findByTestId("coding-agent-turns");
    await waitFor(() => expect(turns).toHaveValue(150));

    // Leaving it untouched is not a save. The handler is async, so the
    // assertion waits for the tick in which a post would have gone out —
    // checked synchronously it passed before the code under test had run.
    fireEvent.blur(turns);
    await flush();
    expect(posts).toEqual([]);

    fireEvent.change(turns, { target: { value: "40" } });
    fireEvent.blur(turns);
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/enable", body: { maxTurns: 40 } }));
  });

  it("puts the stored step limit back when the field is left blank, rather than posting 0", async () => {
    // Number("") is 0, which the route refuses — and a draft left blank would
    // post that refusal again on every blur. A blank Steps field means
    // nothing (unlike a blank token field, which means "no ceiling").
    stubFetch({ enabled: true, readiness: READY, maxTurns: 150 });
    render(<CodingAgentSettingsPanel />);
    const turns = await screen.findByTestId("coding-agent-turns");
    await waitFor(() => expect(turns).toHaveValue(150));

    fireEvent.change(turns, { target: { value: "" } });
    fireEvent.blur(turns);
    await waitFor(() => expect(turns).toHaveValue(150));
    expect(posts).toEqual([]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("puts the stored step limit back when the route refuses the typed one, and says so beside the field", async () => {
    // The refused number used to stay in the field — re-posted on every
    // later blur — with the message a card away, under GitHub.
    stubFetch({ enabled: true, readiness: READY, maxTurns: 150 });
    render(<CodingAgentSettingsPanel />);
    const turns = await screen.findByTestId("coding-agent-turns");
    await waitFor(() => expect(turns).toHaveValue(150));
    const github = await screen.findByTestId("coding-agent-github-card");

    fireEvent.change(turns, { target: { value: "5" } });
    fireEvent.blur(turns);
    const refusal = await screen.findByText(/between 10 and 2000/);
    await waitFor(() => expect(turns).toHaveValue(150));
    expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { maxTurns: 5 } }]);
    // Under the Steps field, above the GitHub card.
    expect(turns.parentElement).toContainElement(refusal);
    expect(refusal.compareDocumentPosition(github) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // Leaving the field again posts nothing: the refused number is gone.
    fireEvent.blur(turns);
    await flush();
    expect(posts).toHaveLength(1);
  });

  it("sets a token ceiling, and clears it with an empty field", async () => {
    stubFetch({ enabled: true, readiness: READY, tokenLimit: null });
    render(<CodingAgentSettingsPanel />);
    const tokens = await screen.findByTestId("coding-agent-tokens");
    expect(tokens).toHaveAttribute("placeholder", translations.en["codingAgent.tokensPlaceholder"]);

    fireEvent.change(tokens, { target: { value: "50000" } });
    fireEvent.keyDown(tokens, { key: "Enter" });
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/enable", body: { tokenLimit: 50000 } }));
    await waitFor(() => expect(tokens).toHaveValue(50000));

    // null is the route's word for "no ceiling" — an empty field must send
    // it, not a blank string and not nothing.
    fireEvent.change(tokens, { target: { value: "" } });
    fireEvent.blur(tokens);
    await waitFor(() => expect(posts).toContainEqual({ url: "/setup-api/coding-agent/enable", body: { tokenLimit: null } }));
  });
});

describe("the media switches", () => {
  const IMAGES = translations.en["codingAgent.genImagesLabel"];
  const AUDIO = translations.en["codingAgent.genAudioLabel"];

  it("render ON for a device that has never answered with them", async () => {
    // These two are the only settings here that default ON, so a panel that
    // fell back to `false` would show every box as switched off and invite the
    // owner to "turn on" something that was never off.
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    expect(await screen.findByRole("switch", { name: IMAGES })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: AUDIO })).toHaveAttribute("aria-checked", "true");
  });

  it("post the field the route reads and render what it answers", async () => {
    stubFetch({ enabled: true, readiness: READY, generateImages: true, generateAudio: true });
    render(<CodingAgentSettingsPanel />);
    const images = await screen.findByRole("switch", { name: IMAGES });
    fireEvent.click(images);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { generateImages: false } }]));
    await waitFor(() => expect(images).toHaveAttribute("aria-checked", "false"));
    // The other one is untouched by that write.
    expect(screen.getByRole("switch", { name: AUDIO })).toHaveAttribute("aria-checked", "true");
  });

  it("keep their hints one tap away, like every other setting on this card", async () => {
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    await screen.findByRole("switch", { name: IMAGES });
    expect(screen.queryByText(translations.en["codingAgent.genImagesHint"])).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-gen-images-help"));
    expect(screen.getByText(translations.en["codingAgent.genImagesHint"])).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coding-agent-gen-audio-help"));
    expect(screen.getByText(translations.en["codingAgent.genAudioHint"])).toBeInTheDocument();
  });
});

describe("the automatic review pass", () => {
  const REVIEW = translations.en["codingAgent.reviewPassLabel"];

  it("renders off and turns on only after the route says so, beside a main switch that keeps its own id", async () => {
    // The field existed on the route and nowhere in the UI: an owner could
    // neither find the review pass nor see that a curl had switched it on.
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: REVIEW });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("data-testid", "coding-agent-review-pass");
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("data-testid", "coding-agent-switch");
    // The paragraph moved behind a question mark: three of these stacked down
    // the page pushed the controls they explain off the screen. It is still
    // exactly one tap away, and still the same words.
    expect(screen.queryByText(translations.en["codingAgent.reviewPassHint"])).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-review-pass-help"));
    expect(screen.getByText(translations.en["codingAgent.reviewPassHint"])).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { reviewPass: true } }]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    // The main switch is what it was.
    expect(screen.getByRole("switch", { name: SWITCH })).toHaveAttribute("aria-checked", "true");
  });

  it("shows what the device has stored", async () => {
    stubFetch({ enabled: true, readiness: READY, reviewPass: true });
    render(<CodingAgentSettingsPanel />);
    expect(await screen.findByRole("switch", { name: REVIEW })).toHaveAttribute("aria-checked", "true");
  });
});

describe("the sign-out confirmation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function settle(ms = 50) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("takes the armed Sign out back after a few seconds, or when focus leaves it", async () => {
    // It used to stay armed until the panel unmounted: a stray tap minutes
    // later disconnected GitHub.
    stubFetch({ enabled: true, readiness: READY }, {
      github: { installed: true, connected: true, login: "yalexx", loginCommand: GH_OFF.loginCommand },
    });
    render(<CodingAgentSettingsPanel />);
    await settle();
    const signOut = screen.getByTestId("coding-agent-github-signout");
    expect(signOut.textContent).toBe(translations.en["codingAgent.githubOut"]);

    fireEvent.click(signOut);
    expect(signOut.textContent).toBe(translations.en["codingAgent.githubOutConfirm"]);
    await settle(5_100);
    expect(signOut.textContent).toBe(translations.en["codingAgent.githubOut"]);

    // A tap after the revert is a first tap again — nothing is signed out.
    fireEvent.click(signOut);
    await settle();
    expect(signOut.textContent).toBe(translations.en["codingAgent.githubOutConfirm"]);
    const deletes = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "DELETE");
    expect(deletes).toEqual([]);

    fireEvent.blur(signOut);
    expect(signOut.textContent).toBe(translations.en["codingAgent.githubOut"]);
  });
});

describe("the two reads on mount", () => {
  it("renders the switch when the GitHub read answers an error", async () => {
    // The two reads used to share one Promise.all, so gh falling over took
    // the switch down with it. A 500 from /git is gh's problem, not the
    // panel's.
    stubFetch({ enabled: true, readiness: READY }, { gitStatus: 500 });
    render(<CodingAgentSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: SWITCH });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeEnabled();
    expect(screen.queryByText(translations.en["codingAgent.loadFailed"])).not.toBeInTheDocument();
    expect(screen.queryByTestId("coding-agent-github-card")).not.toBeInTheDocument();
  });

  it("renders the switch when the GitHub read does not answer at all", async () => {
    stubFetch({ enabled: false, readiness: READY }, { gitThrows: true });
    render(<CodingAgentSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: SWITCH });
    expect(toggle).toBeEnabled();
    expect(screen.queryByText(translations.en["codingAgent.loadFailed"])).not.toBeInTheDocument();
  });
});

describe("a GitHub read that failed is asked again", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  async function settle(ms = 50) {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }

  it("re-probes after a 500, and shows the account once the route answers", async () => {
    // `github` stays null after a failed read, and null used to be excluded
    // from the inconclusive states — so the card asked once, got nothing,
    // and never asked again: a gh hiccup at mount hid the account for as
    // long as the panel stayed up.
    let gitStatus = 500;
    let gitCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/status")) {
        return json({ enabled: true, ready: true, readiness: READY, running: 0, defaultDirectory: null, effort: "max", effortLevels: ["max"] });
      }
      if (url.startsWith("/setup-api/coding-agent/git")) {
        gitCalls += 1;
        if (gitStatus !== 200) return json({ error: "gh fell over" }, gitStatus);
        return json({ installed: true, connected: true, login: "yalexx", loginCommand: GH_OFF.loginCommand });
      }
      return json({ error: "unexpected" }, 404);
    }));
    render(<CodingAgentSettingsPanel />);
    await settle();
    expect(gitCalls).toBe(1);
    expect(screen.queryByTestId("coding-agent-github-card")).not.toBeInTheDocument();

    await settle(15_100);
    expect(gitCalls).toBe(2);

    gitStatus = 200;
    await settle(15_100);
    expect(gitCalls).toBe(3);
    expect(screen.getByTestId("coding-agent-github-login").textContent).toBe("yalexx");

    // A trusted answer ends the polling.
    await settle(60_000);
    expect(gitCalls).toBe(3);
  });
});

describe("one setting write at a time", () => {
  /** The enable route with its answers held back until the test lets go. */
  function stubDeferredWrites(statusBody: Record<string, unknown>) {
    posts = [];
    const pending: Array<(body: Record<string, unknown>) => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/status")) return json(statusBody);
      if (url.startsWith("/setup-api/coding-agent/git")) return json(GH_OFF);
      if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
        posts.push({ url, body: JSON.parse(String(init.body)) });
        return await new Promise<Response>((resolve) => {
          pending.push((body) => resolve(json(body)));
        });
      }
      return json({ error: "unexpected" }, 404);
    }));
    return {
      /** Answer the oldest write still waiting. */
      answer: async (body: Record<string, unknown>) => {
        const release = pending.shift();
        if (!release) throw new Error("no write is waiting");
        await act(async () => { release(body); await new Promise((r) => setTimeout(r, 0)); });
      },
    };
  }

  const STATUS = {
    enabled: true, ready: true, readiness: READY, running: 0, defaultDirectory: "/home/clawbox/projects",
    effort: "max", effortLevels: ["low", "xhigh", "max"], subagents: true,
    maxTurns: 150, minMaxTurns: 10, maxMaxTurns: 2000, tokenLimit: null, minTokenLimit: 10_000,
  };

  it("disables every setting control while a write is in flight, and queues rather than races a second", async () => {
    // Two writes in flight at once can land in either order, and the older
    // answer — the route re-reads the whole status — would overwrite the
    // newer one on screen. So: one at a time, and the controls say so.
    const route = stubDeferredWrites(STATUS);
    render(<CodingAgentSettingsPanel />);
    const low = await screen.findByTestId("coding-agent-effort-low");
    const xhigh = screen.getByTestId("coding-agent-effort-xhigh");
    expect(xhigh).toBeEnabled();

    fireEvent.click(low);
    await flush();
    expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { effort: "low" } }]);

    // Everything that writes a setting is off until the route answers.
    expect(xhigh).toBeDisabled();
    expect(screen.getByRole("switch", { name: SWITCH })).toBeDisabled();
    expect(screen.getByTestId("coding-agent-turns")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-tokens")).toBeDisabled();
    fireEvent.change(screen.getByTestId("coding-agent-folder"), { target: { value: "/home/clawbox/next" } });
    expect(screen.getByRole("button", { name: SAVE })).toBeDisabled();

    // Enter in the folder field (still typeable) is the one way a second
    // write can be asked for mid-flight. It waits; it is not posted.
    fireEvent.keyDown(screen.getByTestId("coding-agent-folder"), { key: "Enter" });
    await flush();
    expect(posts).toHaveLength(1);

    await route.answer({ ...STATUS, effort: "low" });
    expect(low).toHaveAttribute("aria-pressed", "true");
    // Now the queued write goes out — after the first, never beside it.
    expect(posts).toEqual([
      { url: "/setup-api/coding-agent/enable", body: { effort: "low" } },
      { url: "/setup-api/coding-agent/enable", body: { defaultDirectory: "/home/clawbox/next" } },
    ]);
    expect(xhigh).toBeDisabled();

    await route.answer({ ...STATUS, effort: "low", defaultDirectory: "/home/clawbox/next" });
    // The latest answer is what is on screen, and the controls are back.
    expect(screen.getByTestId("coding-agent-folder")).toHaveValue("/home/clawbox/next");
    expect(low).toHaveAttribute("aria-pressed", "true");
    expect(xhigh).toBeEnabled();
    expect(screen.getByRole("switch", { name: SWITCH })).toBeEnabled();
  });
});

describe("motion", () => {
  /** The device, with the first status held back so the skeleton can be seen. */
  function stubSlowStatus() {
    posts = [];
    let releaseStatus: (() => void) | null = null;
    let releaseSwitch: (() => void) | null = null;
    const body = (enabled: boolean) => ({
      enabled, ready: true, readiness: READY, running: 0, defaultDirectory: null,
      effort: "max", effortLevels: ["max"], maxTurns: 150, minMaxTurns: 10, maxMaxTurns: 2000, tokenLimit: null, minTokenLimit: 10_000,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.startsWith("/setup-api/coding-agent/status")) {
        await new Promise<void>((r) => { releaseStatus = r; });
        return json(body(false));
      }
      if (url.split("?")[0] === "/setup-api/coding-agent/git") return json(GH_OFF);
      if (url === "/setup-api/coding-agent/enable" && init?.method === "POST") {
        await new Promise<void>((r) => { releaseSwitch = r; });
        return json(body(true));
      }
      if (url.startsWith("/setup-api/coding-agent/github-login")) {
        const { action } = JSON.parse(String(init?.body)) as { action: string };
        if (action === "start") return json({ userCode: "8A5B-0396", verificationUri: "https://github.com/login/device", interval: 5 });
        return json({ status: "pending", interval: 5 });
      }
      return json({ error: "unexpected" }, 404);
    }));
    return {
      status: async () => { await act(async () => { releaseStatus?.(); await new Promise((r) => setTimeout(r, 0)); }); },
      toggle: async () => { await act(async () => { releaseSwitch?.(); await new Promise((r) => setTimeout(r, 0)); }); },
    };
  }

  it("animates the skeleton, the switch's spinner and the device-flow wait only when motion is welcome", async () => {
    // Tailwind's `motion-safe:` variant is the OS's reduced-motion setting,
    // honoured: an owner who turned animation off must not get a spinner
    // that keeps turning and a card that keeps pulsing.
    const route = stubSlowStatus();
    render(<CodingAgentSettingsPanel />);
    const skeleton = screen.getByTestId("coding-agent-settings-loading");
    expect(skeleton.className.split(/\s+/)).toContain("motion-safe:animate-pulse");
    expect(skeleton.className.split(/\s+/)).not.toContain("animate-pulse");

    await route.status();
    fireEvent.click(await screen.findByRole("switch", { name: SWITCH }));
    const spinner = await screen.findByTestId("coding-agent-switch-busy");
    expect(spinner.className.split(/\s+/)).toContain("motion-safe:animate-spin");
    expect(spinner.className.split(/\s+/)).not.toContain("animate-spin");
    await route.toggle();
    await waitFor(() => expect(screen.queryByTestId("coding-agent-switch-busy")).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId("coding-agent-github-connect"));
    // The GitHub card shares the ClawBox AI subscription card's markup now:
    // the wait is a spinner beside "Waiting for authorization…", and it is the
    // spinner that must stay still when motion is not welcome.
    const waiting = await screen.findByTestId("coding-agent-github-device-code-waiting");
    expect(waiting.textContent).toBe(translations.en["ai.waitingAuth"]);
    const waitSpinner = screen.getByTestId("coding-agent-github-device-code-spinner");
    expect(waitSpinner.className.split(/\s+/)).toContain("motion-safe:animate-spin");
    expect(waitSpinner.className.split(/\s+/)).not.toContain("animate-spin");
  });
});
