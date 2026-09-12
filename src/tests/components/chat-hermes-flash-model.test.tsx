import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@/tests/helpers/test-utils";
import { installHermesBox, mountHermesChat } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { HERMES_CHAT_PREFS_KEY } from "@/lib/hermes-chat-prefs";

beforeEach(() => {
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("Hermes ClawBox AI chat model", () => {
  it.each([
    { openclawState: "unavailable", staleOpenclawState: false },
    { openclawState: "a stale Pro selection", staleOpenclawState: true },
  ])("uses the existing Flash alias without changing OpenClaw when its state is $openclawState", async ({ staleOpenclawState }) => {
    window.localStorage.setItem(HERMES_CHAT_PREFS_KEY, JSON.stringify({
      provider: "clawai",
      models: { clawai: "deepseek-v4-pro" },
    }));
    const box = installHermesBox();
    const inner = globalThis.fetch;
    let openclawModelReads = 0;
    const openclawModelPosts: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/chat/model")) {
        if (init?.method === "POST") {
          openclawModelPosts.push(init.body);
        } else {
          openclawModelReads += 1;
        }
        if (staleOpenclawState) {
          return {
            ok: true,
            json: async () => ({
              activeOptionId: "clawai",
              activeModel: "deepseek/deepseek-v4-pro",
              activeLabel: "Max Tier",
              activeSource: "primary",
              options: [{
                id: "clawai",
                label: "ClawBox AI",
                provider: "clawai",
                model: "deepseek/deepseek-v4-pro",
                available: true,
                settingsSection: "ai",
                isLocal: false,
              }],
              primary: { available: true, label: "Max Tier", model: "deepseek/deepseek-v4-pro" },
              local: { available: false, label: null, model: null },
            }),
          };
        }
      }
      if (url.includes("/setup-api/hermes/models")) {
        box.fetchedUrls.push(url);
        return {
          ok: true,
          json: async () => ({
            providers: [{ id: "clawai", name: "ClawBox AI", authenticated: true }],
            provider: "clawai",
            authenticated: true,
            models: [
              { id: "deepseek-v4-flash", description: "Pro Tier" },
              { id: "deepseek-v4-pro", description: "Max Tier" },
            ],
            current: "deepseek-v4-pro",
            defaultModel: "deepseek-v4-pro",
            savedElsewhere: null,
            reasoning: "off",
            source: "dashboard",
            stale: false,
          }),
        };
      }
      return inner(input as RequestInfo, init);
    }));

    const textarea = await mountHermesChat(box);
    // The header names the provider and nothing more: no model picker for
    // ClawBox AI, and no read-only chip naming the model either. What the box
    // actually RUNS is asserted on the wire below, which is where it matters.
    await screen.findByLabelText(/^Chat provider:/);
    expect(screen.queryByText("Flash 4.1")).toBeNull();
    expect(screen.queryByLabelText(/^Hermes model:/)).toBeNull();
    expect(screen.queryByText("Max Tier")).toBeNull();

    fireEvent.change(textarea, { target: { value: "Use the current Flash model" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(box.chatPosts).toHaveLength(1));
    expect(box.chatPosts[0]).toMatchObject({
      provider: "clawai",
      model: "deepseek-v4-flash",
      message: "Use the current Flash model",
    });
    expect(openclawModelReads).toBeGreaterThan(0);
    expect(openclawModelPosts).toEqual([]);
    expect(box.socketsOpened).toBe(0);
  });
});
