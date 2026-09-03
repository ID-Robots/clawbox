import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent, within } from "@/tests/helpers/test-utils";
import { installHermesBox, mountHermesChat, type HermesBox } from "@/tests/helpers/hermes-chat-box";
import { resetHarnessCache } from "@/lib/client-harness";
import { DEGRADED_RETRY_ATTEMPTS, degradedRetryDelayMs } from "@/hooks/useHermesModelOptions";

/**
 * TASK-677 — the Hermes chat header rendered a DEGRADED catalogue as if it were
 * the box's answer, and never went back for the real one.
 *
 * Every reboot has a window of it. `clawbox-setup` logs "Ready in 0ms" and
 * starts serving while `clawbox-hermes-dashboard` needs another 11-12 s to come
 * up (measured on the box: 08:05:21 → 08:05:32, 08:09:56 → 08:10:08). A
 * `/setup-api/hermes/models` served in that window cannot reach the dashboard,
 * so it falls back to Hermes' on-disk manifest — a CURATED FILE from the docs
 * site that only ever carries `openrouter` and `nous`, and knows nothing about
 * this device. The payload says so: `source: "catalog-file"`, `stale: true`.
 *
 * Nothing on the client read either field. The header seeded from the manifest
 * — which is exactly the "OpenAI Codex / OpenRouter / Nous Portal" list the
 * owner photographed, the manifest's two rows plus the device's own provider
 * unshifted in — and the scoped read for `openai-codex` answered `models: []`,
 * which hides the model pill (`showModelPill` needs more than one id). With no
 * retry, no backoff and no marker, the header stayed wrong until the page was
 * reloaded.
 *
 * The mechanism to copy is the harness's own: #587 gave the OpenClaw picker a
 * `warming` flag and `useProviderCatalog` retries with backoff until the
 * catalogue stops saying it is warming. The Hermes payload already publishes
 * the equivalent facts.
 */

/** The scoped answer during the boot window: nothing, and it says so. */
const STALE_SCOPE = {
  provider: "openai-codex",
  authenticated: null,
  models: [],
  defaultModel: "",
  current: "",
  savedElsewhere: null,
  source: "catalog-file",
  stale: true,
  reasoning: "medium",
  savedPair: { provider: "openai-codex", model: "gpt-5.6-sol" },
};

/** The unscoped seed during the same window: the manifest's two rows. Both
 *  carry `authenticated: null` — "the source could not tell" — which the
 *  header's `!== false` filter keeps. */
const STALE_SEED = {
  providers: [
    { id: "openrouter", name: "openrouter", authenticated: null },
    { id: "nous", name: "nous", authenticated: null },
  ],
  models: [],
  provider: "openai-codex",
  current: "gpt-5.6-sol",
  reasoning: "medium",
  source: "catalog-file",
  stale: true,
};

/** What the settled box answers, captured from it: seven Codex models. */
const LIVE_SCOPE = {
  provider: "openai-codex",
  authenticated: true,
  models: [
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
    "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  ].map((id) => ({ id, description: "" })),
  defaultModel: "gpt-5.6-sol",
  current: "gpt-5.6-sol",
  savedElsewhere: null,
  source: "dashboard",
  stale: false,
  reasoning: "medium",
  savedPair: { provider: "openai-codex", model: "gpt-5.6-sol" },
};

const LIVE_SEED = {
  providers: [
    { id: "anthropic", name: "Anthropic", authenticated: true },
    { id: "openai-codex", name: "OpenAI Codex", authenticated: true },
    { id: "openrouter", name: "OpenRouter", authenticated: false },
    { id: "nous", name: "Nous", authenticated: false },
  ],
  models: [],
  provider: "openai-codex",
  current: "gpt-5.6-sol",
  reasoning: "medium",
  source: "dashboard",
  stale: false,
};

/** Every `/setup-api/hermes/models` URL the surface asked for, in order. */
let modelUrls: string[] = [];

/**
 * A Hermes box whose models route is degraded for the first `staleAnswers`
 * reads of each form and live afterwards — the boot window, then the dashboard
 * coming up. Nothing else changes: no signal is emitted and nothing remounts.
 */
function installBootWindowBox(staleAnswers = 1): HermesBox {
  const box = installHermesBox();
  const inner = globalThis.fetch;
  let seedReads = 0;
  let scopeReads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/setup-api/hermes/models")) {
        box.fetchedUrls.push(url);
        modelUrls.push(url);
        const scoped = new URL(url, "http://box").searchParams.get("provider");
        if (scoped) {
          scopeReads += 1;
          return { ok: true, json: async () => (scopeReads <= staleAnswers ? STALE_SCOPE : LIVE_SCOPE) };
        }
        seedReads += 1;
        return { ok: true, json: async () => (seedReads <= staleAnswers ? STALE_SEED : LIVE_SEED) };
      }
      return inner(input as RequestInfo, init);
    }),
  );
  return box;
}

/** The provider pill's options, with the popover opened. */
async function providerOptions(): Promise<string[]> {
  const trigger = await waitFor(() => screen.getByLabelText(/^Chat provider:/));
  fireEvent.click(trigger);
  const list = await screen.findByRole("listbox", { name: "Chat provider" });
  return within(list).getAllByRole("option").map((o) => o.textContent ?? "");
}

beforeEach(() => {
  modelUrls = [];
  resetHarnessCache();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  resetHarnessCache();
});

describe("the Hermes chat header during the dashboard's boot window", () => {
  it("goes back for the real catalogue and grows the model picker", async () => {
    const box = installBootWindowBox();
    await mountHermesChat(box);

    // The header is up on the degraded answer: provider pill, no model pill.
    await waitFor(() => expect(screen.getByLabelText(/^Chat provider:/)).toBeTruthy());
    expect(screen.queryByLabelText(/^Hermes model:/)).toBeNull();

    // No signal, no reload, no remount — the dashboard simply finishes booting.
    const picker = await waitFor(
      () => screen.getByLabelText(/^Hermes model:/),
      { timeout: 8000 },
    );

    fireEvent.click(picker);
    const options = await screen.findAllByRole("option");
    const ids = options.map((o) => o.textContent ?? "");
    expect(ids.some((label) => label.startsWith("gpt-5.6-sol"))).toBe(true);
    expect(ids.some((label) => label.startsWith("gpt-5.3-codex-spark"))).toBe(true);
  }, 15000);

  it("re-asks rather than treating the fallback as the answer", async () => {
    const box = installBootWindowBox();
    await mountHermesChat(box);

    // Both forms of the route are asked again: the seed, because the manifest
    // is not this device's provider list, and the scope, because an empty list
    // from a degraded payload is not "this provider serves nothing".
    await waitFor(
      () => {
        expect(modelUrls.filter((u) => u.includes("provider=")).length).toBeGreaterThan(1);
        expect(modelUrls.filter((u) => !u.includes("provider=")).length).toBeGreaterThan(1);
      },
      { timeout: 8000 },
    );
  }, 15000);

  it("does not offer the manifest's providers as if the box had them", async () => {
    // `openrouter` and `nous` are the only two rows the docs-site manifest ever
    // carries, and it knows nothing about THIS device's credentials — on the
    // settled box both report `authenticated: false`. Offering them is offering
    // a provider that cannot answer a turn.
    const box = installBootWindowBox(99); // the dashboard never comes up
    await mountHermesChat(box);

    await waitFor(() => expect(screen.getByLabelText(/^Chat provider:/)).toBeTruthy());
    const labels = await providerOptions();

    expect(labels.some((l) => l.includes("OpenAI Codex"))).toBe(true);
    expect(labels.some((l) => l.includes("OpenRouter"))).toBe(false);
    expect(labels.some((l) => l.includes("Nous"))).toBe(false);
  }, 15000);

  it("gives up in well under a minute rather than polling a dead dashboard", () => {
    // While these retries run, every surface reads as LOADING — the header's
    // pill holds its place and the Settings panel's model select holds back its
    // "this list is stale" note. So the budget is a promise to the owner of a
    // box whose dashboard is not coming back, not just a brake on traffic: the
    // honest empty state has to arrive promptly. Asserted as arithmetic because
    // waiting it out in a render test would cost the same seconds.
    const total = Array.from({ length: DEGRADED_RETRY_ATTEMPTS }, (_, i) => degradedRetryDelayMs(i))
      .reduce((a, b) => a + b, 0);
    // Comfortably past the measured 11-12 s boot window, comfortably short of
    // a spinner someone would reload the page over.
    expect(total).toBeGreaterThan(20_000);
    expect(total).toBeLessThan(30_000);
  });
});
