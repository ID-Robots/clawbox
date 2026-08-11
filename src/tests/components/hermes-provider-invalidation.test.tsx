import fs from "fs";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@/tests/helpers/test-utils";
import {
  HERMES_MODEL_STATE_EVENT,
  notifyHermesModelState,
  useHermesModelOptions,
} from "@/hooks/useHermesModelOptions";

/**
 * Adding or authenticating a provider has to show up in the chat's provider
 * picker straight away — the device is configured, so a picker that still omits
 * it is simply wrong until the page is reloaded.
 *
 * The server side was already correct (every write drops the model-options cache
 * and the `hermes config get` memo keys on config.yaml's mtime); the gap was that
 * nothing told the client to re-read. The fix is a signal, and its whole value is
 * in being CHEAP: `refresh=1` re-enumerates every provider's live /v1/models,
 * which is a device-wide sweep to answer "did the provider list change?".
 */

function scope(provider: string, models: string[]) {
  return {
    provider,
    authenticated: true,
    models: models.map((id) => ({ id })),
    defaultModel: models[0] ?? "",
    current: models[0] ?? "",
    savedElsewhere: null,
    source: "dashboard",
    stale: false,
  };
}

function Probe({ provider }: { provider: string }) {
  const { scope: s, loading } = useHermesModelOptions(provider);
  return <p data-testid="probe">{loading ? "loading" : s?.models.map((m) => m.id).join(",") || "none"}</p>;
}

const fetchMock = () => globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
const urls = () => fetchMock().mock.calls.map((c) => String(c[0]));

afterEach(() => vi.unstubAllGlobals());

describe("the chat/panel model scope across a provider configure", () => {
  it("re-reads the provider's models when the signal fires", async () => {
    let models = ["openai/gpt-5"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => scope("openai", models) })),
    );

    render(<Probe provider="openai" />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("openai/gpt-5"));

    // A configure landed somewhere else in the UI.
    models = ["openai/gpt-5", "openai/gpt-5-mini"];
    await act(async () => {
      notifyHermesModelState();
    });

    await waitFor(() =>
      expect(screen.getByTestId("probe").textContent).toBe("openai/gpt-5,openai/gpt-5-mini"),
    );
  });

  it("re-reads plainly — it never asks for the all-provider live sweep", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => scope("openai", ["openai/gpt-5"]) })),
    );

    render(<Probe provider="openai" />);
    await waitFor(() => expect(urls().length).toBe(1));

    await act(async () => {
      notifyHermesModelState();
    });
    await waitFor(() => expect(urls().length).toBe(2));

    expect(urls().every((u) => !u.includes("refresh=1"))).toBe(true);
  });

  it("does not blank the scope while the re-read is in flight", async () => {
    // The model pill holds its place off `loading`; an invalidation that flipped
    // it would make the chat header jump on every provider someone adds.
    let release: (() => void) | null = null;
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls > 1) await new Promise<void>((r) => { release = r; });
        return { ok: true, json: async () => scope("openai", ["openai/gpt-5"]) };
      }),
    );

    render(<Probe provider="openai" />);
    await waitFor(() => expect(screen.getByTestId("probe").textContent).toBe("openai/gpt-5"));

    await act(async () => {
      notifyHermesModelState();
    });
    // Still the previous answer for the SAME provider — never "loading".
    expect(screen.getByTestId("probe").textContent).toBe("openai/gpt-5");

    await act(async () => {
      release?.();
    });
  });

  it("keeps one event name for emitter and listeners", () => {
    expect(HERMES_MODEL_STATE_EVENT).toBe("clawbox:hermes-model-state-changed");
  });
});

// ── Wiring, asserted on source ───────────────────────────────────────────────
// Rendering ChatPopup means standing up its whole websocket/gateway tree for one
// listener; the same precedent as chat-model-pill-stability.test.tsx.
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), "utf8");
const CHAT = read("src", "components", "ChatPopup.tsx");
const PANEL = read("src", "components", "HermesProviderConfig.tsx");
const HOOK = read("src", "hooks", "useHermesModelOptions.ts");

describe("who emits the signal and who listens", () => {
  it("has the chat re-seed its provider list on the shared event", () => {
    expect(CHAT).toMatch(/window\.addEventListener\(HERMES_MODEL_STATE_EVENT, onChanged\)/);
    expect(CHAT).toMatch(/const onChanged = \(\) => \{ void seedHermesHeader\(controller\.signal\) \}/);
  });

  /** The source between two markers — line-ending agnostic, unlike a regex. */
  function between(src: string, from: string, to: string): string {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a + 1);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return src.slice(a, b);
  }

  it("emits after the ClawBox AI device login configures the device", () => {
    expect(between(PANEL, "onComplete: () => {", "onError:")).toContain("notifyChatHeader()");
  });

  it("emits when the user returns from Hermes' own sign-in page", () => {
    expect(between(PANEL, "const onFocus = () => {", 'addEventListener("focus"')).toContain(
      "notifyChatHeader()",
    );
  });

  it("keeps the hook's listener off the expensive path", () => {
    // Bumping the nonce re-asks; setting pendingRefreshRef would add `refresh=1`.
    expect(HOOK).toMatch(/const onChanged = \(\) => setNonce\(\(n\) => n \+ 1\);/);
    expect(HOOK).toMatch(/const fresh = provider && loaded\?\.provider === provider \? loaded : null/);
  });
});
