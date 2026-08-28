/**
 * GH-01d. The GitHub row of the Coding Agent settings — Settings → Coding
 * Agent (CodingAgentSettingsPanel), where the card moved from the app.
 *
 * #518 split one failure into three reasons and added all three to this
 * component's GitHubState type — and then branched on only one of them.
 * `githubStatus()` answers `{ installed: true, reason: "not_runnable" }` for a
 * gh that is sitting on the box with the wrong mode bits, so the row rendered
 * (it is gated on `installed`), said "not connected", and offered Connect —
 * which opens a terminal on `gh auth login`, the remedy the library layer
 * explicitly refuses to suggest: "Installing it again fixes nothing; the
 * remedy is permissions."
 *
 * backupToGitHub() and disconnectGitHub() both got a not_runnable message.
 * The surface the owner actually looks at did not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import CodingAgentSettingsPanel from "@/components/CodingAgentSettingsPanel";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const READY = { ready: true, wrapperInstalled: true, claudeInstalled: true, clawaiConnected: true, problems: [] as string[] };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The device answering the two loads the panel makes, with `git` under test. */
function stubFetch(github: Record<string, unknown>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = input.toString();
    if (url.startsWith("/setup-api/coding-agent/status")) {
      return json({
        enabled: true, ready: true, readiness: READY, running: 0,
        harnessCommand: "claude-ds", maxTaskChars: 4000, defaultDirectory: null,
      });
    }
    if (url.startsWith("/setup-api/coding-agent/runs")) return json({ runs: [] });
    if (url.startsWith("/setup-api/coding-agent/git")) return json(github);
    return json({ error: "unexpected" }, 404);
  }));
}

const LOGIN_COMMAND = "gh auth login --hostname github.com --git-protocol https";

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a gh that is installed but will not run", () => {
  it("does not say 'not connected' — that is not what was found", async () => {
    stubFetch({ installed: true, connected: false, login: null, loginCommand: LOGIN_COMMAND, reason: "not_runnable" });
    render(<CodingAgentSettingsPanel />);

    const badge = await screen.findByTestId("coding-agent-github-not-runnable");
    expect(badge).toBeTruthy();
    expect(screen.queryByText(translations.en["codingAgent.githubOff"])).toBeNull();
  });

  it("says gh would not start and points at permissions, in real English copy", async () => {
    stubFetch({ installed: true, connected: false, login: null, loginCommand: LOGIN_COMMAND, reason: "not_runnable" });
    render(<CodingAgentSettingsPanel />);

    const badge = await screen.findByTestId("coding-agent-github-not-runnable");
    // A missing key would render the key itself; this pins real copy.
    expect(badge.textContent ?? "").not.toContain("codingAgent.");
    expect(badge.textContent ?? "").toMatch(/permission/i);
  });

  it("does not offer Connect, which opens the one remedy that cannot work", async () => {
    stubFetch({ installed: true, connected: false, login: null, loginCommand: LOGIN_COMMAND, reason: "not_runnable" });
    render(<CodingAgentSettingsPanel />);

    await screen.findByTestId("coding-agent-github-not-runnable");
    const connect = screen.queryByTestId("coding-agent-github-connect");
    // Either gone or visibly unusable — never a live button onto `gh auth login`.
    expect(connect === null || (connect as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the reasons that already worked keep working", () => {
  it("still shows the unreachable badge for a network fault", async () => {
    stubFetch({ installed: true, connected: false, login: null, loginCommand: LOGIN_COMMAND, reason: "unreachable" });
    render(<CodingAgentSettingsPanel />);

    expect(await screen.findByTestId("coding-agent-github-unreachable")).toBeTruthy();
    expect(screen.queryByTestId("coding-agent-github-not-runnable")).toBeNull();
  });

  it("still offers Connect to a gh that simply has nobody logged in", async () => {
    stubFetch({ installed: true, connected: false, login: null, loginCommand: LOGIN_COMMAND });
    render(<CodingAgentSettingsPanel />);

    const connect = await screen.findByTestId("coding-agent-github-connect");
    expect((connect as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(screen.getByText(translations.en["codingAgent.githubOff"])).toBeTruthy());
  });

  it("still shows the account when one is connected", async () => {
    stubFetch({ installed: true, connected: true, login: "yalexx", loginCommand: LOGIN_COMMAND });
    render(<CodingAgentSettingsPanel />);

    expect((await screen.findByTestId("coding-agent-github-login")).textContent).toBe("yalexx");
    expect(screen.queryByTestId("coding-agent-github-not-runnable")).toBeNull();
  });
});
