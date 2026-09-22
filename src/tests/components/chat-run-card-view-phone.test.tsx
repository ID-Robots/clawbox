import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";
import {
  OPEN_APP_EVENT,
  OPEN_CODING_RUN_EVENT,
  takePendingCodingRun,
  type OpenAppDetail,
} from "@/lib/ui-events";

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
 * View on a coding-run card, on a phone (TASK-1065).
 *
 * The phone draws ONE app window, at a lower layer than the full-screen chat.
 * View opened the run's page in the Coding Agent there — under the chat, so
 * the press looked dead. The chat now gets out of the way on a phone, the
 * rule the + button already follows (chat-new-app-gate.test.tsx); on a
 * desktop it stays beside the window.
 *
 * The device's run record is stubbed at the hook: what is under test is the
 * chat's answer to the press, not the poll.
 */
const NOW = Date.now();
const RUN = {
  id: "run-view0001", projectId: "timer", task: "Build a timer",
  startedAt: NOW - 30_000, completedAt: null,
  status: "running" as const, source: "agent" as const,
  subagentsTotal: 0, subagentsActive: 0, subagentsByType: {},
  tokensUsed: 0, thinkingTokens: 0, filesTouched: 0, numTurns: 0,
  progress: [], screenshots: [], todos: [],
  transcriptPath: null, sessionId: null, directory: null,
};

vi.mock("@/lib/use-coding-agent-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/use-coding-agent-activity")>();
  return { ...actual, useCodingAgentActivity: () => ({ runs: [RUN], nudge: vi.fn() }) };
});

/** Every app, and every run, the desktop was asked to open while the test ran. */
function watchOpens(): { apps: OpenAppDetail[]; runs: unknown[] } {
  const apps: OpenAppDetail[] = [];
  const runs: unknown[] = [];
  const onApp = (e: Event) => apps.push((e as CustomEvent<OpenAppDetail>).detail);
  const onRun = (e: Event) => runs.push((e as CustomEvent).detail);
  window.addEventListener(OPEN_APP_EVENT, onApp);
  window.addEventListener(OPEN_CODING_RUN_EVENT, onRun);
  listeners.push(() => {
    window.removeEventListener(OPEN_APP_EVENT, onApp);
    window.removeEventListener(OPEN_CODING_RUN_EVENT, onRun);
  });
  return { apps, runs };
}
const listeners: Array<() => void> = [];

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
});

afterEach(() => {
  for (const off of listeners.splice(0)) off();
  // The cold-open handoff is parked on `window`; never leak it to the next test.
  takePendingCodingRun();
  cleanup();
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("View on a coding-run card", () => {
  it("on a phone, opens the run and closes the full-screen chat so the window is not hidden under it", async () => {
    const opened = watchOpens();
    const onClose = vi.fn();
    render(<ChatPopup isOpen mobile onClose={onClose} />);

    fireEvent.click(await screen.findByTestId("coding-agent-activity-view"));

    expect(opened.apps).toEqual([{ appId: "coding" }]);
    expect(opened.runs).toEqual([{ runId: RUN.id }]);
    // The Coding Agent may not be mounted yet: the run is parked for its cold open.
    expect(takePendingCodingRun()).toBe(RUN.id);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("on a desktop, opens the run and stays open beside the window", async () => {
    const opened = watchOpens();
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} />);

    fireEvent.click(await screen.findByTestId("coding-agent-activity-view"));

    expect(opened.apps).toEqual([{ appId: "coding" }]);
    expect(opened.runs).toEqual([{ runId: RUN.id }]);
    expect(onClose).not.toHaveBeenCalled();
  });
});

/**
 * The same rule for the chat's other window: picking a provider the box has
 * not set up opens Settings on its section. That is an app window too, and on
 * a phone it would open under the chat just the same.
 */
describe("picking a provider that is not set up", () => {
  const CHAT_MODEL = {
    activeOptionId: "clawai/deepseek-v4-flash",
    activeModel: "deepseek/deepseek-v4-flash",
    activeSource: "primary",
    activeLabel: "ClawBox AI",
    options: [
      { id: "clawai/deepseek-v4-flash", label: "ClawBox AI", model: "deepseek/deepseek-v4-flash", provider: "clawai", available: true, settingsSection: "ai", isLocal: false },
      { id: "anthropic", label: "Anthropic Claude", model: null, provider: "anthropic", available: false, settingsSection: "ai", isLocal: false },
    ],
    primary: { available: true, label: "ClawBox AI", model: "deepseek/deepseek-v4-flash" },
    local: { available: false, label: null, model: null },
    subscriptionProviders: [],
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/setup-api/harness/active")) {
          return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
        }
        if (url.includes("/setup-api/chat/model")) return { ok: true, json: async () => CHAT_MODEL };
        if (url.includes("/setup-api/chat/history")) return { ok: true, json: async () => ({ messages: [] }) };
        return { ok: true, json: async () => ({}) };
      }),
    );
  });

  /** Open the provider picker (unfolding the phone's picker row first) and pick the unset one. */
  async function pickUnsetProvider() {
    await screen.findByTestId("chat-composer");
    const fold = screen.queryByTestId("composer-options-toggle");
    if (fold) fireEvent.click(fold);
    fireEvent.click(await screen.findByRole("button", { name: /Chat provider/i }));
    await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
    const row = screen.getAllByRole("option").find((option) => option.textContent?.includes("Anthropic Claude"));
    fireEvent.click(row!);
  }

  it("on a phone, opens Settings and closes the full-screen chat", async () => {
    const onOpenSettingsSection = vi.fn();
    const onClose = vi.fn();
    render(<ChatPopup isOpen mobile onClose={onClose} onOpenSettingsSection={onOpenSettingsSection} />);

    await pickUnsetProvider();

    await waitFor(() => expect(onOpenSettingsSection).toHaveBeenCalledWith("ai"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("on a desktop, opens Settings and stays open", async () => {
    const onOpenSettingsSection = vi.fn();
    const onClose = vi.fn();
    render(<ChatPopup isOpen onClose={onClose} onOpenSettingsSection={onOpenSettingsSection} />);

    await pickUnsetProvider();

    await waitFor(() => expect(onOpenSettingsSection).toHaveBeenCalledWith("ai"));
    // The note says so, in the conversation the owner is still looking at.
    await waitFor(() => expect(screen.getByText(/Opened Settings so you can set it up/)).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });
});
