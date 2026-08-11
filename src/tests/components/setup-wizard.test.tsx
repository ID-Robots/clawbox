import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupWizard from "@/components/SetupWizard";
import { resetHarnessCache } from "@/lib/client-harness";

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  // The header now owns the language control, so the shell reads locale and
  // LANGUAGES as well as t.
  LANGUAGES: [
    { code: "en", flag: "🇬🇧", label: "English" },
    { code: "bg", flag: "🇧🇬", label: "Български" },
  ],
  useT: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: vi.fn(),
  }),
}));

vi.mock("next/link", () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}));

vi.mock("next/image", () => ({
  default: ({ alt = "" }: { alt?: string }) => <img alt={alt} />,
}));

vi.mock("@/components/ProgressBar", () => ({
  default: ({ currentStep }: { currentStep: number }) => <div data-testid="progress-step">{currentStep}</div>,
}));

vi.mock("@/components/WifiStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>wifi-next</button>,
}));

vi.mock("@/components/UpdateStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>update-next</button>,
}));

vi.mock("@/components/CredentialsStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>credentials-next</button>,
}));

vi.mock("@/components/AIModelsStep", () => ({
  default: ({
    onNext,
    configureScope,
  }: {
    onNext?: () => void;
    configureScope?: "primary" | "local";
  }) => (
    <button
      data-testid={configureScope === "local" ? "mock-local-ai" : "mock-primary-ai"}
      onClick={() => onNext?.()}
    >
      {configureScope === "local" ? "local-ai-next" : "primary-ai-next"}
    </button>
  ),
}));

vi.mock("@/components/TelegramStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>telegram-next</button>,
}));

vi.mock("@/components/StatusMessage", () => ({
  default: ({ message }: { message: string }) => <div>{message}</div>,
}));

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => data,
  } as Response;
}

/** Did the wizard call this path at least once? */
function called(fetchMock: ReturnType<typeof vi.fn>, path: string): boolean {
  return fetchMock.mock.calls.some(([input]) => String(input) === path);
}

describe("SetupWizard", () => {
  beforeEach(() => {
    vi.useRealTimers();
    // The edition is cached for the lifetime of a document; without this the
    // first test's answer would decide every later test's edition.
    resetHarnessCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetHarnessCache();
  });

  it("resumes from persisted setup progress after a reload", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/setup-api/setup/status") {
        return jsonResponse({
          setup_complete: false,
          wifi_configured: true,
          update_completed: true,
          password_configured: true,
          ai_model_configured: true,
          local_ai_configured: false,
          telegram_configured: false,
          // Pre-removal persistence had Local AI as step 5 and Telegram as
          // 6. The wizard now collapses to 5 steps total, so this stale
          // value should land on the new final step (Telegram = 5).
          setup_progress_step: 5,
        });
      }

      return jsonResponse({});
    }));

    render(<SetupWizard />);

    expect(await screen.findByText("telegram-next")).toBeInTheDocument();
    expect(screen.getByTestId("progress-step")).toHaveTextContent("5");
  });

  it("persists setup progress when advancing to the next step", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/setup-api/setup/status") {
        return jsonResponse({
          setup_complete: false,
          wifi_configured: true,
          update_completed: false,
          password_configured: false,
          ai_model_configured: false,
          local_ai_configured: false,
          telegram_configured: false,
          setup_progress_step: 2,
        });
      }
      if (url === "/setup-api/setup/progress") {
        return jsonResponse({
          success: true,
          step: JSON.parse(String(init?.body ?? "{}")).step,
        });
      }

      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizard />);

    fireEvent.click(await screen.findByText("update-next"));

    expect(await screen.findByText("credentials-next")).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/setup-api/setup/progress", expect.objectContaining({
        method: "POST",
      }));
    });
    const progressCall = fetchMock.mock.calls.find((call) => call[0]?.toString() === "/setup-api/setup/progress");
    expect(progressCall).toBeDefined();
    expect(JSON.parse(String(progressCall?.[1]?.body ?? "{}"))).toEqual({ step: 3 });
  });

  it("completes setup even when gateway health stays offline", async () => {
    const onComplete = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/setup-api/setup/status") {
        return jsonResponse({
          setup_complete: false,
          wifi_configured: true,
          update_completed: true,
          password_configured: true,
          ai_model_configured: true,
          local_ai_configured: true,
          telegram_configured: false,
          setup_progress_step: 5,
        });
      }
      if (url === "/setup-api/setup/progress") {
        return jsonResponse({ success: true, step: 5 });
      }
      if (url === "/setup-api/setup/complete") {
        return jsonResponse({ success: true });
      }
      if (url === "/setup-api/gateway/health") {
        return jsonResponse({ available: false });
      }
      if (url === "/setup-api/harness/active") {
        return jsonResponse({ active: "openclaw", edition: "openclaw" });
      }

      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizard onComplete={onComplete} />);

    fireEvent.click(await screen.findByText("telegram-next"));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    }, { timeout: 30_000 });

    // An OpenClaw box still waits on its gateway, and never on the Hermes side.
    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(true);
    expect(called(fetchMock, "/setup-api/hermes/models")).toBe(false);
  }, 35_000);

  it("waits on the Hermes agent, not the OpenClaw gateway, on a hermes device", async () => {
    const onComplete = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/setup-api/setup/status") {
        return jsonResponse({
          setup_complete: false,
          wifi_configured: true,
          update_completed: true,
          password_configured: true,
          ai_model_configured: true,
          local_ai_configured: true,
          telegram_configured: false,
          setup_progress_step: 5,
        });
      }
      if (url === "/setup-api/setup/progress") {
        return jsonResponse({ success: true, step: 5 });
      }
      if (url === "/setup-api/setup/complete") {
        return jsonResponse({ success: true });
      }
      if (url === "/setup-api/harness/active") {
        return jsonResponse({ active: "hermes", edition: "hermes" });
      }
      if (url === "/setup-api/hermes/models") {
        // `stale: false` is the models route's "the live Hermes dashboard
        // answered" signal.
        return jsonResponse({ stale: false, source: "dashboard", models: [] });
      }

      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizard onComplete={onComplete} />);

    fireEvent.click(await screen.findByText("telegram-next"));

    expect(await screen.findByTestId("setup-completion-overlay")).toBeInTheDocument();
    // The copy names the agent this device actually runs...
    await waitFor(() => {
      expect(screen.getByText("wizard.completionHermesTitle")).toBeInTheDocument();
    });
    expect(screen.getByText("wizard.completionHermesSaving")).toBeInTheDocument();
    expect(screen.getByText("wizard.completionHermesStarting")).toBeInTheDocument();
    // ...and never the gateway, which is not installed on a Hermes box.
    expect(screen.queryByText("openclaw.connecting")).not.toBeInTheDocument();
    expect(screen.queryByText("ai.restartingGateway")).not.toBeInTheDocument();
    expect(screen.queryByText("telegram.waitingGateway")).not.toBeInTheDocument();
    expect(screen.queryByText("telegram.pleaseWait")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    }, { timeout: 30_000 });

    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(false);
    expect(called(fetchMock, "/setup-api/hermes/models")).toBe(true);
  }, 35_000);

  it("still finishes on a hermes device whose agent never reports ready", async () => {
    const onComplete = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url === "/setup-api/setup/status") {
        return jsonResponse({
          setup_complete: false,
          wifi_configured: true,
          update_completed: true,
          password_configured: true,
          ai_model_configured: true,
          local_ai_configured: true,
          telegram_configured: false,
          setup_progress_step: 5,
        });
      }
      if (url === "/setup-api/setup/progress") {
        return jsonResponse({ success: true, step: 5 });
      }
      if (url === "/setup-api/setup/complete") {
        return jsonResponse({ success: true });
      }
      if (url === "/setup-api/harness/active") {
        return jsonResponse({ active: "hermes", edition: "hermes" });
      }
      if (url === "/setup-api/hermes/models") {
        // Dashboard still coming up: every source but the live one is stale.
        return jsonResponse({ stale: true, source: "cold-start", models: [] });
      }

      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizard onComplete={onComplete} />);

    fireEvent.click(await screen.findByText("telegram-next"));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    }, { timeout: 30_000 });

    expect(called(fetchMock, "/setup-api/gateway/health")).toBe(false);
  }, 35_000);
});
