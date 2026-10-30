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
import { act, fireEvent, render, screen, waitFor, within } from "@/tests/helpers/test-utils";
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
    readiness: { ready: boolean; problems: string[]; [field: string]: unknown };
    defaultDirectory?: string | null;
    effort?: string;
    reviewPass?: boolean;
    teamDynamic?: boolean;
    generateMedia?: boolean;
    realBrowser?: boolean;
    autoMerge?: boolean;
    maxParallelRuns?: number;
    gitAuthorName?: string | null;
    gitAuthorEmail?: string | null;
    prBodyIncludesTask?: string;
  },
  opts: {
    resolveTo?: string;
    rejectDir?: string;
    forbidSwitch?: boolean;
    github?: Record<string, unknown>;
    /** How the GitHub read fails: a non-2xx answer, or no answer at all. */
    gitStatus?: number;
    gitThrows?: boolean;
    /** A server from before the browser switch existed: it answers with no
     *  such field at all, which is the state the panel's `?? true` is for. */
    noRealBrowser?: boolean;
    /** A server from before the media switch: no `generateMedia` field at all,
     *  the state the panel's `?? true` is for (a fixture that always answered
     *  the field passed with that fallback gone). */
    noGenerateMedia?: boolean;
    /** A server from before the review loop: it answers with no merge field,
     *  and the card must then show no switch rather than invent a value. */
    noReviewLoop?: boolean;
    /** A server from before worktrees: no runs-at-once field, so that control
     *  must not be drawn either. */
    noMaxParallelRuns?: boolean;
    /** A server from before the commit-author setting: no fields at all, so the
     *  two inputs must not be drawn — their Save would post a body it refuses. */
    noGitAuthor?: boolean;
    /** The route's own refusal of an address that is not one. */
    rejectAuthor?: string;
    /** A server from before TASK-1366: no field for how much of the task a pull
     *  request carries, so the select must not be drawn. */
    noPrBodyTask?: boolean;
    /** A server from before the per-role models: no field, so the section is not drawn. */
    noRoleModels?: boolean;
    /** The per-role choices as the status draws them — e.g. the older shape,
     *  with no provider. Absent: every role on its default. */
    roleModels?: Record<string, Record<string, string>>;
    /** What each role starts on now (status.roleModelMap). Absent: a server
     *  that predates it. */
    roleModelMap?: Record<string, unknown>;
    /** The accounts the build knows (status.providers) and the default one. Absent: a server that predates the picker. */
    providers?: string[];
    provider?: string;
    /** The accounts the owner connected (status.connectedProviders). Absent: a server that predates the list. */
    connectedProviders?: string[];
  } = {},
) {
  posts = [];
  let stored: string | null = status.defaultDirectory ?? null;
  let effort = status.effort ?? "max";
  let reviewPass = status.reviewPass ?? false;
  let teamDynamic = status.teamDynamic;
  // The two that are ON when the device has never stored them.
  let generateMedia = status.generateMedia ?? true;
  let realBrowser = status.realBrowser ?? true;
  let autoMerge = status.autoMerge ?? false;
  let maxParallelRuns = status.maxParallelRuns ?? 2;
  // OFF when the device has never stored it, unlike the media switches above.
  // Both halves unset means "use the project's own git identity", which is
  // what every box did before the setting existed.
  let gitAuthorName: string | null = status.gitAuthorName ?? null;
  let gitAuthorEmail: string | null = status.gitAuthorEmail ?? null;
  let prBodyIncludesTask = status.prBodyIncludesTask ?? "summary";
  // Every role on its default, as a box that never chose answers.
  const roleModels: Record<string, Record<string, string>> = opts.roleModels
    ? JSON.parse(JSON.stringify(opts.roleModels))
    : {
      planner: { provider: "auto", model: "auto", effort: "auto" },
      worker: { provider: "auto", model: "auto", effort: "auto" },
      reviewer: { provider: "auto", model: "auto", effort: "auto" },
    };
  let provider = opts.provider ?? opts.providers?.[0] ?? null;
  let connected: string[] | null = opts.connectedProviders ? [...opts.connectedProviders] : null;
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
    reviewPass,
    // Absent unless the test says: an older server does not answer with it.
    ...(teamDynamic === undefined ? {} : { teamDynamic }),
    ...(opts.noGenerateMedia ? {} : { generateMedia }),
    ...(opts.noRealBrowser ? {} : { realBrowser }),
    ...(opts.noReviewLoop ? {} : { autoMerge }),
    ...(opts.noMaxParallelRuns ? {} : { maxParallelRuns, minMaxParallelRuns: 1, maxMaxParallelRuns: 4 }),
    ...(opts.noGitAuthor ? {} : { gitAuthorName, gitAuthorEmail, maxGitAuthorChars: 200 }),
    ...(opts.noPrBodyTask ? {} : { prBodyIncludesTask }),
    ...(opts.noRoleModels ? {} : { roleModels: JSON.parse(JSON.stringify(roleModels)) }),
    ...(opts.roleModelMap ? { roleModelMap: opts.roleModelMap } : {}),
    ...(opts.providers ? { provider, providers: opts.providers } : {}),
    ...(connected ? { connectedProviders: [...connected] } : {}),
  });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) return json(payload());
    // The panel embeds CodingAgentRulesCard, which reads its own route. Left
    // unstubbed the card renders its "could not read the rules" alert, which
    // is a real message from a real child — so the stub answers for the device
    // here rather than the assertions being narrowed around it.
    if (url.startsWith("/setup-api/coding-agent/permissions")) {
      return json({ allowRules: [], maxAllowRules: 32 });
    }
    // Same reason for CodingAgentSecretsCard, which the panel also embeds: its
    // own list route and the projects route behind its scope picker. Left
    // unstubbed, the card's own "could not read the stored secrets" alert is a
    // real message from a real child and would fail every assertion that says
    // this panel shows no alert.
    if (url.startsWith("/setup-api/coding-agent/secrets")) {
      return json({ secrets: [], max: 64, maxValueChars: 8192, injectSecrets: false });
    }
    if (url.startsWith("/setup-api/coding-agent/projects")) {
      return json({ directory: null, projects: [] });
    }
    if (url.startsWith("/setup-api/coding-agent/browse")) return json(browseListing(url));
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
      if (typeof body.reviewPass === "boolean") reviewPass = body.reviewPass;
      if (typeof body.teamDynamic === "boolean") teamDynamic = body.teamDynamic;
      if (typeof body.generateMedia === "boolean") generateMedia = body.generateMedia;
      if (typeof body.realBrowser === "boolean") realBrowser = body.realBrowser;
      if ("gitAuthorName" in body || "gitAuthorEmail" in body) {
        if (opts.rejectAuthor && body.gitAuthorEmail !== null) {
          return json({ error: opts.rejectAuthor, kind: "invalid" }, 400);
        }
        if ("gitAuthorName" in body) gitAuthorName = body.gitAuthorName;
        if ("gitAuthorEmail" in body) gitAuthorEmail = body.gitAuthorEmail;
      }
      if (typeof body.autoMerge === "boolean") autoMerge = body.autoMerge;
      if (typeof body.prBodyIncludesTask === "string") prBodyIncludesTask = body.prBodyIncludesTask;
      if (body.roleModels && typeof body.roleModels === "object") {
        for (const [role, half] of Object.entries(body.roleModels as Record<string, Record<string, string>>)) {
          roleModels[role] = { ...roleModels[role], ...half };
        }
      }
      // The route's own rules for the connected set: never empty, the default
      // follows it, and a role pinned to an account that left goes back to Default.
      if (typeof body.provider === "string") provider = body.provider;
      if (Array.isArray(body.providers)) {
        const next = body.providers as string[];
        if (next.length === 0) return json({ error: "At least one provider must stay connected: runs need an account to start on.", kind: "invalid" }, 400);
        connected = next;
        if (provider && !next.includes(provider)) provider = next[0];
        for (const role of Object.keys(roleModels)) {
          const pinned = roleModels[role].provider;
          if (pinned && pinned !== "auto" && !next.includes(pinned)) roleModels[role] = { ...roleModels[role], provider: "auto", model: "auto" };
        }
      }
      if (typeof body.maxParallelRuns === "number") {
        if (body.maxParallelRuns < 1 || body.maxParallelRuns > 4) {
          return json({ error: "The number of runs at once must be between 1 and 4.", kind: "invalid" }, 400);
        }
        maxParallelRuns = body.maxParallelRuns;
      }
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

/** The browse root — the owner's home — with one project folder in it. */
const BROWSE_ROOT = "/home/clawbox";
/**
 * The folder picker's route, as the box answers it: the folder asked for (or
 * the root), its parent, and the one folder under the root. `/home/clawbox/link`
 * is the folder the tests pick; the enable route resolves it to wherever it
 * leads (`resolveTo`).
 */
function browseListing(url: string) {
  const dir = new URL(url, "http://box").searchParams.get("dir");
  const path = dir ?? BROWSE_ROOT;
  return {
    root: BROWSE_ROOT,
    path,
    parent: path === BROWSE_ROOT ? null : BROWSE_ROOT,
    entries: path === BROWSE_ROOT ? [{ name: "link", path: `${BROWSE_ROOT}/link` }] : [],
  };
}

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
  // The 2026-10-30 redesign: the folder is TEXT plus Browse — no typed path
  // (not a thing an owner does on a phone) and no Save. The picker is the one
  // way to change it, and a pick is saved the moment it is made.
  it("shows what the device has stored, as text, with no field to type in", async () => {
    stubFetch({ enabled: true, readiness: READY, defaultDirectory: "/home/clawbox/projects" });
    render(<CodingAgentSettingsPanel />);
    const folder = await screen.findByTestId("coding-agent-folder");
    await waitFor(() => expect(folder).toHaveTextContent("/home/clawbox/projects"));
    expect(folder).toHaveAttribute("data-value", "/home/clawbox/projects");
    expect(folder.tagName).not.toBe("INPUT");
    expect(screen.getByTestId("coding-agent-folder-browse")).toBeEnabled();
    expect(screen.queryByTestId("coding-agent-folder-picker")).toBeNull();
  });

  it("says when none is chosen yet", async () => {
    stubFetch({ enabled: true, readiness: READY, defaultDirectory: null });
    render(<CodingAgentSettingsPanel />);
    const folder = await screen.findByTestId("coding-agent-folder");
    await waitFor(() => expect(folder).toHaveTextContent(translations.en["codingAgent.folderUnset"]));
    expect(folder).toHaveAttribute("data-value", "");
  });

  it("opens the picker where the stored folder is, and lists the box's folders", async () => {
    stubFetch({ enabled: true, readiness: READY, defaultDirectory: "/home/clawbox/projects" });
    render(<CodingAgentSettingsPanel />);
    fireEvent.click(await screen.findByTestId("coding-agent-folder-browse"));
    const picker = await screen.findByTestId("coding-agent-folder-picker");
    expect(within(picker).getByRole("dialog")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("coding-agent-folder-picker-path")).toHaveTextContent("/home/clawbox/projects"));
    // Up leads to the root, which lists the one folder in it.
    fireEvent.click(screen.getByTestId("coding-agent-folder-picker-up"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-folder-picker-path")).toHaveTextContent(BROWSE_ROOT));
    expect(screen.getByTestId("coding-agent-folder-picker-entry")).toHaveTextContent("link");
    // The picker is a sheet with no field in it: existing folders only.
    expect(picker.querySelectorAll("input, textarea, select")).toHaveLength(0);
  });

  it("saves the picked folder at once, and renders back what the device recorded", async () => {
    // The route resolves symlinks, so what comes back may not be what was
    // picked — the row must show the device's answer.
    stubFetch({ enabled: true, readiness: READY }, { resolveTo: "/home/clawbox/real" });
    render(<CodingAgentSettingsPanel />);
    fireEvent.click(await screen.findByTestId("coding-agent-folder-browse"));
    fireEvent.click(await screen.findByTestId("coding-agent-folder-picker-entry"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-folder-picker-path")).toHaveTextContent("/home/clawbox/link"));
    fireEvent.click(screen.getByTestId("coding-agent-folder-picker-use"));

    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/coding-agent/enable", body: { defaultDirectory: "/home/clawbox/link" },
    }));
    await waitFor(() => expect(screen.getByTestId("coding-agent-folder")).toHaveTextContent("/home/clawbox/real"));
    expect(screen.queryByTestId("coding-agent-folder-picker")).toBeNull();
  });

  it("closes the picker without saving anything", async () => {
    stubFetch({ enabled: true, readiness: READY, defaultDirectory: "/home/clawbox/projects" });
    render(<CodingAgentSettingsPanel />);
    fireEvent.click(await screen.findByTestId("coding-agent-folder-browse"));
    fireEvent.click(await screen.findByTestId("coding-agent-folder-picker-close"));
    expect(screen.queryByTestId("coding-agent-folder-picker")).toBeNull();
    expect(posts.filter((p) => p.url === "/setup-api/coding-agent/enable")).toEqual([]);
  });

  it("shows the device's own refusal when the folder is not allowed", async () => {
    stubFetch({ enabled: true, readiness: READY }, { rejectDir: "The ClawBox OS checkout itself is off limits." });
    render(<CodingAgentSettingsPanel />);
    fireEvent.click(await screen.findByTestId("coding-agent-folder-browse"));
    fireEvent.click(await screen.findByTestId("coding-agent-folder-picker-use"));
    expect(await screen.findByText(/off limits/)).toBeInTheDocument();
  });
});

describe("the commit author", () => {
  const AUTHOR_SAVE = translations.en["codingAgent.commitAuthorSave"];

  it("shows what the device has stored, and says why it matters", async () => {
    stubFetch({
      enabled: true, readiness: READY,
      gitAuthorName: "Ada Lovelace", gitAuthorEmail: "ada@example.com",
    });
    render(<CodingAgentSettingsPanel />);
    await waitFor(() => expect(screen.getByTestId("coding-agent-author-name")).toHaveValue("Ada Lovelace"));
    expect(screen.getByTestId("coding-agent-author-email")).toHaveValue("ada@example.com");
    const hint = translations.en["codingAgent.commitAuthorHint"];
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(hint).toContain("deploy");
  });

  it("saves both halves in ONE request, because the device uses them as a pair", async () => {
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    const name = await screen.findByTestId("coding-agent-author-name");
    const email = screen.getByTestId("coding-agent-author-email");
    fireEvent.change(name, { target: { value: "  Ada Lovelace  " } });
    fireEvent.change(email, { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: AUTHOR_SAVE }));

    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/coding-agent/enable",
      body: { gitAuthorName: "Ada Lovelace", gitAuthorEmail: "ada@example.com" },
    }));
    await waitFor(() => expect(name).toHaveValue("Ada Lovelace"));
  });

  it("clears both halves with empty fields rather than saving blanks", async () => {
    stubFetch({
      enabled: true, readiness: READY,
      gitAuthorName: "Ada Lovelace", gitAuthorEmail: "ada@example.com",
    });
    render(<CodingAgentSettingsPanel />);
    const name = await screen.findByTestId("coding-agent-author-name");
    await waitFor(() => expect(name).toHaveValue("Ada Lovelace"));
    fireEvent.change(name, { target: { value: "  " } });
    fireEvent.change(screen.getByTestId("coding-agent-author-email"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: AUTHOR_SAVE }));
    await waitFor(() => expect(posts).toContainEqual({
      url: "/setup-api/coding-agent/enable",
      body: { gitAuthorName: null, gitAuthorEmail: null },
    }));
  });

  it("shows the device's own refusal beside the fields", async () => {
    stubFetch({ enabled: true, readiness: READY }, { rejectAuthor: "Give an e-mail address, e.g. you@example.com." });
    render(<CodingAgentSettingsPanel />);
    fireEvent.change(await screen.findByTestId("coding-agent-author-email"), { target: { value: "nobody" } });
    fireEvent.click(screen.getByRole("button", { name: AUTHOR_SAVE }));
    expect(await screen.findByText(/Give an e-mail address/)).toBeInTheDocument();
  });

  it("draws nothing at all on a server that predates the setting", async () => {
    // Its Save would post a body that server answers 400 to, so the honest
    // face of an older device is no control.
    stubFetch({ enabled: true, readiness: READY }, { noGitAuthor: true });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-folder");
    expect(screen.queryByTestId("coding-agent-commit-author")).toBeNull();
    expect(screen.queryByTestId("coding-agent-author-email")).toBeNull();
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

  it("offers no step field and no token field: the ceilings are a safety net, not a setting", async () => {
    // SCA A2 took the device-side token limit out; SCA3 took the step count
    // with it (DEFAULT_MAX_TURNS is the net, 2,000 for a writing run), so the
    // Ceilings group holds only how many runs may go at once, when the
    // server answers with it.
    stubFetch({ enabled: true, readiness: READY, maxParallelRuns: 2 });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-max-parallel-runs");
    expect(screen.queryByTestId("coding-agent-turns")).toBeNull();
    expect(screen.queryByTestId("coding-agent-tokens")).toBeNull();
    expect(screen.queryByLabelText(/steps per run/i)).toBeNull();
  });
});

describe("the media switch", () => {
  const MEDIA = translations.en["codingAgent.genMediaLabel"];

  it("renders ON for a device that has never answered with it", async () => {
    // One of the few settings here that defaults ON, so a panel that fell back
    // to `false` would show every box as switched off and invite the owner to
    // "turn on" something that was never off.
    stubFetch({ enabled: true, readiness: READY }, { noGenerateMedia: true });
    render(<CodingAgentSettingsPanel />);
    expect(await screen.findByRole("switch", { name: MEDIA })).toHaveAttribute("aria-checked", "true");
    // One switch for pictures and speech together (SCA C3), not two.
    expect(screen.queryByTestId("coding-agent-gen-images")).toBeNull();
    expect(screen.queryByTestId("coding-agent-gen-audio")).toBeNull();
  });

  it("posts the one field the route reads and renders what it answers", async () => {
    stubFetch({ enabled: true, readiness: READY, generateMedia: true });
    render(<CodingAgentSettingsPanel />);
    const media = await screen.findByRole("switch", { name: MEDIA });
    fireEvent.click(media);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { generateMedia: false } }]));
    await waitFor(() => expect(media).toHaveAttribute("aria-checked", "false"));
  });

  it("keeps its hint one tap away, like every other setting on this card", async () => {
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    await screen.findByRole("switch", { name: MEDIA });
    expect(screen.queryByText(translations.en["codingAgent.genMediaHint"])).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-gen-media-help"));
    expect(screen.getByText(translations.en["codingAgent.genMediaHint"])).toBeInTheDocument();
  });
});

describe("the browser a run verifies its work in", () => {
  const BROWSER = translations.en["codingAgent.realBrowserLabel"];

  it("renders ON for a device that answers with no such field", async () => {
    // A box updated into this feature has nothing stored, and nothing stored
    // means the screen's Chromium — the same rule the media switches use. A
    // panel that fell back to `false` would show every existing box as
    // switched off and invite the owner to turn on what was never off.
    stubFetch({ enabled: true, readiness: READY }, { noRealBrowser: true });
    render(<CodingAgentSettingsPanel />);
    expect(await screen.findByRole("switch", { name: BROWSER })).toHaveAttribute("aria-checked", "true");
  });

  it("posts the field the route reads and renders what it answers", async () => {
    stubFetch({ enabled: true, readiness: READY, realBrowser: true });
    render(<CodingAgentSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: BROWSER });
    expect(toggle).toHaveAttribute("data-testid", "coding-agent-real-browser");
    fireEvent.click(toggle);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { realBrowser: false } }]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
  });

  it("shows what the device has stored, and keeps its hint one tap away", async () => {
    stubFetch({ enabled: true, readiness: READY, realBrowser: false });
    render(<CodingAgentSettingsPanel />);
    expect(await screen.findByRole("switch", { name: BROWSER })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(translations.en["codingAgent.realBrowserHint"])).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-real-browser-help"));
    expect(screen.getByText(translations.en["codingAgent.realBrowserHint"])).toBeInTheDocument();
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

describe("the team lead's switch", () => {
  const LEAD = translations.en["codingAgent.teamDynamicLabel"];

  it("is off by default — also against a server that predates it — and turns on only after the route says so", async () => {
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: LEAD });
    expect(LEAD).toBe("Let the team lead add or retire tasks while a team runs");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("data-testid", "coding-agent-team-dynamic");
    expect(screen.queryByText(translations.en["codingAgent.teamDynamicHint"])).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-team-dynamic-help"));
    expect(screen.getByText(translations.en["codingAgent.teamDynamicHint"])).toBeInTheDocument();

    fireEvent.click(toggle);
    await waitFor(() => expect(posts).toEqual([{ url: "/setup-api/coding-agent/enable", body: { teamDynamic: true } }]));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
  });

  it("shows what the device has stored", async () => {
    stubFetch({ enabled: true, readiness: READY, teamDynamic: true });
    render(<CodingAgentSettingsPanel />);
    expect(await screen.findByRole("switch", { name: LEAD })).toHaveAttribute("aria-checked", "true");
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
      // The embedded cards' own routes — this harness counts git calls, so
      // everything else it does not name must still answer rather than 404.
      if (url.startsWith("/setup-api/coding-agent/permissions")) {
        return json({ allowRules: [], maxAllowRules: 32 });
      }
      if (url.startsWith("/setup-api/coding-agent/secrets")) {
        return json({ secrets: [], max: 64, maxValueChars: 8192, injectSecrets: false });
      }
      if (url.startsWith("/setup-api/coding-agent/projects")) {
        return json({ directory: null, projects: [] });
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
      if (url.startsWith("/setup-api/coding-agent/browse")) return json(browseListing(url));
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

    // Browse stays live (opening a listing writes nothing), so a folder
    // picked mid-flight is the one way a second write can be asked for. It
    // waits; it is not posted.
    fireEvent.click(screen.getByTestId("coding-agent-folder-browse"));
    // The sheet opens at the stored folder; the one the test picks is a
    // sibling under the root.
    fireEvent.click(await screen.findByTestId("coding-agent-folder-picker-up"));
    fireEvent.click(await screen.findByTestId("coding-agent-folder-picker-entry"));
    await waitFor(() => expect(screen.getByTestId("coding-agent-folder-picker-path")).toHaveTextContent("/home/clawbox/link"));
    fireEvent.click(screen.getByTestId("coding-agent-folder-picker-use"));
    await flush();
    expect(posts).toHaveLength(1);

    await route.answer({ ...STATUS, effort: "low" });
    expect(low).toHaveAttribute("aria-pressed", "true");
    // Now the queued write goes out — after the first, never beside it.
    expect(posts).toEqual([
      { url: "/setup-api/coding-agent/enable", body: { effort: "low" } },
      { url: "/setup-api/coding-agent/enable", body: { defaultDirectory: "/home/clawbox/link" } },
    ]);
    expect(xhigh).toBeDisabled();

    await route.answer({ ...STATUS, effort: "low", defaultDirectory: "/home/clawbox/link" });
    // The latest answer is what is on screen, and the controls are back.
    expect(screen.getByTestId("coding-agent-folder")).toHaveTextContent("/home/clawbox/link");
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
      effort: "max", effortLevels: ["max"],
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

/**
 * The review loop's two controls.
 *
 * Both are about what the box does on its OWN after a run has finished, which
 * is why the merge one is a consent and defaults off while the rounds are a
 * budget and default to three. A server that predates the loop answers with
 * neither, and a card that invented values there would offer a setting the box
 * has no route for.
 */
describe("the review loop", () => {
  const MERGE = translations.en["codingAgent.autoMergeLabel"];

  it("renders the merge switch OFF when the device has never stored it", async () => {
    // The one switch on this card that is a consent: absent means no.
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    const toggle = await screen.findByRole("switch", { name: MERGE });
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);
    await waitFor(() => { expect(posts).toContainEqual({ url: "/setup-api/coding-agent/enable", body: { autoMerge: true } }); });
    await waitFor(() => { expect(screen.getByRole("switch", { name: MERGE }).getAttribute("aria-checked")).toBe("true"); });
  });

  it("shows no merge switch on a server that predates the loop, and never a rounds select", async () => {
    stubFetch({ enabled: true, readiness: READY }, { noReviewLoop: true });
    render(<CodingAgentSettingsPanel />);
    // The card is up…
    await screen.findByRole("switch", { name: SWITCH });
    expect(screen.queryByRole("switch", { name: MERGE })).toBeNull();
    // The round count is no longer a setting (SCA C3): every pull request
    // gets the default, and no control offers to change it.
    expect(screen.queryByTestId("coding-agent-review-rounds")).toBeNull();
  });
});

/**
 * How much of the run's task the box's pull request carries (TASK-1366). Its
 * one-line explanation is ON the card, not behind a tip: it is where the owner
 * learns what the box takes out before publishing.
 */
describe("the task text in the pull request", () => {
  const LABEL = translations.en["codingAgent.prBodyIncludesTaskLabel"];
  const HINT = translations.en["codingAgent.prBodyIncludesTaskHint"];

  it("shows the stored choice with its explanation, offers the three the route takes, and saves a new one", async () => {
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    const select = await screen.findByLabelText(LABEL) as HTMLSelectElement;
    expect(select.value).toBe("summary");
    expect(screen.getByText(HINT)).toBeTruthy();
    expect([...select.querySelectorAll("option")].map((o) => [o.value, o.textContent])).toEqual([
      ["summary", translations.en["codingAgent.prBodyIncludesTaskSummary"]],
      ["full-redacted", translations.en["codingAgent.prBodyIncludesTaskFullRedacted"]],
      ["none", translations.en["codingAgent.prBodyIncludesTaskNone"]],
    ]);

    fireEvent.change(select, { target: { value: "none" } });
    await waitFor(() => { expect(posts).toContainEqual({ url: "/setup-api/coding-agent/enable", body: { prBodyIncludesTask: "none" } }); });
    await waitFor(() => { expect((screen.getByTestId("coding-agent-pr-body-task") as HTMLSelectElement).value).toBe("none"); });
  });

  it("shows what the device has stored", async () => {
    stubFetch({ enabled: true, readiness: READY, prBodyIncludesTask: "full-redacted" });
    render(<CodingAgentSettingsPanel />);
    expect((await screen.findByTestId("coding-agent-pr-body-task") as HTMLSelectElement).value).toBe("full-redacted");
  });

  it("is not drawn on a server that predates the setting", async () => {
    stubFetch({ enabled: true, readiness: READY }, { noPrBodyTask: true });
    render(<CodingAgentSettingsPanel />);
    await screen.findByRole("switch", { name: SWITCH });
    expect(screen.queryByTestId("coding-agent-pr-body-task")).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });
});

/**
  });
});

/**
 * How many runs may be going at once.
 *
 * A number rather than a switch because each run works in a copy of the
 * project on a branch of its own: what bounds it is this box's memory, not the
 * filesystem. Hidden on a server that answers with no field, like the two
 * above.
 */
describe("the runs-at-once control", () => {
  it("shows what the device answered with, offers only the range it named, and saves a new value", async () => {
    stubFetch({ enabled: true, readiness: READY, maxParallelRuns: 2 });
    render(<CodingAgentSettingsPanel />);
    const select = await screen.findByTestId("coding-agent-max-parallel-runs") as HTMLSelectElement;
    expect(select.value).toBe("2");
    expect(Array.from(select.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value)).toEqual(["1", "2", "3", "4"]);

    fireEvent.change(select, { target: { value: "3" } });
    await waitFor(() => { expect(posts).toContainEqual({ url: "/setup-api/coding-agent/enable", body: { maxParallelRuns: 3 } }); });
    await waitFor(() => { expect((screen.getByTestId("coding-agent-max-parallel-runs") as HTMLSelectElement).value).toBe("3"); });
  });

  it("shows no control at all on a server that predates it", async () => {
    stubFetch({ enabled: true, readiness: READY }, { noMaxParallelRuns: true });
    render(<CodingAgentSettingsPanel />);
    await screen.findByRole("switch", { name: SWITCH });
    expect(screen.queryByTestId("coding-agent-max-parallel-runs")).toBeNull();
  });
});


describe("a team's model and effort per role", () => {
  const provider = (role: string) => screen.getByTestId(`coding-agent-role-${role}-provider`) as HTMLSelectElement;
  const model = (role: string) => screen.getByTestId(`coding-agent-role-${role}-model`) as HTMLSelectElement;
  const effort = (role: string) => screen.getByTestId(`coding-agent-role-${role}-effort`) as HTMLSelectElement;
  const texts = (select: HTMLSelectElement) => [...select.options].map((o) => o.text);
  const values = (select: HTMLSelectElement) => [...select.options].map((o) => o.value);
  const ENABLE = "/setup-api/coding-agent/enable";

  it("draws the three roles with an account, a model and an effort select each, and no price anywhere", async () => {
    stubFetch({ enabled: true, readiness: READY, effort: "max" });
    render(<CodingAgentSettingsPanel />);
    const planner = await screen.findByTestId("coding-agent-role-planner-provider") as HTMLSelectElement;
    const section = screen.getByTestId("coding-agent-role-models");
    expect([...section.querySelectorAll("[data-testid^='coding-agent-role-'][data-testid$='-provider']")].map((x) => x.getAttribute("data-testid")))
      .toEqual(["coding-agent-role-planner-provider", "coding-agent-role-worker-provider", "coding-agent-role-reviewer-provider"]);
    // The bulk row went with the role (2026-10-30).
    expect(screen.queryByTestId("coding-agent-role-bulk-provider")).toBeNull();
    // A server from before the connected list: every account the build knows is a connected one.
    expect(planner.value).toBe("auto");
    expect(texts(planner)).toEqual([t("codingAgent.roleProvider.auto"), "ClawBox AI", "Anthropic", "OpenAI (ChatGPT)"]);
    // On the team's own account the model select keeps the two older choices.
    expect(model("planner").value).toBe("auto");
    expect(texts(model("planner"))).toEqual(["Default (cheaper model)", "Your model", "Cheaper model"]);
    expect(texts(model("worker"))[0]).toBe("Default (your model)");
    expect(texts(effort("reviewer"))[0]).toBe("Default (at most Very high)");
    expect(texts(effort("worker"))[0]).toBe("Default (your effort)");
    expect(screen.getByLabelText("Model for Reviewers")).toBe(model("reviewer"));
    // Each row's label says what the role DOES, not only behind the help tip
    // (SCA C3): "Workers: write your code".
    expect(screen.getByTestId("coding-agent-role-worker-label")).toHaveTextContent(`${t("codingAgent.roleModels.worker")}: ${t("codingAgent.roleModelsRoleJob.worker")}`);
    expect(screen.getByTestId("coding-agent-role-planner-label")).toHaveTextContent(t("codingAgent.roleModelsRoleJob.planner"));
    expect(screen.getByTestId("coding-agent-role-reviewer-label")).toHaveTextContent(t("codingAgent.roleModelsRoleJob.reviewer"));
    // Nothing stored and no map answered: no "now on" line either.
    expect(screen.queryByTestId("coding-agent-role-planner-about")).toBeNull();
    // No price estimate anywhere on the card (the owner's ruling, 2026-10-28).
    expect(screen.queryByTestId("coding-agent-role-models-cost")).toBeNull();
    expect(section.textContent).not.toMatch(/the cost|×/);
    fireEvent.click(screen.getByTestId("coding-agent-role-models-help"));
    expect(section.textContent).toContain(t("codingAgent.roleModelsHint"));
    expect(t("codingAgent.roleModelsHint")).not.toMatch(/cheaper|cost/i);
  });

  it("pins a role to an account, then to one of its models, and back to Default — each half its own write", async () => {
    stubFetch({ enabled: true, readiness: READY, effort: "max" });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-role-planner-provider");

    fireEvent.change(provider("planner"), { target: { value: "anthropic" } });
    await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { roleModels: { planner: { provider: "anthropic" } } } }));
    await waitFor(() => expect(provider("planner").value).toBe("anthropic"));
    // Pinned, the model select offers that account's models and no tier.
    expect(texts(model("planner"))).toEqual([t("codingAgent.roleModel.autoForProvider"), "Opus 5.5", "Fable 5.1", "Opus 5", "Sonnet 5"]);
    expect(values(model("planner"))).not.toContain("deepseek-v4-pro");

    fireEvent.change(model("planner"), { target: { value: "claude-fable-5-1" } });
    await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { roleModels: { planner: { model: "claude-fable-5-1" } } } }));
    await waitFor(() => expect(model("planner").value).toBe("claude-fable-5-1"));

    // The reviewers on the plan's flash tier.
    fireEvent.change(provider("reviewer"), { target: { value: "clawbox-ai" } });
    await waitFor(() => expect(provider("reviewer").value).toBe("clawbox-ai"));
    expect(texts(model("reviewer"))).toEqual([t("codingAgent.roleModel.autoForProvider"), "DeepSeek Flash"]);
    fireEvent.change(model("reviewer"), { target: { value: "deepseek-v4-flash" } });
    await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { roleModels: { reviewer: { model: "deepseek-v4-flash" } } } }));

    fireEvent.change(provider("planner"), { target: { value: "auto" } });
    await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { roleModels: { planner: { provider: "auto" } } } }));
    await waitFor(() => expect(provider("planner").value).toBe("auto"));

    // The effort stays its own half.
    fireEvent.change(effort("reviewer"), { target: { value: "low" } });
    await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { roleModels: { reviewer: { effort: "low" } } } }));
    await waitFor(() => expect(effort("reviewer").value).toBe("low"));
  });

  it("offers only the connected accounts, and reads a pinned account that was disconnected back as such", async () => {
    stubFetch({ enabled: true, readiness: READY, effort: "max" }, {
      providers: ["clawbox-ai", "anthropic"],
      connectedProviders: ["clawbox-ai"],
      roleModels: {
        planner: { provider: "auto", model: "auto", effort: "auto" },
        worker: { provider: "auto", model: "auto", effort: "auto" },
        reviewer: { provider: "anthropic", model: "claude-sonnet-5", effort: "auto" },
      },
    });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-role-planner-provider");
    expect(texts(provider("planner"))).toEqual([t("codingAgent.roleProvider.auto"), "ClawBox AI"]);
    expect(provider("reviewer").value).toBe("anthropic");
    expect(texts(provider("reviewer"))).toEqual([t("codingAgent.roleProvider.auto"), "ClawBox AI", t("codingAgent.roleProvider.notConnected", { provider: "Anthropic" })]);
    expect(model("reviewer").value).toBe("claude-sonnet-5");
  });

  it("says once why a connected account cannot run, and marks the role stored on it", async () => {
    const MISSING = "No Anthropic account is connected: add an API key or sign in.";
    stubFetch(
      {
        enabled: true,
        effort: "max",
        readiness: {
          ...READY,
          anthropicConnected: false,
          providers: [
            { id: "clawbox-ai", ready: true, problems: [] },
            { id: "anthropic", ready: false, problems: [MISSING] },
          ],
        },
      },
      {
        roleModels: {
          planner: { provider: "auto", model: "auto", effort: "auto" },
          worker: { provider: "auto", model: "auto", effort: "auto" },
          reviewer: { provider: "anthropic", model: "claude-sonnet-5", effort: "auto" },
        },
        roleModelMap: {
          planner: { provider: "clawbox-ai", model: "deepseek-v4-flash", effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: 1 },
          worker: { provider: "clawbox-ai", model: null, effort: "max", auto: true, ready: true, problems: [], relativeCost: null },
          reviewer: { provider: "anthropic", model: "claude-sonnet-5", effort: "xhigh", auto: false, ready: false, problems: [MISSING], relativeCost: 10 },
        },
      },
    );
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-role-reviewer-model");
    // The reason, once, in the readiness check's own words.
    const reasons = screen.getByTestId("coding-agent-role-providers-unready");
    expect(reasons.querySelectorAll("li")).toHaveLength(1);
    expect(screen.getByTestId("coding-agent-role-provider-anthropic-unready")).toHaveTextContent(
      t("codingAgent.roleProviderNotReady", { provider: "Anthropic", reason: MISSING }),
    );
    // The stored choice still reads back as itself, and its row says it cannot start.
    expect(provider("reviewer").value).toBe("anthropic");
    expect(model("reviewer").value).toBe("claude-sonnet-5");
    expect(screen.getByTestId("coding-agent-role-reviewer-unready")).toHaveTextContent(t("codingAgent.roleModelCannotStart", { provider: "Anthropic" }));
    expect(screen.queryByTestId("coding-agent-role-planner-unready")).toBeNull();
    // The account that works is still one pick away.
    fireEvent.change(provider("reviewer"), { target: { value: "clawbox-ai" } });
    await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { roleModels: { reviewer: { provider: "clawbox-ai" } } } }));
  });

  it("names the box's own missing piece for every account it stops", async () => {
    stubFetch({
      enabled: true,
      readiness: {
        ...NOT_READY,
        providers: [
          { id: "clawbox-ai", ready: false, problems: [] },
          { id: "anthropic", ready: false, problems: ["No Anthropic account is connected."] },
        ],
      },
    });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-role-models");
    expect(screen.getByTestId("coding-agent-role-provider-clawbox-ai-unready")).toHaveTextContent(NOT_READY.problems[0]);
    const anthropic = screen.getByTestId("coding-agent-role-provider-anthropic-unready");
    expect(anthropic).toHaveTextContent(NOT_READY.problems[0]);
    expect(anthropic).toHaveTextContent("No Anthropic account is connected.");
  });

  it("says what each role starts on right now, and nothing about what a token of it costs", async () => {
    stubFetch({ enabled: true, readiness: READY }, {
      roleModelMap: {
        planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: 10 },
        worker: { provider: "clawbox-ai", model: null, effort: "max", auto: true, ready: true, problems: [], relativeCost: null },
        reviewer: { provider: "anthropic", model: "claude-sonnet-5", effort: "xhigh", auto: true, ready: true, problems: [], relativeCost: 10 },
      },
    });
    render(<CodingAgentSettingsPanel />);
    const planner = await screen.findByTestId("coding-agent-role-planner-about");
    // Only what it starts on: the role's job moved up onto the label (SCA C3).
    expect(planner.textContent).toBe(t("codingAgent.roleModelNow", { model: "Sonnet 5", provider: "Anthropic" }));
    expect(screen.getByTestId("coding-agent-role-planner-label")).toHaveTextContent(t("codingAgent.roleModelsRoleJob.planner"));
    // Where the plan picks the model, the account is still said.
    expect(screen.getByTestId("coding-agent-role-worker-about").textContent).toBe(
      t("codingAgent.roleModelNow", { model: t("codingAgent.roleModelPlanDecides"), provider: "ClawBox AI" }),
    );
  });

  it("reads the older standard/economy choices back unchanged, on a server that answers without providers", async () => {
    stubFetch({ enabled: true, readiness: READY, effort: "max" }, {
      roleModels: {
        planner: { model: "economy", effort: "auto" },
        worker: { model: "standard", effort: "xhigh" },
        reviewer: { model: "auto", effort: "low" },
      },
    });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-role-planner-model");
    expect(model("planner").value).toBe("economy");
    expect(model("planner").selectedOptions[0].text).toBe("Cheaper model");
    expect(model("worker").value).toBe("standard");
    expect(model("worker").selectedOptions[0].text).toBe("Your model");
    expect(model("reviewer").value).toBe("auto");
    expect(effort("worker").value).toBe("xhigh");
    // Reading is not writing.
    expect(posts).toEqual([]);
  });

  it("reads back a pair the list has no row for — an account on its default model, or a tier there — as itself", async () => {
    stubFetch({ enabled: true, readiness: READY, effort: "max" }, {
      roleModels: {
        planner: { provider: "anthropic", model: "economy", effort: "auto" },
        worker: { provider: "clawbox-ai", model: "auto", effort: "auto" },
        reviewer: { provider: "auto", model: "auto", effort: "auto" },
      },
    });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-role-planner-model");
    expect(provider("planner").value).toBe("anthropic");
    expect(model("planner").value).toBe("economy");
    expect(model("planner").selectedOptions[0].text).toBe("Cheaper model");
    expect(provider("worker").value).toBe("clawbox-ai");
    expect(model("worker").value).toBe("auto");
    expect(model("worker").selectedOptions[0].text).toBe(t("codingAgent.roleModel.autoForProvider"));
    // Only on the row that stores it.
    expect(values(model("reviewer"))).not.toContain("economy".repeat(0) + "claude-sonnet-5");
    expect(texts(model("reviewer"))).toEqual(["Default (cheaper model)", "Your model", "Cheaper model"]);
  });

  it("is not drawn for a server that does not answer with the setting", async () => {
    stubFetch({ enabled: true, readiness: READY }, { noRoleModels: true });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-effort");
    expect(screen.queryByTestId("coding-agent-role-models")).toBeNull();
  });
});

/**
 * The connected providers (the owner's brief, 2026-10-28): a team can run on
 * several accounts at once, so the single "Runs on" choice became a list with
 * Connect/Disconnect per account — OpenAI among them, on the Codex runner — and
 * a way to Settings → Providers.
 */
describe("the connected providers", () => {
  const ENABLE = "/setup-api/coding-agent/enable";
  const OPENAI_MISSING = "Your OpenAI account is not connected. Open the Coding Agent app → Settings and save an OpenAI API key, or sign in with ChatGPT there.";

  it("lists each account with Connect or Disconnect, OpenAI held until it is set up, and a way to Settings → Providers", async () => {
    stubFetch({ enabled: true, readiness: { ...READY, providers: [
      { id: "clawbox-ai", ready: true, problems: [] },
      { id: "anthropic", ready: true, problems: [] },
      { id: "openai", ready: false, problems: [OPENAI_MISSING] },
    ] } }, {
      providers: ["clawbox-ai", "anthropic", "openai"],
      connectedProviders: ["clawbox-ai"],
    });
    const opened: unknown[] = [];
    const onOpen = (e: Event) => opened.push((e as CustomEvent).detail);
    window.addEventListener("clawbox:open-app", onOpen);
    try {
      render(<CodingAgentSettingsPanel />);
      await screen.findByTestId("coding-agent-providers");
      expect(document.getElementById("coding-agent-provider-label")).toHaveTextContent(t("codingAgent.providerLabel"));
      // The one connected account cannot be the one that goes.
      expect(screen.getByTestId("coding-agent-provider-clawbox-ai")).toHaveAttribute("data-connected", "true");
      expect(screen.getByTestId("coding-agent-provider-clawbox-ai-connected")).toBeInTheDocument();
      const last = screen.getByTestId("coding-agent-provider-disconnect-clawbox-ai");
      expect(last).toBeDisabled();
      expect(last).toHaveAttribute("title", t("codingAgent.providers.lastOne"));
      // The other is one click away, and the click sends the WHOLE list.
      expect(screen.getByTestId("coding-agent-provider-anthropic")).toHaveAttribute("data-connected", "false");
      fireEvent.click(screen.getByTestId("coding-agent-provider-connect-anthropic"));
      await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { providers: ["clawbox-ai", "anthropic"] } }));
      await screen.findByTestId("coding-agent-provider-anthropic-connected");
      expect(screen.getByTestId("coding-agent-provider-disconnect-clawbox-ai")).not.toBeDisabled();
      // OpenAI: a real account now, on the Codex runner — one row, held at
      // Connect until its own credential is there, saying what is missing.
      expect(screen.getAllByTestId("coding-agent-provider-openai")).toHaveLength(1);
      const openai = screen.getByTestId("coding-agent-provider-openai");
      expect(openai).toHaveAttribute("data-connected", "false");
      expect(openai).not.toHaveAttribute("data-runner");
      expect(openai).toHaveTextContent("OpenAI (ChatGPT)");
      expect(screen.getByTestId("coding-agent-provider-connect-openai")).toBeDisabled();
      expect(screen.getByTestId("coding-agent-provider-openai-not-set-up")).toHaveTextContent(OPENAI_MISSING);
      // …and the card that sets it up is on the same page.
      expect(screen.getByTestId("coding-agent-openai-card")).toBeInTheDocument();
      // Settings → Providers, through the desktop's own handoff.
      fireEvent.click(screen.getByTestId("coding-agent-providers-setup"));
      expect(opened.length).toBeGreaterThan(0);
      expect(JSON.stringify(opened)).toContain("settings");
    } finally {
      window.removeEventListener("clawbox:open-app", onOpen);
    }
  });

  it("marks the default account on its row and makes another connected one the default on a click", async () => {
    stubFetch({ enabled: true, readiness: { ...READY, providers: [{ id: "clawbox-ai", ready: true, problems: [] }, { id: "anthropic", ready: true, problems: [] }] } }, {
      providers: ["clawbox-ai", "anthropic"],
      provider: "clawbox-ai",
      connectedProviders: ["clawbox-ai", "anthropic"],
    });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-providers");
    const current = screen.getByTestId("coding-agent-provider-default-clawbox-ai");
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(current).toBeDisabled();
    expect(current).toHaveTextContent(t("codingAgent.providers.default"));
    const other = screen.getByTestId("coding-agent-provider-default-anthropic");
    expect(other).toHaveAttribute("aria-pressed", "false");
    expect(other).toHaveTextContent(t("codingAgent.providers.makeDefault"));
    fireEvent.click(other);
    await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { provider: "anthropic" } }));
    await waitFor(() => expect(screen.getByTestId("coding-agent-provider-default-anthropic")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.getByTestId("coding-agent-provider-default-clawbox-ai")).toHaveAttribute("aria-pressed", "false");
  });

  it("greys Connect for an account that is not set up, and says why in the readiness check's words", async () => {
    const MISSING = "No Anthropic account is connected: add an API key or sign in.";
    stubFetch({ enabled: true, readiness: { ...READY, anthropicConnected: false, providers: [{ id: "clawbox-ai", ready: true, problems: [] }, { id: "anthropic", ready: false, problems: [MISSING] }] } }, {
      providers: ["clawbox-ai", "anthropic"],
      connectedProviders: ["clawbox-ai"],
    });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-providers");
    expect(screen.getByTestId("coding-agent-provider-connect-anthropic")).toBeDisabled();
    expect(screen.getByTestId("coding-agent-provider-anthropic-not-set-up")).toHaveTextContent(t("codingAgent.providers.notSetUp", { provider: "Anthropic", reason: MISSING }));
    expect(posts).toEqual([]);
  });

  it("puts the roles pinned to a disconnected account back on Default, and says so", async () => {
    stubFetch({ enabled: true, readiness: { ...READY, providers: [{ id: "clawbox-ai", ready: true, problems: [] }, { id: "anthropic", ready: true, problems: [] }] } }, {
      providers: ["clawbox-ai", "anthropic"],
      connectedProviders: ["clawbox-ai", "anthropic"],
      roleModels: {
        planner: { provider: "anthropic", model: "claude-sonnet-5", effort: "auto" },
        worker: { provider: "auto", model: "auto", effort: "auto" },
        reviewer: { provider: "anthropic", model: "auto", effort: "auto" },
      },
    });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-providers");
    fireEvent.click(screen.getByTestId("coding-agent-provider-disconnect-anthropic"));
    await waitFor(() => expect(posts).toContainEqual({ url: ENABLE, body: { providers: ["clawbox-ai"] } }));
    const note = await screen.findByTestId("coding-agent-providers-roles-reset");
    expect(note).toHaveTextContent(t("codingAgent.providers.rolesReset", { roles: `${t("codingAgent.roleModels.planner")}, ${t("codingAgent.roleModels.reviewer")}`, provider: "Anthropic" }));
    expect((screen.getByTestId("coding-agent-role-planner-provider") as HTMLSelectElement).value).toBe("auto");
    expect((screen.getByTestId("coding-agent-role-reviewer-provider") as HTMLSelectElement).value).toBe("auto");
    // The disconnected account is no longer offered to any role.
    expect([...(screen.getByTestId("coding-agent-role-worker-provider") as HTMLSelectElement).options].map((o) => o.text)).toEqual([t("codingAgent.roleProvider.auto"), "ClawBox AI"]);
  });

  it("is not drawn for a server that predates the picker", async () => {
    stubFetch({ enabled: true, readiness: READY });
    render(<CodingAgentSettingsPanel />);
    await screen.findByTestId("coding-agent-effort");
    expect(screen.queryByTestId("coding-agent-providers")).toBeNull();
  });
});
