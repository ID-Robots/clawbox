// @vitest-environment jsdom
/**
 * Restore must keep the keyboard where Maximize kept it (sweep FT-3).
 *
 * A mousedown on the title bar is cancelled by the drag handler, which is
 * why a click on Maximize never moved focus off a terminal's textarea. The
 * handler returned BEFORE that cancel on a maximized window, so the same
 * click on Restore moved focus onto the button and every keystroke after it
 * went nowhere until the terminal was clicked again.
 *
 * jsdom does not move focus on mousedown, so the cancelled default is what
 * is asserted: `fireEvent` answers false when the event was prevented.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ChromeWindow from "@/components/ChromeWindow";

vi.mock("@/lib/i18n", () => ({
  useT: () => ({ locale: "en", t: (key: string) => key }),
}));

function win() {
  return render(
    <ChromeWindow title="Terminal" appId="terminal" isActive zIndex={100} onClose={() => {}} onFocus={() => {}} onMinimize={() => {}}>
      <textarea data-testid="shell" />
    </ChromeWindow>,
  );
}

describe("the title bar's Restore button", () => {
  it("refuses the focus move, exactly as Maximize does", () => {
    win();
    const maximize = screen.getByRole("button", { name: "window.maximize" });
    expect(fireEvent.mouseDown(maximize)).toBe(false);
    fireEvent.click(maximize);

    const restore = screen.getByRole("button", { name: "window.restore" });
    expect(fireEvent.mouseDown(restore)).toBe(false);
    // And the click itself still restores.
    fireEvent.click(restore);
    expect(screen.getByRole("button", { name: "window.maximize" })).toBeInTheDocument();
  });

  it("leaves a touch alone, so the tap it becomes is not cancelled with it", () => {
    win();
    fireEvent.click(screen.getByRole("button", { name: "window.maximize" }));
    const restore = screen.getByRole("button", { name: "window.restore" });
    expect(fireEvent.touchStart(restore, { touches: [{ clientX: 10, clientY: 10 }] })).toBe(true);
  });
});
