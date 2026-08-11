import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import LlamaCppModelPanel from "@/components/LlamaCppModelPanel";

/**
 * Fix C, UI half. When Gemma is installed but is NOT the harness's selection
 * the panel offers "Switch to Gemma 4" — and that button has to actually
 * switch. It previously re-ran the plain enable flow, which by policy leaves
 * the customer's chosen provider in place, so the button did nothing visible.
 */

const baseProps = {
  llamaCppRunning: false,
  llamaCppInstalled: true,
  llamaCppSaving: false as const,
  llamaCppProgress: null,
  selectedLlamaCppModel: "gemma4-e2b-it-q4_0",
  setSelectedLlamaCppModel: vi.fn(),
};

describe("LlamaCppModelPanel activation intent", () => {
  it("asks the server to ACTIVATE when the model is installed but not selected", () => {
    const save = vi.fn();
    render(
      <LlamaCppModelPanel {...baseProps} llamaCppIsActive={false} saveLlamaCppConfig={save} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /switch to gemma 4/i }));
    expect(save).toHaveBeenCalledWith("gemma4-e2b-it-q4_0", { activate: true });
  });

  it("does NOT force activation on a plain first-time enable", () => {
    const save = vi.fn();
    render(
      <LlamaCppModelPanel
        {...baseProps}
        llamaCppInstalled={false}
        llamaCppIsActive={false}
        saveLlamaCppConfig={save}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /enable gemma 4/i }));
    expect(save).toHaveBeenCalledWith("gemma4-e2b-it-q4_0", { activate: false });
  });

  it("tells the truth when installed but not selected", () => {
    render(
      <LlamaCppModelPanel {...baseProps} llamaCppIsActive={false} saveLlamaCppConfig={vi.fn()} />,
    );

    expect(screen.getByText(/switch to it to make it the active local ai/i)).toBeTruthy();
    // The green "already configured" pill must not appear — that is the
    // reassurance that made the device look like it was using Gemma.
    expect(screen.queryByText(/already configured/i)).toBeNull();
  });

  it("shows the configured pill only when it really is the active model", () => {
    render(
      <LlamaCppModelPanel {...baseProps} llamaCppIsActive saveLlamaCppConfig={vi.fn()} />,
    );

    expect(screen.getByText(/already configured/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /switch to gemma 4/i })).toBeNull();
  });
});
