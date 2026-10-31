import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { _resetSessionUserForTest } from "@/lib/use-session-user";
import { translations } from "@/lib/translations";

// A jsdom mount of `ChatPopup` — the fake gateway handshake, the model seed,
// the transcript — costs seconds under a full parallel run, and a case does it
// once and then waits on several sub-5 s `waitFor`s in series. Every component
// suite that mounts it declares both ceilings; `test-timeout-hygiene.test.ts`
// is the rule, and says there why 5 s is the wrong budget here and 30 s still
// fails a test that has genuinely hung.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


vi.mock("@/lib/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/i18n")>();
  return {
    ...actual,
    useT: () => ({ t: (key: string) => translations.en[key] ?? key }),
    I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  };
});

const FLASH_MODEL = "deepseek/deepseek-v4-flash";
const FLASH_OPTION = {
  id: FLASH_MODEL,
  label: "ClawBox AI",
  model: FLASH_MODEL,
  provider: "clawai",
  available: true,
  settingsSection: "ai",
  isLocal: false,
};
const OPENAI_OPTION = {
  ...FLASH_OPTION,
  id: "openai/gpt-5.4",
  label: "OpenAI GPT",
  model: "openai/gpt-5.4",
  provider: "openai",
};

function modelState(activeModel = "deepseek/deepseek-v4-pro", needsFlashModelMigration = false) {
  const activeOption = activeModel.startsWith("openai/") ? OPENAI_OPTION : FLASH_OPTION;
  return {
    activeOptionId: activeOption.id,
    activeModel,
    needsFlashModelMigration,
    activeSource: "primary",
    activeLabel: activeOption.label,
    options: [FLASH_OPTION, OPENAI_OPTION],
    primary: { available: true, label: activeOption.label, model: activeOption.model },
    local: { available: false, label: null, model: null },
    subscriptionProviders: [],
  };
}

type FetchCall = { url: string; init?: RequestInit };

function installFetch({
  sessionUser = { username: "clawbox", isOwner: true, multiUser: false, openclawShared: false } as unknown,
  statusResponder = async () => ({ ok: true, json: async () => ({}) }),
  modelPostResponder = async () => ({ ok: true, json: async () => modelState(FLASH_MODEL) }),
  activeModel = "deepseek/deepseek-v4-pro",
  needsFlashModelMigration = false,
}: {
  /** /setup-api/users/me's answer; null for one that could not be had. */
  sessionUser?: unknown;
  statusResponder?: () => Promise<unknown>;
  modelPostResponder?: () => Promise<unknown>;
  activeModel?: string;
  needsFlashModelMigration?: boolean;
} = {}) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/users/me")) {
        return sessionUser === null ? { ok: false, status: 503, json: async () => ({}) } : { ok: true, json: async () => sessionUser };
      }
      if (url.includes("/setup-api/ai-models/status")) return statusResponder();
      if (url.includes("/setup-api/chat/model")) {
        if (init?.method === "POST") return modelPostResponder();
        return { ok: true, json: async () => modelState(activeModel, needsFlashModelMigration) };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
  return calls;
}

function modelWrites(calls: FetchCall[]): unknown[] {
  return calls
    .filter((call) => call.url.includes("/setup-api/chat/model") && call.init?.method === "POST")
    .map((call) => JSON.parse(String(call.init?.body ?? "{}")));
}

function occurrences(needle: string): number {
  return (document.body.textContent ?? "").split(needle).length - 1;
}

// Positive migration cases use the same settling window as the no-write
// cases, so a missing POST cannot simply be an effect we never waited for.
async function settle(calls: FetchCall[]) {
  await waitFor(() => {
    expect(calls.some((call) => call.url.includes("/setup-api/chat/model"))).toBe(true);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
}

beforeEach(() => {
  resetHarnessCache();
  _resetSessionUserForTest();
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

describe("ClawBox AI chat's automatic Flash migration", () => {
  it.each([
    ["Max account", { clawaiTier: "pro", clawaiAccountTier: "pro", clawaiAllowedModels: ["deepseek-v4-flash", "deepseek-v4-pro"] }],
    ["Flash account", { clawaiTier: "flash", clawaiAccountTier: "flash", clawaiAllowedModels: ["deepseek-v4-flash"] }],
    ["unknown subscription", {}],
  ])("uses Flash for a %s without checking entitlement", async (_label, status) => {
    const calls = installFetch({ statusResponder: async () => ({ ok: true, json: async () => status }) });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([{ model: FLASH_MODEL, automatic: true }]);
    expect(document.body.textContent).not.toMatch(/Max subscription|Switched to/i);
  });

  it("does not wait for subscription status to answer", async () => {
    const calls = installFetch({ statusResponder: () => new Promise(() => {}) });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([{ model: FLASH_MODEL, automatic: true }]);
  });

  it("migrates through the legacy clawai provider spelling", async () => {
    const calls = installFetch({ activeModel: "clawai/deepseek-v4-pro" });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([{ model: FLASH_MODEL, automatic: true }]);
  });

  it("repairs a legacy policy even when Flash is already the primary", async () => {
    const calls = installFetch({ activeModel: FLASH_MODEL, needsFlashModelMigration: true });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([{ model: FLASH_MODEL, automatic: true }]);
  });

  it.each([
    ["Flash is already active", FLASH_MODEL],
    ["another provider is active", "openai/gpt-5.4"],
  ])("does not write the primary when %s", async (_label, activeModel) => {
    const calls = installFetch({ activeModel });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([]);
  });

  it("never moves the box's model from another user's chat — their first desktop load moved the owner's", async () => {
    const calls = installFetch({
      activeModel: "deepseek/deepseek-v4-pro",
      sessionUser: { username: "alice", isOwner: false, multiUser: true, openclawShared: false },
    });
    render(<ChatPopup isOpen onClose={() => {}} chatUser="alice" />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([]);
    // The model is shown to them and moved by the owner: the picker is not theirs to open.
    const picker = screen.getByRole("button", { name: /chat provider/i });
    expect(picker).toBeDisabled();
  });

  it("does not move it either while nobody has said who is signed in", async () => {
    const calls = installFetch({ activeModel: "deepseek/deepseek-v4-pro", sessionUser: null });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([]);
  });
});

describe("a failed automatic Flash migration", () => {
  it("reports the failure once and does not enter a retry loop", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    let writes = 0;
    const calls = installFetch({
      modelPostResponder: async () => {
        writes += 1;
        // Stop an incorrect retry from spinning forever: the assertion still
        // detects that second POST, while React can finish rendering.
        if (writes > 1) return { ok: true, json: async () => modelState(FLASH_MODEL) };
        // Hold the request across a render to exercise the effect's dependency
        // on the switching callback, which changes identity during a switch.
        await held;
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: "Selected AI provider is not configured" }),
        };
      },
    });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => { expect(modelWrites(calls)).toHaveLength(1); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    await act(async () => { release(); });
    await settle(calls);

    expect(modelWrites(calls)).toEqual([{ model: FLASH_MODEL, automatic: true }]);
    expect(occurrences("Selected AI provider is not configured")).toBe(1);
    expect(document.body.textContent).not.toMatch(/Max subscription|Switched to/i);
  });

  it("tries again when the chat is closed and reopened", async () => {
    const calls = installFetch({
      modelPostResponder: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "Selected AI provider is not configured" }),
      }),
    });
    const { rerender } = render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);
    expect(modelWrites(calls)).toHaveLength(1);

    rerender(<ChatPopup isOpen={false} onClose={() => {}} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    rerender(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(modelWrites(calls)).toEqual([
      { model: FLASH_MODEL, automatic: true },
      { model: FLASH_MODEL, automatic: true },
    ]);
  });
});

// The bug this suite's last describe exists for, as the owner met it: a box set
// up minutes ago, Telegram skipped, the desktop painting for the first time —
// and the chat panel's first bubble is OpenClaw's config writer refusing a
// write nobody asked for, in the words it would use in a terminal.
describe("a migration that lost the config-mutation race", () => {
  /** What the CLI said, verbatim, in the red bubble on the real box. */
  const CLI_SENTENCE =
    "The config file changed while this command was writing (config changed since last load), "
    + "so nothing was changed. Re-run the same command to pick up the new file and try again.";
  const BUSY_COPY = translations.en["chat.modelSwitchBusy"];

  /** The route's answer once it knows the conflict by name. */
  const busyBody = {
    ok: false,
    status: 409,
    json: async () => ({
      error: "The box was saving its settings at the same moment, so nothing was changed. Try again in a moment.",
      code: "config_busy",
    }),
  };

  it("retries once, and says nothing at all when the retry lands", async () => {
    let posts = 0;
    const calls = installFetch({
      modelPostResponder: async () => {
        posts += 1;
        return posts === 1 ? busyBody : { ok: true, json: async () => modelState(FLASH_MODEL) };
      },
    });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => { expect(modelWrites(calls)).toHaveLength(2); });

    // A second POST, because only a fresh request re-reads the config — and
    // then silence, because a collision the box settled by itself is not news.
    expect(modelWrites(calls)).toEqual([
      { model: FLASH_MODEL, automatic: true },
      { model: FLASH_MODEL, automatic: true },
    ]);
    expect(document.body.textContent).not.toContain(BUSY_COPY);
    expect(document.body.textContent).not.toMatch(/config file|last load|Re-run/i);
  });

  it("says one short translated sentence when the retry loses too", async () => {
    const calls = installFetch({ modelPostResponder: async () => busyBody });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => { expect(document.body.textContent).toContain(BUSY_COPY); });
    await settle(calls);

    // Exactly two attempts — one retry, not a loop against a busy config.
    expect(modelWrites(calls)).toHaveLength(2);
    expect(occurrences(BUSY_COPY)).toBe(1);
    expect(document.body.textContent).not.toMatch(/config file|last load|Re-run|openclaw/i);
  });

  it("translates the CLI's sentence even from a server that sends no code", async () => {
    // Half a rolling update, or a box that has not taken the server fix yet:
    // the raw refusal still arrives in `error`, and it still must not be the
    // first thing the owner reads.
    const calls = installFetch({
      modelPostResponder: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: CLI_SENTENCE }),
      }),
    });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await waitFor(() => { expect(document.body.textContent).toContain(BUSY_COPY); });
    await settle(calls);

    expect(document.body.textContent).not.toContain(CLI_SENTENCE);
    expect(document.body.textContent).not.toMatch(/Re-run the same command/i);
  });

  it("still relays a failure that is not the conflict", async () => {
    // The guard is narrow on purpose: an error the owner can act on keeps its
    // own words rather than being softened into "try again in a moment".
    const calls = installFetch({
      modelPostResponder: async () => ({
        ok: false,
        status: 500,
        json: async () => ({ error: "Selected AI provider is not configured" }),
      }),
    });
    render(<ChatPopup isOpen onClose={() => {}} />);
    await settle(calls);

    expect(occurrences("Selected AI provider is not configured")).toBe(1);
    expect(document.body.textContent).not.toContain(BUSY_COPY);
    // Says the chat did NOT move, and to what, before the route's reason
    // (TASK-2055) — a bare "Error:" left the owner guessing.
    expect(document.body.textContent).toContain(
      "Could not switch the chat to DeepSeek V4 Flash. Selected AI provider is not configured",
    );
    expect(document.body.textContent).not.toContain("Error: Selected AI provider");
  });
});
