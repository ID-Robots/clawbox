/**
 * The chat's coding cards host (src/components/CodingChatCards.tsx): one
 * family — team cards, then run cards — rendered by BOTH chats, with Open
 * handing the app a run or a team in a normal window and × putting a card
 * away for good. The poller is stubbed at the hook: what is under test is the
 * host, not the poll.
 */
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import {
  OPEN_APP_EVENT,
  OPEN_CODING_RUN_EVENT,
  OPEN_CODING_TEAM_EVENT,
  takePendingCodingRun,
  takePendingCodingTeam,
  type OpenAppDetail,
} from "@/lib/ui-events";
import type { CodingAgentActivity, TeamActivity } from "@/lib/use-coding-agent-activity";

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => translations.en[key] ?? key, locale: "en" }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const NOW = Date.now();
const RUN: CodingAgentActivity = {
  id: "run-view0001", projectId: "timer", task: "Build a timer",
  startedAt: NOW - 30_000, completedAt: null,
  status: "running", source: "agent",
  subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
  tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
  progress: [], screenshots: [], todos: [],
  transcriptPath: null, sessionId: null, directory: null,
  teamId: null, summaryLine: null, errorLine: null, needsYou: false, refusedLine: null, prNumber: null,
};
const TEAM: TeamActivity = {
  id: "team-k3x9q2ab", projectId: "sca", directory: "/srv/projects/sca", goal: "Settings drawer and export",
  status: "working", source: "agent", startedAt: NOW - 60_000, finishedAt: null,
  tasksDone: 1, tasksTotal: 2, tasks: [], prNumber: null, resultLine: null, agents: [], tokensUsed: 0, errorLine: null,
};

const feed = vi.hoisted(() => ({ runs: [] as unknown[], teams: [] as unknown[] }));
vi.mock("@/lib/use-coding-agent-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-coding-agent-activity")>();
  return { ...actual, useCodingAgentActivity: () => ({ runs: feed.runs, teams: feed.teams, nudge: vi.fn() }) };
});
// The put-away list lives in the kv store; here it is this test's own map.
const kv = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/client-kv", () => ({
  get: (key: string) => kv.get(key) ?? null,
  set: (key: string, value: string) => { kv.set(key, value); },
}));

import { CodingChatCards, teamCardKey, useCodingChatCards } from "@/components/CodingChatCards";

function Host({ openFromChat = (open: () => void) => open(), canControl }: { openFromChat?: (open: () => void) => void; canControl?: boolean }) {
  const cards = useCodingChatCards(true);
  return (
    <div data-testid="host">
      <CodingChatCards cards={cards} openFromChat={openFromChat} canControl={canControl} />
      <span data-testid="auto-hidden">{cards.autoHiddenCount}</span>
    </div>
  );
}

const listeners: Array<() => void> = [];
function watchOpens() {
  const apps: OpenAppDetail[] = [];
  const runs: unknown[] = [];
  const teams: unknown[] = [];
  const onApp = (e: Event) => apps.push((e as CustomEvent<OpenAppDetail>).detail);
  const onRun = (e: Event) => runs.push((e as CustomEvent).detail);
  const onTeam = (e: Event) => teams.push((e as CustomEvent).detail);
  window.addEventListener(OPEN_APP_EVENT, onApp);
  window.addEventListener(OPEN_CODING_RUN_EVENT, onRun);
  window.addEventListener(OPEN_CODING_TEAM_EVENT, onTeam);
  listeners.push(() => {
    window.removeEventListener(OPEN_APP_EVENT, onApp);
    window.removeEventListener(OPEN_CODING_RUN_EVENT, onRun);
    window.removeEventListener(OPEN_CODING_TEAM_EVENT, onTeam);
  });
  return { apps, runs, teams };
}

beforeEach(() => {
  feed.runs = [RUN];
  feed.teams = [TEAM];
  kv.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ key: "k", value: null }), { status: 200, headers: { "content-type": "application/json" } })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const off of listeners.splice(0)) off();
  takePendingCodingRun();
  takePendingCodingTeam();
});

describe("CodingChatCards", () => {
  it("draws the team card before the run card, both with Open and ×", () => {
    render(<Host />);
    const cards = [...screen.getByTestId("host").querySelectorAll('[data-testid="coding-team-activity"], [data-testid="coding-agent-activity"]')];
    expect(cards.map((el) => el.getAttribute("data-testid"))).toEqual(["coding-team-activity", "coding-agent-activity"]);
    expect(screen.getByTestId("coding-team-activity-open")).toHaveTextContent("Open");
    expect(screen.getByTestId("coding-agent-activity-view")).toHaveTextContent("Open");
    expect(screen.getByTestId("coding-team-activity-dismiss")).toBeInTheDocument();
    expect(screen.getByTestId("coding-agent-activity-dismiss")).toBeInTheDocument();
  });

  it("Open on a run card hands the app the run in a plain window; on a team card, the team", () => {
    const seen = watchOpens();
    render(<Host />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-view"));
    expect(seen.runs).toEqual([{ runId: "run-view0001" }]);
    expect(seen.apps).toEqual([{ appId: "coding" }]);
    expect(takePendingCodingRun()).toBe("run-view0001");
    fireEvent.click(screen.getByTestId("coding-team-activity-open"));
    expect(seen.teams).toEqual([{ teamId: "team-k3x9q2ab" }]);
    expect(seen.apps).toEqual([{ appId: "coding" }, { appId: "coding" }]);
    expect(takePendingCodingTeam()).toBe("team-k3x9q2ab");
  });

  it("opens through the chat's openFromChat, so a phone can close the chat around it", () => {
    const openFromChat = vi.fn((open: () => void) => open());
    render(<Host openFromChat={openFromChat} />);
    fireEvent.click(screen.getByTestId("coding-team-activity-open"));
    fireEvent.click(screen.getByTestId("coding-agent-activity-view"));
    expect(openFromChat).toHaveBeenCalledTimes(2);
  });

  it("× puts a card away for good, a team keyed team:<id> in the same kv list as the runs", async () => {
    render(<Host />);
    fireEvent.click(screen.getByTestId("coding-team-activity-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("coding-team-activity")).toBeNull());
    expect(screen.getByTestId("coding-agent-activity")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("coding-agent-activity-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("coding-agent-activity")).toBeNull());
    const stored = JSON.parse(kv.get("clawbox-chat-dismissed-coding-runs") ?? "[]") as string[];
    expect(stored).toEqual([teamCardKey("team-k3x9q2ab"), "run-view0001"]);
    // Put away with × is not what the 🤖 chip brings back.
    expect(screen.getByTestId("auto-hidden")).toHaveTextContent("0");
  });

  it("Pause / Resume on a run's card only when the host says the viewer is the owner (canControl), and why a paused run is paused", () => {
    render(<Host />);
    expect(screen.queryByTestId("coding-agent-activity-pause")).toBeNull();
    cleanup();
    render(<Host canControl />);
    // The control lives on the EXPANDED card: the collapsed row keeps Open and × alone.
    expect(screen.queryByTestId("coding-agent-activity-pause")).toBeNull();
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.getByTestId("coding-agent-activity-pause")).toHaveAttribute("aria-label", translations.en["codingAgent.pause"]);
    cleanup();
    // A paused run whose allowance ran out: Resume, and the run page's own sentence beside it.
    feed.runs = [{ ...RUN, status: "paused", needsYou: true, pauseReason: { kind: "allowance", meter: "images", resetsAt: "2026-10-31T09:00:00.000Z", message: "quota" } }];
    render(<Host canControl />);
    fireEvent.click(screen.getByTestId("coding-agent-activity-toggle"));
    expect(screen.getByTestId("coding-agent-activity-resume")).toHaveAttribute("aria-label", translations.en["codingAgent.resume"]);
    // The mocked `t` leaves `{time}` in place; the whole sentence is pinned
    // by src/tests/unit/coding-pause-reason-copy.test.ts.
    expect(screen.getByTestId("coding-agent-activity-pause-reason")).toHaveTextContent(translations.en["codingAgent.pausedAllowanceImages"]);
    // Both chats hand the host the owner's word, and only that.
    for (const file of ["src/components/ChatPopup.tsx", "src/components/ChatApp.tsx"]) {
      const src = fs.readFileSync(path.join(process.cwd(), file), "utf-8");
      // Tempered: the element's props hold arrows (`=>`), so "up to the `/>`" rather than "no `>`".
      expect(src, file).toMatch(/<CodingChatCards\b(?:(?!\/>)[\s\S])*?\bcanControl(=\{chatUser === null\}|\s)/);
    }
  });

  it("shows nothing for a run that belongs to a team — the team's card shows it", () => {
    feed.runs = [{ ...RUN, teamId: "team-k3x9q2ab" }, RUN];
    // The hook already hides a member run; the host draws what the hook holds.
    // This pins that a run WITH a team id still drawn by a stubbed hook is a
    // run card like any other — the hiding is the hook's, tested with it.
    render(<Host />);
    expect(screen.getAllByTestId("coding-agent-activity")).toHaveLength(2);
  });
});

describe("both chats render the host", () => {
  const read = (file: string) => fs.readFileSync(path.join(process.cwd(), "src/components", file), "utf-8");
  it("ChatPopup and ChatApp each render CodingChatCards, the Create card slot and the + from the one host", () => {
    for (const file of ["ChatPopup.tsx", "ChatApp.tsx"]) {
      const src = read(file);
      expect(src, file).toMatch(/<CodingChatCards\b/);
      expect(src, file).toMatch(/<NewAppCardSlot\b/);
      expect(src, file).toMatch(/<NewAppToggleButton\b/);
      expect(src, file).toMatch(/useCodingChatCards\(/);
      // Neither draws a run card of its own any more.
      expect(src, file).not.toMatch(/<CodingAgentActivityPill\b/);
    }
  });
  it("the full-page chat sends the Create card's message: it listens for CHAT_MESSAGE_EVENT", () => {
    expect(read("ChatApp.tsx")).toMatch(/addEventListener\(CHAT_MESSAGE_EVENT/);
  });
});
