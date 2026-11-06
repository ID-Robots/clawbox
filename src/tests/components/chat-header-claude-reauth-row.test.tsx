import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { translations } from "@/lib/translations";

// A jsdom mount of `ChatPopup` costs seconds under a full parallel run; see
// `test-timeout-hygiene.test.ts` for why every such suite declares both.
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
 * `reauthRequired` used to mean ONE thing — a ChatGPT sign-in filed the way an
 * older OpenClaw read it — and the note a click on such a row adds says so.
 * `/setup-api/chat/model` now greys a Claude sign-in the same way when the
 * gateway's store holds only a dead refresh marker for it (2026-10-10,
 * `claudeSignInFenced`). That row must send the owner to sign in again without
 * borrowing ChatGPT's reason: nothing about a fenced Claude sign-in "predates
 * the installed OpenClaw".
 */

/** GET /setup-api/chat/model as the route answers it for a fenced Claude sign-in beside ClawBox AI. */
function fencedClaudeState() {
  return {
    activeOptionId: "clawai/deepseek-v4-flash",
    activeModel: "deepseek/deepseek-v4-flash",
    activeSource: "primary",
    activeLabel: "ClawBox AI",
    options: [
      {
        id: "clawai/deepseek-v4-flash",
        label: "ClawBox AI",
        model: "deepseek/deepseek-v4-flash",
        provider: "clawai",
        available: true,
        settingsSection: "ai",
        isLocal: false,
      },
      {
        id: "anthropic/claude-sonnet-4-6",
        label: "Anthropic Claude",
        model: "anthropic/claude-sonnet-4-6",
        provider: "anthropic",
        available: false,
        reauthRequired: true,
        settingsSection: "ai",
        isLocal: false,
      },
    ],
    primary: { available: true, label: "ClawBox AI", model: "deepseek/deepseek-v4-flash" },
    local: { available: false, label: null, model: null },
    subscriptionProviders: [],
  };
}

function installFetch(state: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => state };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: [] }) };
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
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

async function claudeRow(): Promise<HTMLElement> {
  const trigger = await screen.findByRole("button", { name: /Chat provider/i });
  fireEvent.click(trigger);
  await waitFor(() => expect(screen.getAllByRole("option").length).toBeGreaterThan(1));
  return screen.getAllByRole("option").find((option) => option.textContent?.includes("Anthropic Claude"))!;
}

describe("a Claude sign-in the gateway's store holds only a dead marker for", () => {
  it("greys the row with 'sign in again', not 'set up'", async () => {
    installFetch(fencedClaudeState());
    render(<ChatPopup isOpen onClose={() => {}} />);

    const row = await claudeRow();
    expect(row.textContent).toContain("Sign in again");
    expect(row.textContent).not.toContain("Set up in Settings");
  });

  it("opens Settings and says to sign in again, without ChatGPT's reason", async () => {
    installFetch(fencedClaudeState());
    const onOpenSettingsSection = vi.fn();
    render(<ChatPopup isOpen onClose={() => {}} onOpenSettingsSection={onOpenSettingsSection} />);

    fireEvent.click(await claudeRow());

    const note = await screen.findByText(/Anthropic Claude needs you to sign in again/i);
    // The stale-ChatGPT explanation is false for this row: the installed
    // OpenClaw routes a Claude sign-in fine, this one's credential is dead.
    expect(note.textContent).not.toMatch(/predates the installed OpenClaw/i);
    expect(note.textContent).toMatch(/stopped working/i);
    expect(note.textContent).toMatch(/Opened Settings/i);
    expect(onOpenSettingsSection).toHaveBeenCalledWith("ai");
    // Nothing is posted for a row the gateway cannot use.
    expect(vi.mocked(fetch).mock.calls.some(([url, init]) =>
      String(url).includes("/setup-api/chat/model")
      && (init as RequestInit | undefined)?.method === "POST")).toBe(false);
  });
});
