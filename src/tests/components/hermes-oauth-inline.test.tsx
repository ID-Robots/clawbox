import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import HermesProviderConfig from "@/components/HermesProviderConfig";

// The inline provider sign-in that replaced the jump to the Hermes dashboard's
// :8090 proxy (unreachable through clawbox-tunnel / Cloudflare tunnels). The
// whole flow must run inside this panel against same-origin /setup-api routes:
// pkce opens the provider's page and takes a pasted code; device_code shows the
// user code and waits; external shows the CLI command instead of a button.

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
}));

vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));

const refreshModels = vi.fn();

vi.mock("@/hooks/useHermesModelOptions", () => ({
  useHermesModelOptions: () => ({
    scope: {
      provider: "anthropic",
      authenticated: true,
      models: [{ id: "claude-opus-4-8", description: "" }],
      defaultModel: "claude-opus-4-8",
      current: "claude-opus-4-8",
      savedElsewhere: null,
      source: "dashboard",
      stale: false,
      fetchedAt: Date.now(),
    },
    loading: false,
    refresh: refreshModels,
  }),
  notifyHermesModelState: vi.fn(),
}));

/** The panel's backing routes, including the new inline-OAuth relay. Tracks a
 *  successful submit the way the dashboard would, so the status re-read after
 *  connecting reports logged_in instead of clobbering the panel's flip. */
function stubFetch({ submitOk = true }: { submitOk?: boolean } = {}) {
  let anthropicLoggedIn = false;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url === "/setup-api/hermes/clawai") {
      return {
        ok: true,
        json: async () => ({ hasToken: false, tier: "flash", tierStored: null, active: false, model: "" }),
      } as Response;
    }
    if (url === "/setup-api/hermes/oauth") {
      return {
        ok: true,
        json: async () => ({
          providers: [
            { id: "anthropic", name: "Anthropic", loggedIn: anthropicLoggedIn, flow: "pkce" },
            { id: "openai-codex", name: "OpenAI", loggedIn: false, flow: "device_code" },
            {
              id: "copilot-acp",
              name: "GitHub Copilot",
              loggedIn: false,
              flow: "external",
              cliCommand: "hermes auth login copilot",
            },
          ],
        }),
      } as Response;
    }
    if (url === "/setup-api/hermes/oauth/start" && method === "POST") {
      const { providerId } = JSON.parse(String(init?.body)) as { providerId: string };
      if (providerId === "anthropic") {
        return {
          ok: true,
          json: async () => ({
            session_id: "sess-anthropic-1",
            flow: "pkce",
            auth_url: "https://claude.ai/oauth/authorize?x=1",
            expires_in: 600,
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          session_id: "sess-codex-1",
          flow: "device_code",
          user_code: "ABCD-1234",
          verification_url: "https://example.com/activate",
          expires_in: 900,
          poll_interval: 5,
        }),
      } as Response;
    }
    if (url === "/setup-api/hermes/oauth/submit" && method === "POST") {
      if (submitOk) anthropicLoggedIn = true;
      return submitOk
        ? ({ ok: true, json: async () => ({ ok: true }) } as Response)
        : ({
            ok: false,
            status: 400,
            json: async () => ({ ok: false, status: "error", message: "Invalid authorization code" }),
          } as Response);
    }
    if (url.startsWith("/setup-api/hermes/oauth/poll")) {
      return { ok: true, json: async () => ({ status: "pending" }) } as Response;
    }
    if (url === "/setup-api/hermes/oauth/cancel") {
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    if (url === "/setup-api/hermes/models") {
      return { ok: true, json: async () => ({ provider: "openrouter" }) } as Response;
    }

    return { ok: true, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("HermesProviderConfig inline OAuth", () => {
  let openMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.unstubAllGlobals();
    refreshModels.mockClear();
    openMock = vi.fn();
    vi.stubGlobal("open", openMock);
  });

  it("runs the pkce flow inline: opens the provider page, takes a pasted code, shows Connected", async () => {
    const fetchMock = stubFetch();

    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    fireEvent.click(await screen.findByRole("radio", { name: /Anthropic/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Sign in$/ }));

    // The provider's consent page opens in a NEW tab; the panel itself never
    // navigates anywhere (especially not to :8090).
    const codeInput = await screen.findByPlaceholderText("Paste the code from Anthropic");
    expect(openMock).toHaveBeenCalledWith(
      "https://claude.ai/oauth/authorize?x=1",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openMock.mock.calls.every(([url]) => !String(url).includes(":8090"))).toBe(true);

    fireEvent.change(codeInput, { target: { value: "authcode#state" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit code/ }));

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeInTheDocument();
    });
    const submitCall = fetchMock.mock.calls.find(([u]) => String(u) === "/setup-api/hermes/oauth/submit");
    expect(submitCall).toBeTruthy();
    expect(JSON.parse(String(submitCall?.[1]?.body))).toEqual({
      providerId: "anthropic",
      sessionId: "sess-anthropic-1",
      code: "authcode#state",
    });
    expect(refreshModels).toHaveBeenCalled();
  });

  it("keeps the paste step visible with the dashboard's message when the code is rejected", async () => {
    stubFetch({ submitOk: false });

    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    fireEvent.click(await screen.findByRole("radio", { name: /Anthropic/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Sign in$/ }));

    const codeInput = await screen.findByPlaceholderText("Paste the code from Anthropic");
    fireEvent.change(codeInput, { target: { value: "wrongcode" } });
    fireEvent.click(screen.getByRole("button", { name: /Submit code/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("Invalid authorization code");
    });
    // Still on the paste step: the user can correct the code without a new session.
    expect(screen.getByPlaceholderText("Paste the code from Anthropic")).toBeInTheDocument();
  });

  it("runs the device_code flow inline: shows the user code, copy button and verification link", async () => {
    stubFetch();

    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    fireEvent.click(await screen.findByRole("radio", { name: /OpenAI/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Sign in$/ }));

    const code = await screen.findByTestId("hermes-oauth-user-code");
    expect(code).toHaveTextContent("ABCD-1234");
    expect(screen.getByRole("button", { name: /Copy code/ })).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Open the verification page/ });
    expect(link).toHaveAttribute("href", "https://example.com/activate");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.getByText("Waiting for approval...")).toBeInTheDocument();
    // Device-code never opens a tab by itself — the user may be on another machine.
    expect(openMock).not.toHaveBeenCalled();
  });

  it("cancels the dashboard session when the user starts over mid-flow", async () => {
    const fetchMock = stubFetch();

    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    fireEvent.click(await screen.findByRole("radio", { name: /Anthropic/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Sign in$/ }));
    await screen.findByPlaceholderText("Paste the code from Anthropic");

    fireEvent.click(screen.getByRole("button", { name: /Start over/ }));

    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find(([u]) => String(u) === "/setup-api/hermes/oauth/cancel");
      expect(cancelCall).toBeTruthy();
      expect(JSON.parse(String(cancelCall?.[1]?.body))).toEqual({ sessionId: "sess-anthropic-1" });
    });
    // Back to the idle state, ready to start a fresh session.
    expect(await screen.findByRole("button", { name: /^Sign in$/ })).toBeInTheDocument();
  });

  it("cancels a session minted by a /start that resolves after the user moved on", async () => {
    // Own stub: /start must stay pending until after the user abandons the
    // flow (switches rows — the only abandon affordance while stage is
    // "starting"), so the generation-token branch is what handles the late
    // session, not the normal reset path.
    let resolveStart!: () => void;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/setup-api/hermes/clawai") {
        return {
          ok: true,
          json: async () => ({ hasToken: false, tier: "flash", tierStored: null, active: false, model: "" }),
        } as Response;
      }
      if (url === "/setup-api/hermes/oauth") {
        return {
          ok: true,
          json: async () => ({
            providers: [{ id: "anthropic", name: "Anthropic", loggedIn: false, flow: "pkce" }],
          }),
        } as Response;
      }
      if (url === "/setup-api/hermes/oauth/start" && method === "POST") {
        return new Promise<Response>((resolve) => {
          resolveStart = () =>
            resolve({
              ok: true,
              json: async () => ({
                session_id: "sess-late-1",
                flow: "pkce",
                auth_url: "https://claude.ai/oauth/authorize?x=1",
                expires_in: 600,
              }),
            } as Response);
        });
      }
      if (url === "/setup-api/hermes/oauth/cancel") {
        return { ok: true, json: async () => ({ ok: true }) } as Response;
      }
      if (url === "/setup-api/hermes/models") {
        return { ok: true, json: async () => ({ provider: "openrouter" }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    fireEvent.click(await screen.findByRole("radio", { name: /Anthropic/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Sign in$/ }));
    await screen.findByText("Starting sign-in with Anthropic...");

    // Abandon while /start is still in flight, then let it resolve late.
    fireEvent.click(screen.getByRole("radio", { name: /OpenRouter/ }));
    resolveStart();

    await waitFor(() => {
      const cancelCall = fetchMock.mock.calls.find(([u]) => String(u) === "/setup-api/hermes/oauth/cancel");
      expect(cancelCall).toBeTruthy();
      expect(JSON.parse(String(cancelCall?.[1]?.body))).toEqual({ sessionId: "sess-late-1" });
    });
    // The dead flow must not resurrect: no paste step, no consent tab.
    expect(screen.queryByPlaceholderText("Paste the code from Anthropic")).not.toBeInTheDocument();
    expect(openMock).not.toHaveBeenCalled();
  });

  it("copies the device code and confirms with Copied", async () => {
    stubFetch();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    fireEvent.click(await screen.findByRole("radio", { name: /OpenAI/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Sign in$/ }));
    await screen.findByTestId("hermes-oauth-user-code");

    fireEvent.click(screen.getByRole("button", { name: /Copy code/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Copied/ })).toBeInTheDocument();
    });
    expect(writeText).toHaveBeenCalledWith("ABCD-1234");
  });

  it("shows the CLI command instead of a Sign in button for an external-flow provider", async () => {
    stubFetch();

    render(<HermesProviderConfig embedded testId="hermes-ai" />);

    fireEvent.click(await screen.findByRole("radio", { name: /GitHub Copilot/ }));

    await screen.findByText("hermes auth login copilot");
    expect(screen.getByText("This provider signs in through the Hermes CLI.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Sign in$/ })).not.toBeInTheDocument();
  });
});
