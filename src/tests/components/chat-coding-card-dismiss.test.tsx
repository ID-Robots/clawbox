import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";
import { DISMISSED_CODING_RUNS_KEY } from "@/lib/use-dismissed-coding-runs";

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
 * Putting a coding-run card away — for good.
 *
 * The owner's ask: a run lasts many minutes and its card is the last thing in
 * the transcript, so it sat under every new message for the whole of that
 * time. The × on a card hides it. Their report after that: the card came back
 * — the set was React state, emptied when the chat closed and lost on a
 * reload, and the 🤖 chip brought it back with the cards that left on their
 * own. Now the run id is in the owner's kv store
 * (src/lib/use-dismissed-coding-runs.ts) and the chip is only for cards that
 * left on their own (chat-coding-card-auto-hide.test.tsx).
 *
 * The device's run record is stubbed at the hook: what is under test is the
 * chat's own state, not the poll. client-kv — the page's copy of the store —
 * is a plain map, and `/setup-api/kv?key=…` — the device's — is answered in
 * fetch.
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

// Plain functions over hoisted state: this suite runs with `mockReset`.
const kv = vi.hoisted(() => ({
  cache: new Map<string, string>(),
  device: null as string | null,
  deviceFails: false,
  cacheFails: false,
}));

vi.mock("@/lib/client-kv", () => ({
  init: async () => {},
  get: (key: string) => {
    if (kv.cacheFails) throw new Error("cache unreadable");
    return kv.cache.get(key) ?? null;
  },
  getJSON: () => null,
  set: (key: string, value: string) => {
    kv.cache.set(key, value);
    // What a flush would deliver: this page's write lands on the device.
    if (key === DISMISSED_CODING_RUNS_KEY) kv.device = value;
  },
  setJSON: () => {},
  remove: () => {},
  flush: () => {},
}));

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.startsWith(`/setup-api/kv?key=${DISMISSED_CODING_RUNS_KEY}`)) {
        if (kv.deviceFails) throw new TypeError("Failed to fetch");
        return { ok: true, json: async () => ({ key: DISMISSED_CODING_RUNS_KEY, value: kv.device }) };
      }
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
  kv.cache.clear();
  kv.device = null;
  kv.deviceFails = false;
  kv.cacheFails = false;
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
const storedIds = () => JSON.parse(kv.device ?? "null");
const dismissOf = (card: HTMLElement) => card.querySelector<HTMLButtonElement>('[data-testid="coding-agent-activity-dismiss"]')!;

describe("dismissing a coding-run card in the chat", () => {
  it("draws every run as a card, and no restore chip while none is put away", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    expect(await screen.findAllByTestId("coding-agent-activity")).toHaveLength(2);
    expect(cardTitles()[0]).toContain("Alpha task");
    expect(cardTitles()[1]).toContain("Beta task");
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("× hides THAT card, keeps its run id in the owner's store, and draws no chip that would bring it back", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");

    const closes = screen.getAllByRole("button", { name: DISMISS });
    expect(closes).toHaveLength(2);
    fireEvent.click(closes[0]);

    expect(cards()).toHaveLength(1);
    expect(cardTitles()[0]).toContain("Beta task");
    expect(storedIds()).toEqual(["run-alpha"]);
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("stays hidden when the chat closes and opens again", async () => {
    const { rerender } = render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");
    fireEvent.click(screen.getAllByRole("button", { name: DISMISS })[0]);
    expect(cards()).toHaveLength(1);

    rerender(<ChatPopup isOpen={false} onClose={() => {}} />);
    rerender(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(cardTitles()[0]).toContain("Beta task");
    // And the read of the device that comes with opening leaves it gone too.
    await act(async () => {});
    expect(cards()).toHaveLength(1);
    expect(screen.queryByTestId("coding-agent-restore")).not.toBeInTheDocument();
  });

  it("stays hidden on a fresh mount — a reload — that reads it from the store", async () => {
    const first = render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");
    fireEvent.click(screen.getAllByRole("button", { name: DISMISS })[0]);
    first.unmount();

    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");
    expect(cards()).toHaveLength(1);
    expect(cardTitles()[0]).toContain("Beta task");
  });

  it("hides a card another window put away, once the chat reads the device", async () => {
    kv.device = JSON.stringify(["run-beta"]);
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => expect(cardTitles()).toEqual([expect.stringContaining("Alpha task")]));
  });

  it("a card whose run is still in flight goes for good as well", async () => {
    const { rerender } = render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");
    expect(cards()[1]).toHaveAttribute("data-status", "running");
    fireEvent.click(dismissOf(cards()[1]));
    expect(cardTitles()).toEqual([expect.stringContaining("Alpha task")]);
    expect(storedIds()).toEqual(["run-beta"]);

    rerender(<ChatPopup isOpen={false} onClose={() => {}} />);
    rerender(<ChatPopup isOpen onClose={() => {}} />);
    await act(async () => {});
    expect(cardTitles()).toEqual([expect.stringContaining("Alpha task")]);
  });

  it("× on one card leaves the other as it was, closed", async () => {
    render(<ChatPopup isOpen onClose={() => {}} />);
    await screen.findAllByTestId("coding-agent-activity");
    fireEvent.click(screen.getAllByRole("button", { name: DISMISS })[1]);
    const toggles = screen.getAllByTestId("coding-agent-activity-toggle");
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).toHaveAttribute("aria-expanded", "false");
  });

  describe("the keyboard focus after ×", () => {
    it("goes to the next card's ×, then the one before, then the transcript — never <body>", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await screen.findAllByTestId("coding-agent-activity");
      const transcript = screen.getByTestId("chat-transcript");

      const alphaClose = dismissOf(cards()[0]);
      act(() => alphaClose.focus());
      fireEvent.click(alphaClose);
      expect(cards()).toHaveLength(1);
      expect(document.activeElement).toBe(dismissOf(cards()[0]));
      expect(cards()[0]).toHaveAttribute("data-run-id", "run-beta");

      fireEvent.click(document.activeElement!);
      expect(cards()).toHaveLength(0);
      expect(document.activeElement).toBe(transcript);
    });

    it("goes to the card before when the last card is put away", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await screen.findAllByTestId("coding-agent-activity");
      const betaClose = dismissOf(cards()[1]);
      act(() => betaClose.focus());
      fireEvent.click(betaClose);
      expect(document.activeElement).toBe(dismissOf(cards()[0]));
      expect(cards()[0]).toHaveAttribute("data-run-id", "run-alpha");
    });

    it("is moved when it was nowhere — a browser that does not focus a pressed button", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await screen.findAllByTestId("coding-agent-activity");
      act(() => (document.activeElement as HTMLElement | null)?.blur());
      expect(document.activeElement).toBe(document.body);
      fireEvent.click(dismissOf(cards()[0]));
      expect(document.activeElement).toBe(dismissOf(cards()[0]));
    });

    it("is left alone when it is somewhere else in the chat", async () => {
      render(<ChatPopup isOpen onClose={() => {}} />);
      await screen.findAllByTestId("coding-agent-activity");
      const betaToggle = cards()[1].querySelector<HTMLButtonElement>('[data-testid="coding-agent-activity-toggle"]')!;
      act(() => betaToggle.focus());
      fireEvent.click(dismissOf(cards()[0]));
      expect(document.activeElement).toBe(betaToggle);
    });
  });

  describe("a store that cannot be read shows the cards", () => {
    it("the page's copy throwing", async () => {
      kv.cacheFails = true;
      render(<ChatPopup isOpen onClose={() => {}} />);
      expect(await screen.findAllByTestId("coding-agent-activity")).toHaveLength(2);
    });

    it("the page's copy damaged", async () => {
      kv.cache.set(DISMISSED_CODING_RUNS_KEY, "{not a list");
      render(<ChatPopup isOpen onClose={() => {}} />);
      expect(await screen.findAllByTestId("coding-agent-activity")).toHaveLength(2);
    });

    it("the device unreachable", async () => {
      kv.deviceFails = true;
      render(<ChatPopup isOpen onClose={() => {}} />);
      await screen.findAllByTestId("coding-agent-activity");
      await act(async () => {});
      expect(cards()).toHaveLength(2);
    });

    it("the device's copy damaged", async () => {
      kv.device = '"everything"';
      render(<ChatPopup isOpen onClose={() => {}} />);
      await screen.findAllByTestId("coding-agent-activity");
      await act(async () => {});
      expect(cards()).toHaveLength(2);
    });
  });
});
