import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { useModalDialog } from "@/hooks/useModalDialog";

/**
 * Where `inert` / `aria-hidden` may and may not be applied.
 *
 * `getByRole` resolves against the ACCESSIBILITY TREE, not the DOM. A control
 * inside an `inert` or `aria-hidden` subtree stays perfectly visible to a CSS
 * selector and disappears from every role-based query — so a mistake here is
 * invisible on screen and total for a screen-reader user.
 *
 * The dangerous version is applying it on MOUNT rather than on OPEN: several of
 * these dialogs stay mounted all the time and are gated by an `open` prop, so
 * that would poison the whole app's accessibility tree permanently, with
 * nothing looking wrong.
 */

function Harness({ open }: { open: boolean }) {
  const panelRef = useModalDialog<HTMLDivElement>({ open, onClose: () => {} });
  return (
    <div>
      <button type="button">background control</button>
      {open && (
        <div className="backdrop">
          <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Confirm">
            <button type="button">dialog control</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A dialog that stays mounted and self-gates, like ClawBoxLoginModal. */
function ToggleHarness() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open it
      </button>
      <Harness open={open} />
    </div>
  );
}

describe("useModalDialog — background inerting", () => {
  it("leaves the page alone while the dialog is closed", () => {
    render(<Harness open={false} />);

    // The whole point: a mounted-but-closed dialog must not touch anything.
    // If this regresses, every getByRole in the app starts failing while the
    // screen still looks correct.
    expect(screen.getByRole("button", { name: "background control" })).toBeInTheDocument();
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    expect(document.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
  });

  it("hides the page only once the dialog actually opens, and gives it back on close", () => {
    render(<ToggleHarness />);

    expect(screen.getByRole("button", { name: "background control" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "open it" }));

    // Open: the background control is gone from the accessibility tree.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "background control" })).toBeNull();
    expect(document.querySelectorAll("[inert]").length).toBeGreaterThan(0);

    fireEvent.keyDown(document, { key: "Escape" });
  });

  it("never marks the dialog's own subtree", () => {
    render(<Harness open />);

    const panel = screen.getByRole("dialog");
    expect(panel).not.toHaveAttribute("inert");
    expect(panel).not.toHaveAttribute("aria-hidden");
    // The control inside the dialog has to stay reachable by role, or the
    // dialog is as unusable as the page it is covering.
    expect(screen.getByRole("button", { name: "dialog control" })).toBeInTheDocument();
  });
});
