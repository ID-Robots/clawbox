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
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
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
  },
  opts: { resolveTo?: string; rejectDir?: string; forbidSwitch?: boolean; github?: Record<string, unknown> } = {},
) {
  posts = [];
  let stored: string | null = status.defaultDirectory ?? null;
  let effort = status.effort ?? "max";
  let maxTurns = status.maxTurns ?? 150;
  let tokenLimit: number | null = status.tokenLimit ?? null;
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
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) return json(payload());
    if (url.startsWith("/setup-api/coding-agent/git")) return json(opts.github ?? GH_OFF);
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
      if (typeof body.maxTurns === "number") maxTurns = body.maxTurns;
      if ("tokenLimit" in body) tokenLimit = body.tokenLimit;
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

    // Leaving it untouched is not a save.
    fireEvent.blur(turns);
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
