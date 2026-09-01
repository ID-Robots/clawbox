/**
 * The New app card's popover behaviour.
 *
 * The card has two hosts with opposite expectations. On the Coding Agent's
 * home page it is part of the page: a stray click elsewhere must not throw
 * away what was typed. In the mascot chat it floats over the composer, and
 * there anything that opens over your work is expected to close when you click
 * away. One prop separates them, so neither host has to re-implement it.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import NewAppWizardCard from "@/components/NewAppWizardCard";

describe("NewAppWizardCard", () => {
  it("ignores an outside click by default — the page host must not lose typed text", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button" data-testid="outside">elsewhere</button>
        <NewAppWizardCard onClose={onClose} />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on an outside click when the host asks for popover behaviour", () => {
    const onClose = vi.fn();
    render(
      <div>
        <button type="button" data-testid="outside">elsewhere</button>
        <NewAppWizardCard onClose={onClose} closeOnOutsideClick />
      </div>,
    );
    fireEvent.pointerDown(screen.getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open for a click INSIDE it", () => {
    const onClose = vi.fn();
    render(<NewAppWizardCard onClose={onClose} closeOnOutsideClick />);
    fireEvent.pointerDown(screen.getByTestId("coding-agent-new-name"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape — the other half of what a popover owes the keyboard", () => {
    const onClose = vi.fn();
    render(<NewAppWizardCard onClose={onClose} closeOnOutsideClick />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stops listening once unmounted", () => {
    const onClose = vi.fn();
    const { unmount } = render(<NewAppWizardCard onClose={onClose} closeOnOutsideClick />);
    unmount();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
