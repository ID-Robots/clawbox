import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";
import { CLAWBOX_AI_CHAT_MODEL_LABEL, isClawboxAiProvider } from "@/lib/clawbox-ai-models";

// A jsdom mount of `ChatPopup` is the expensive thing here — the fake gateway
// handshake, the model seed, the transcript — and a case does it once and then
// waits on several sub-5 s `waitFor`s in series. That is exactly what
// `testTimeout` governs, and what `test-timeout-hygiene.test.ts` documents.
// Measured on beta, 2026-09-12, with all 215 component files running fully
// parallel on a 12-core machine: the slowest passing case in this family was
// 4,558 ms — 442 ms under vitest's default, which is why these three suites
// were the ones reporting "Test timed out in 5000ms" over races that had
// nothing to do with the budget.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });


/**
 * ClawBox AI names ONE thing in the chat header: the provider pill.
 *
 * There used to be a second pill beside it naming the model — a picker on the
 * Hermes side, a click-less label ("Flash 4.1") on both — and for this provider
 * it was noise twice over: the customer does not choose a ClawBox AI model (the
 * product runs one, and the plan decides what that resolves to), and the row it
 * sat in is the narrowest thing in the UI. The width budget in
 * src/lib/chat-header-pills.ts is the whole reason the other pills shorten their
 * labels at all; spending a pill of it on a word the "ClawBox" pill already
 * implies is the opposite of that work.
 *
 * The rule is one predicate — `isClawboxAiProvider` — applied in BOTH edition
 * branches of the header, which is what these tests pin: the two branches
 * agreeing, and every OTHER provider keeping its picker.
 *
 * Render tests rather than source assertions: the pill's presence is the
 * behaviour, and "no pill" is only meaningful if the surrounding pills are
 * proven to have rendered in the same frame.
 */

/** GET /setup-api/hermes/models (unscoped) — the header's seeding read. */
function hermesSeed(provider: string) {
  return {
    provider,
    current: `${provider}/model-a`,
    reasoning: "medium",
    providers: [{ id: provider, name: provider, authenticated: true }],
    models: [],
  };
}

/** GET /setup-api/hermes/models?provider=<p> — the scoped model list. TWO
 *  models, so `showModelPill` is true and hiding the pill is a decision this
 *  code makes rather than an accident of an empty list. */
function hermesScope(provider: string) {
  return {
    provider,
    authenticated: true,
    models: [{ id: "model-a", description: "" }, { id: "model-b", description: "" }],
    defaultModel: "model-a",
    current: "model-a",
    savedElsewhere: null,
    source: "dashboard",
    stale: false,
  };
}

/**
 * Scoped model-list requests waiting to be answered BY HAND.
 *
 * The ordering matters more than it looks: the provider pill renders off the
 * seed, which lands first, so an absence asserted right after it would be the
 * absence of a pill whose model list had not arrived yet — a test that passes
 * whatever the header decides. Answering the scoped request explicitly is what
 * makes "no pill" mean "no pill once there were two models to pick from".
 */
const pendingScope: Array<(body: unknown) => void> = [];

/** Answer the scoped request and let React apply it. */
async function settleModels(provider: string) {
  await waitFor(() => expect(pendingScope.length).toBe(1));
  await act(async () => {
    pendingScope[0](hermesScope(provider));
    await Promise.resolve();
  });
}

function installHermesFetch(provider: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "hermes", edition: "hermes" }) };
      }
      // Scoped first: `?provider=` is the model hook, not the header seed.
      if (url.includes("/setup-api/hermes/models?")) {
        const body = await new Promise<unknown>((resolve) => pendingScope.push(resolve));
        return { ok: true, json: async () => body };
      }
      if (url.includes("/setup-api/hermes/models")) {
        return { ok: true, json: async () => hermesSeed(provider) };
      }
      if (url.includes("/setup-api/chat/history")) {
        return { ok: true, json: async () => ({ messages: [] }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/** A two-model catalogue, so a non-ClawBox provider genuinely has a picker. */
const ANTHROPIC_CATALOG = {
  provider: "anthropic",
  models: [
    { id: "claude-opus-5", label: "Claude Opus 5", contextWindow: 200_000, availableOnSubscription: true },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200_000, availableOnSubscription: true },
  ],
  defaultModelId: "claude-opus-5",
  allowCustom: true,
  fetchedAt: 0,
};

/**
 * GET /setup-api/chat/model for a one-row OpenClaw box.
 *
 * The ClawBox AI rows deliberately pass `deepseek/deepseek-v4-flash` as the
 * active model: that is the Flash ref the box migrates itself onto, so the
 * auto-migration effect stays quiet and the header is the only thing under test.
 */
function openclawState(option: Record<string, unknown>, activeModel: string) {
  return {
    activeOptionId: "row-1",
    activeModel,
    activeSource: "primary",
    activeLabel: option.label,
    options: [{ id: "row-1", available: true, settingsSection: "ai", isLocal: false, ...option }],
    primary: { available: true, label: option.label, model: activeModel },
    local: { available: false, label: null, model: null },
    subscriptionProviders: [],
  };
}

function installOpenclawFetch(state: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/ai-models/catalog")) {
        return { ok: true, json: async () => ANTHROPIC_CATALOG };
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

const providerPill = () => screen.findByRole("button", { name: /^Chat provider:/ });
const modelPill = () => screen.queryByRole("button", { name: /model:/i });

beforeEach(() => {
  pendingScope.length = 0;
  resetHarnessCache();
  window.localStorage.clear();
  // jsdom has no layout engine, so the transcript's auto-scroll has nothing to
  // call. Unrelated to the header.
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

describe("the ClawBox AI provider id", () => {
  it("is recognised under both spellings, and nothing else is", () => {
    // `clawai` is what the UI normalises to; `deepseek` is what the gateway
    // config registers the proxy under. The header reads both.
    expect(isClawboxAiProvider("clawai")).toBe(true);
    expect(isClawboxAiProvider("deepseek")).toBe(true);
    expect(isClawboxAiProvider("anthropic")).toBe(false);
    expect(isClawboxAiProvider("openrouter")).toBe(false);
    expect(isClawboxAiProvider(null)).toBe(false);
  });
});

describe("the chat header's model pill on ClawBox AI (Hermes edition)", () => {
  it("is absent — no picker and no read-only tier label", async () => {
    installHermesFetch("clawai");
    render(<ChatPopup isOpen onClose={() => {}} />);

    // The provider pill proves the header rendered at all, so the absence
    // below is a decision and not an empty header.
    expect(await providerPill()).toHaveAccessibleName("Chat provider: ClawBox");
    await settleModels("clawai");
    expect(modelPill()).toBeNull();
    // The label pill that used to sit there was not a control, and its text is
    // the thing the customer reported seeing beside "ClawBox".
    expect(screen.queryByText(CLAWBOX_AI_CHAT_MODEL_LABEL)).toBeNull();
  });

  it("is absent under the wire spelling of the provider too", async () => {
    // `deepseek` is ClawBox AI's wire id (the proxy forwards to DeepSeek), and
    // the shared predicate treats it as ClawBox AI wherever it surfaces. On a
    // Hermes box ClawBox AI is registered as `clawai` (see hermes-clawai.ts),
    // so this state is reached through the id rather than through the product;
    // the cost of covering both spellings in one predicate is that a Hermes
    // user who separately configures DeepSeek in Hermes' own dashboard loses
    // that row's model picker too. Cosmetic, and no routing changes with it.
    installHermesFetch("deepseek");
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await providerPill()).toHaveAccessibleName("Chat provider: DeepSeek");
    await settleModels("deepseek");
    expect(modelPill()).toBeNull();
  });

  it("still renders for a provider that has models to choose between", async () => {
    installHermesFetch("openrouter");
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await providerPill()).toHaveAccessibleName("Chat provider: OpenRouter");
    // The control case: same two-model scope, answered the same way, pill
    // present. Without this the tests above would pass on a header that had
    // lost its model pill for everyone.
    await settleModels("openrouter");
    await waitFor(() => expect(modelPill()).toBeTruthy());
    expect(modelPill()).toHaveAccessibleName("Hermes model: model-a");
  });
});

describe("the chat header's model pill on ClawBox AI (OpenClaw edition)", () => {
  const CLAWAI_ROW = { label: "ClawBox AI", model: "deepseek/deepseek-v4-flash", provider: "clawai" };
  const DEEPSEEK_ROW = { label: "ClawBox AI", model: "deepseek/deepseek-v4-flash", provider: "deepseek" };

  it("is absent — no picker and no read-only tier label", async () => {
    installOpenclawFetch(openclawState(CLAWAI_ROW, "deepseek/deepseek-v4-flash"));
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await providerPill()).toHaveAccessibleName("Chat provider: ClawBox");
    expect(modelPill()).toBeNull();
    expect(screen.queryByText(CLAWBOX_AI_CHAT_MODEL_LABEL)).toBeNull();
  });

  it("is absent when the row still carries the wire provider id", async () => {
    // A state the server normally normalises to `clawai` — a legacy install, or
    // a row read straight off the gateway config — must not grow the pill back
    // just because it spells the same proxy the other way.
    installOpenclawFetch(openclawState(DEEPSEEK_ROW, "deepseek/deepseek-v4-flash"));
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await providerPill()).toBeTruthy();
    expect(modelPill()).toBeNull();
    expect(screen.queryByText(CLAWBOX_AI_CHAT_MODEL_LABEL)).toBeNull();
  });

  it("still renders for a provider whose models the owner does pick", async () => {
    installOpenclawFetch(openclawState(
      { label: "Anthropic", model: "anthropic/claude-opus-5", provider: "anthropic" },
      "anthropic/claude-opus-5",
    ));
    render(<ChatPopup isOpen onClose={() => {}} />);

    expect(await providerPill()).toBeTruthy();
    await waitFor(() => expect(modelPill()).toBeTruthy());
    // The catalogue's own label, still de-duplicated against the provider pill
    // (nothing to drop here: this row's pill says "Anthropic", the model says
    // "Claude") — untouched by this change, and asserted so a future attempt to
    // widen the ClawBox AI rule cannot quietly take this pill with it.
    expect(modelPill()).toHaveAccessibleName("Anthropic model: Claude Opus 5");
  });
});
