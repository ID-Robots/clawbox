import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupWizard from "@/components/SetupWizard";

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useT: () => ({
    t: (key: string) => key,
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

describe("SetupWizard", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("resumes from persisted setup progress after a reload", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
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
          setup_progress_step: 5,
        });
      }

      return jsonResponse({});
    }));

    render(<SetupWizard />);

    expect(await screen.findByTestId("mock-local-ai")).toBeInTheDocument();
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
          setup_progress_step: 6,
        });
      }
      if (url === "/setup-api/setup/progress") {
        return jsonResponse({ success: true, step: 6 });
      }
      if (url === "/setup-api/setup/complete") {
        return jsonResponse({ success: true });
      }
      if (url === "/setup-api/gateway/health") {
        return jsonResponse({ available: false });
      }

      return jsonResponse({});
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SetupWizard onComplete={onComplete} />);

    fireEvent.click(await screen.findByText("telegram-next"));

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledTimes(1);
    }, { timeout: 15_000 });
  }, 20_000);
});
