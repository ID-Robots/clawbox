/**
 * The desktop toast surface (src/components/ToastHost.tsx).
 *
 * Found on a real box: page.tsx dispatched `clawbox:toast` for every
 * `ui_notify`, `clawbox notify` and server-side owner notice, and nothing
 * listened — the events fired into the void. This pins that a dispatched
 * message is rendered as text, can be dismissed, and that junk is ignored.
 */
import { describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ToastHost, { TOAST_EVENT } from "@/components/ToastHost";

function dispatch(detail: unknown) {
  act(() => {
    window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail }));
  });
}

describe("ToastHost", () => {
  it("renders nothing until a notice arrives, then shows it as text", () => {
    render(<ToastHost />);
    expect(screen.queryByTestId("toast-host")).not.toBeInTheDocument();

    dispatch({ message: "Coding agent finished run-k3x9q2ab <b>not html</b>" });

    const toast = screen.getByRole("status");
    expect(toast.textContent).toContain("Coding agent finished run-k3x9q2ab <b>not html</b>");
    expect(toast.querySelector("b")).toBeNull();
  });

  it("can be dismissed", () => {
    render(<ToastHost />);
    dispatch({ message: "hello" });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("ignores events without a usable message", () => {
    render(<ToastHost />);
    dispatch({ message: "   " });
    dispatch({ message: 42 });
    dispatch(undefined);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps only the most recent few", () => {
    render(<ToastHost />);
    for (let i = 0; i < 6; i += 1) dispatch({ message: `notice ${i}` });
    const shown = screen.getAllByRole("status").map((el) => el.textContent);
    expect(shown).toHaveLength(4);
    expect(shown[0]).toContain("notice 2");
    expect(shown[3]).toContain("notice 5");
  });
});
