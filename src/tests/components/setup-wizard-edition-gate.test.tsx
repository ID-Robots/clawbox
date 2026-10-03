import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SetupWizard from "@/components/SetupWizard";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * Where "Choose your assistant" sits in the wizard (TASK-1149): a gate in
 * front of step 2 that appears ONLY when /setup-api/setup/status says
 * `edition_choice_needed`. Every box with a fixed edition — every deployed
 * box, every box flashed for a Hermes order — walks today's wizard exactly,
 * and the step numbers never move.
 */

vi.mock("@/lib/i18n", () => ({
  I18nProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  LANGUAGES: [{ code: "en", flag: "🇬🇧", label: "English" }],
  useT: () => ({ t: (key: string) => key, locale: "en", setLocale: vi.fn() }),
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
vi.mock("@/components/EditionStep", () => ({
  default: () => <div data-testid="mock-edition-step">edition-step</div>,
}));
vi.mock("@/components/UpdateStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>update-next</button>,
}));
vi.mock("@/components/CredentialsStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>credentials-next</button>,
}));
vi.mock("@/components/AIModelsStep", () => ({
  default: ({ onNext }: { onNext?: () => void }) => <button onClick={() => onNext?.()}>ai-next</button>,
}));
vi.mock("@/components/TelegramStep", () => ({
  default: ({ onNext }: { onNext: () => void }) => <button onClick={onNext}>telegram-next</button>,
}));
vi.mock("@/components/StatusMessage", () => ({
  default: ({ message }: { message: string }) => <div>{message}</div>,
}));

function stubStatus(status: Record<string, unknown>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/setup-api/setup/status") {
      return { ok: true, status: 200, json: async () => status } as Response;
    }
    if (url === "/setup-api/harness/active") {
      return { ok: true, status: 200, json: async () => ({ active: "openclaw", edition: "openclaw", activeKnown: false }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetHarnessCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetHarnessCache();
});

describe("the edition gate in the setup wizard", () => {
  it("shows the choice after WiFi, in place of the Update step, on a box that needs it", async () => {
    stubStatus({ wifi_configured: true, edition_choice_needed: true, setup_progress_step: 2 });
    render(<SetupWizard />);
    expect(await screen.findByTestId("mock-edition-step")).toBeInTheDocument();
    expect(screen.queryByText("update-next")).toBeNull();
    // Step 2 is still step 2: nothing is renumbered.
    expect(screen.getByTestId("progress-step")).toHaveTextContent("2");
  });

  it("keeps WiFi first, then shows the choice when WiFi is done", async () => {
    stubStatus({ wifi_configured: false, edition_choice_needed: true });
    render(<SetupWizard />);
    fireEvent.click(await screen.findByText("wifi-next"));
    expect(await screen.findByTestId("mock-edition-step")).toBeInTheDocument();
    expect(screen.queryByText("update-next")).toBeNull();
  });

  it.each([
    ["a box locked to an edition", { edition_choice_needed: false }],
    ["an older server that does not send the field", {}],
    ["a truthy non-boolean", { edition_choice_needed: "yes" }],
  ])("never renders on %s", async (_label, extra) => {
    stubStatus({ wifi_configured: true, setup_progress_step: 2, ...extra });
    render(<SetupWizard />);
    expect(await screen.findByText("update-next")).toBeInTheDocument();
    expect(screen.queryByTestId("mock-edition-step")).toBeNull();
  });

  it("is never skipped by a resume that would land past it", async () => {
    // A box whose flags say it is further along still has no agent chosen —
    // the steps after the gate depend on the agent, so the gate comes first.
    stubStatus({
      wifi_configured: true,
      update_completed: true,
      password_configured: true,
      ai_model_configured: true,
      telegram_configured: true,
      setup_progress_step: 5,
      edition_choice_needed: true,
    });
    render(<SetupWizard />);
    expect(await screen.findByTestId("mock-edition-step")).toBeInTheDocument();
    expect(screen.queryByTestId("setup-completion-overlay")).toBeNull();
    expect(screen.queryByText("telegram-next")).toBeNull();
    expect(screen.queryByText("credentials-next")).toBeNull();
  });

  it("answers the help button for the step on screen", async () => {
    stubStatus({ wifi_configured: true, edition_choice_needed: true });
    render(<SetupWizard />);
    await screen.findByTestId("mock-edition-step");
    fireEvent.click(screen.getByLabelText("wizard.needHelp"));
    await waitFor(() => expect(screen.getByText("assistant.helpTitle")).toBeInTheDocument());
    expect(screen.getByText("assistant.helpBody")).toBeInTheDocument();
  });
});
