import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";

// See chat-header-close-button.test.tsx for why a ChatPopup mount gets 30 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => translations.en[key] ?? key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

/**
 * Putting a coding-run card away, and getting it back.
 *
 * The owner's ask: a run lasts many minutes and its card is the last thing in
 * the transcript, so it sat under every new message for the whole of that
 * time. The × on a card hides it; one small round 🤖 chip at the bottom-right
 * of the transcript brings it back. The chat owns the dismissed set — keyed
 * by run id, like `expandedLong` — and only FILTERS the list of cards, so a
 * restored card is the same card in its original place.
 *
 * The device's run record is stubbed at the hook: what is under test is the
 * chat's own state, not the poll.
 */
const NOW = Date.now();
const run = (id: string, task: string, status: "running" | "completed") => ({
  id, projectId: "timer", task,
  startedAt: NOW - 30_000, completedAt: status === "running" ? null : NOW,
  status, source: "agent" as const,
  subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
  tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
  progress: [], screenshots: [], todos: [],
  transcriptPath: null, sessionId: null, directory: null,
});
const RUNS = [run("run-alpha", "Alpha task", "completed"), run("run-beta", "Beta task", "running")];

vi.mock("@/lib/use-coding-agent-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-coding-agent-activity")>();
  return { ...actual, useCodingAgentActivity: () => ({ runs: RUNS, nudge: vi.fn() }) };
});

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return { ok: true, json: async () => ({ provider: "openrouter", current: "", reasoning: "medium", providers: [], models: [] }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
      send() {}
      addEventListener() {}
      removeEventListener() {}
    },
  );
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

const cards = () => screen.queryAllByTestId("coding-agent-activity");
const cardTitles = () => cards().map((el) => el.querySelector('[data-testid="coding-agent-activity-toggle"]')?.textContent ?? "");
const DISMISS = translations.en["codingAgent.chatDismiss"];
const RESTORE = translations.en["codingAgent.chatRestore"];

describe("dismissing a coding-run card in the chat", () => {
  it("draws every run as a card, and no restore chip while none is put away", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    expect(await screen.findAllByTestId("coding-agent-activity")).toHaveLength(2);
    expect(cardTitles()[0]).toContain("Alpha task");
    expect(cardTitles()[1]).toContain("Beta task");
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("× hides THAT card and leaves one round chip; the chip brings the card back where it was", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");

    // Put the first (finished) card away.
    const closes = screen.getAllByRole("button", { name: DISMISS });
    expect(closes).toHaveLength(2);
    fireEvent.click(closes[0]);

    expect(cards()).toHaveLength(1);
    expect(cardTitles()[0]).toContain("Beta task");
    const chip = screen.getByTestId("coding-agent-restore");
    expect(chip).toHaveAttribute("aria-label", RESTORE);
    // Round, and a thumb target: at least ~40px each way.
    expect(chip.style.borderRadius).toBe("50%");
    expect(parseInt(chip.style.width, 10)).toBeGreaterThanOrEqual(40);
    expect(parseInt(chip.style.height, 10)).toBeGreaterThanOrEqual(40);
    // At the END of the transcript, after the card that is still shown, and
    // stuck to the scrollport's bottom rather than floating over the newest
    // message.
    const row = screen.getByTestId("coding-agent-restore-row");
    expect(row.parentElement).toBe(screen.getByTestId("chat-transcript"));
    expect(cards()[0].compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.style.position).toBe("sticky");

    // Bring it back: same card, same place — first, not appended last.
    fireEvent.click(chip);
    expect(cards()).toHaveLength(2);
    expect(cardTitles()[0]).toContain("Alpha task");
    expect(cardTitles()[1]).toContain("Beta task");
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("one chip however many cards are put away, and one tap restores them all", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");
    for (const close of screen.getAllByRole("button", { name: DISMISS })) fireEvent.click(close);
    expect(cards()).toHaveLength(0);
    expect(screen.getAllByTestId("coding-agent-restore")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("coding-agent-restore"));
    expect(cards()).toHaveLength(2);
  });

  it("× does not open the card it is on", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");
    fireEvent.click(screen.getAllByRole("button", { name: DISMISS })[1]);
    fireEvent.click(screen.getByTestId("coding-agent-restore"));
    const toggles = screen.getAllByTestId("coding-agent-activity-toggle");
    for (const toggle of toggles) expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
