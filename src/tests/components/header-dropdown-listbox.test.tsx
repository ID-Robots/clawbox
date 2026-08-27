// The OPEN list — the half a native <select> never let us own.
//
// Defect this covers: the setup wizard's model picker was a native <select>.
// The closed control was themed to the dark wizard, but the option list is
// painted by the browser: white ground, near-invisible pale text, one blue
// row. Owner-reported from a live first-boot run (step 4, "Connect AI
// Provider"). Native <option> cannot be themed cross-browser, cannot carry a
// second line, and cannot say WHY a row is unavailable — so the fix is this
// component, not a CSS rule.
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/tests/helpers/test-utils";
import { HeaderDropdown, type HeaderDropdownOption } from "@/components/HeaderDropdown";

const MODELS: HeaderDropdownOption[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", hint: "claude-opus-4-8" },
  {
    id: "claude-mythos-5",
    label: "Claude Mythos 5",
    hint: "claude-mythos-5",
    disabled: true,
    unavailableReason: "Not on subscriptions — needs an API key",
  },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "claude-sonnet-5" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", hint: "claude-sonnet-4-6" },
];

function renderPicker(
  overrides: Partial<React.ComponentProps<typeof HeaderDropdown>> = {},
) {
  const onChange = overrides.onChange ?? vi.fn();
  const utils = render(
    <HeaderDropdown
      ariaLabel="Model"
      value="claude-sonnet-4-6"
      options={MODELS}
      variant="field"
      {...overrides}
      onChange={onChange}
    />,
  );
  return { ...utils, onChange };
}

function openList() {
  fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
  return screen.getByRole("listbox", { name: "Model" });
}

describe("HeaderDropdown open list", () => {
  it("renders every model as a themed option, not a native <option>", () => {
    renderPicker();
    const listbox = openList();
    expect(document.querySelector("select")).toBeNull();
    const options = within(listbox).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Claude Opus 4.8"),
      expect.stringContaining("Claude Mythos 5"),
      expect.stringContaining("Claude Sonnet 5"),
      expect.stringContaining("Claude Sonnet 4.6"),
    ]);
    // The list is the component's own surface, so it carries the dark-theme
    // class the stylesheet paints — the browser popup never could.
    expect(listbox.className).toContain("header-dropdown-popover");
    expect(listbox.className).toContain("header-dropdown-popover--field");
  });

  it("marks the active model with aria-selected", () => {
    renderPicker();
    const listbox = openList();
    const selected = within(listbox).getAllByRole("option", { selected: true });
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Claude Sonnet 4.6");
  });

  it("fires onChange with the model id the native select would have emitted", () => {
    const { onChange } = renderPicker();
    const listbox = openList();
    fireEvent.click(within(listbox).getByRole("option", { name: /Claude Sonnet 5/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("claude-sonnet-5");
  });

  it("closes after a pick", () => {
    renderPicker();
    openList();
    fireEvent.click(screen.getByRole("option", { name: /Claude Sonnet 5/ }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  describe("keyboard", () => {
    it("opens from the trigger on ArrowDown and lands on the current pick", () => {
      renderPicker();
      const trigger = screen.getByRole("button", { name: /^Model:/ });
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      const listbox = screen.getByRole("listbox", { name: "Model" });
      expect(document.activeElement?.textContent).toContain("Claude Sonnet 4.6");
      expect(within(listbox).getAllByRole("option")).toHaveLength(4);
    });

    it("moves with the arrow keys and picks with Enter", () => {
      const { onChange } = renderPicker();
      const listbox = openList();
      // From Sonnet 4.6 (last) up one row lands on Sonnet 5.
      fireEvent.keyDown(listbox, { key: "ArrowUp" });
      expect(document.activeElement?.textContent).toContain("Claude Sonnet 5");
      fireEvent.keyDown(listbox, { key: "Enter" });
      expect(onChange).toHaveBeenCalledWith("claude-sonnet-5");
    });

    it("jumps to the ends with Home and End", () => {
      renderPicker();
      const listbox = openList();
      fireEvent.keyDown(listbox, { key: "Home" });
      expect(document.activeElement?.textContent).toContain("Claude Opus 4.8");
      fireEvent.keyDown(listbox, { key: "End" });
      expect(document.activeElement?.textContent).toContain("Claude Sonnet 4.6");
    });

    it("type-ahead jumps to the next label that starts with what was typed", () => {
      renderPicker();
      const listbox = openList();
      fireEvent.keyDown(listbox, { key: "Home" });
      fireEvent.keyDown(listbox, { key: "c" });
      // Every label starts with "Claude", so a single "c" steps to the next row.
      expect(document.activeElement?.textContent).toContain("Claude Mythos 5");
    });

    it("Tab closes the list from the trigger, not from nowhere", () => {
      // The focused row is about to be unmounted with the portal, and the
      // browser resolves the next tab stop from wherever focus is standing.
      // Without moving focus first it lands on <body> and a keyboard user
      // restarts from the top of the page.
      renderPicker();
      const listbox = openList();
      fireEvent.keyDown(listbox, { key: "Tab" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Model:/ }));
    });

    it("Escape closes the list and hands focus back to the trigger", () => {
      renderPicker();
      const listbox = openList();
      fireEvent.keyDown(listbox, { key: "Escape" });
      expect(screen.queryByRole("listbox")).toBeNull();
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^Model:/ }));
    });
  });

  describe("an unavailable model", () => {
    it("is shown and says why, rather than vanishing from the list", () => {
      renderPicker();
      const listbox = openList();
      const mythos = within(listbox).getByRole("option", { name: /Claude Mythos 5/ });
      expect(mythos.getAttribute("aria-disabled")).toBe("true");
      expect(mythos.textContent).toContain("Not on subscriptions — needs an API key");
      expect(mythos.className).toContain("is-unavailable");
    });

    it("stays reachable by keyboard so the reason is not sight-only", () => {
      renderPicker();
      const listbox = openList();
      fireEvent.keyDown(listbox, { key: "Home" });
      fireEvent.keyDown(listbox, { key: "ArrowDown" });
      expect(document.activeElement?.textContent).toContain("Claude Mythos 5");
    });

    it("refuses the pick on click and on Enter", () => {
      const { onChange } = renderPicker();
      const listbox = openList();
      const mythos = within(listbox).getByRole("option", { name: /Claude Mythos 5/ });
      fireEvent.click(mythos);
      fireEvent.keyDown(listbox, { key: "Home" });
      fireEvent.keyDown(listbox, { key: "ArrowDown" });
      fireEvent.keyDown(listbox, { key: "Enter" });
      expect(onChange).not.toHaveBeenCalled();
      // And it never closed the list out from under the customer.
      expect(screen.queryByRole("listbox")).not.toBeNull();
    });
  });

  it("caps its height so a long catalogue scrolls instead of running off-screen", () => {
    const many: HeaderDropdownOption[] = Array.from({ length: 40 }, (_, i) => ({
      id: `model-${i}`,
      label: `Model ${i}`,
    }));
    renderPicker({ options: many, value: "model-0" });
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    const listbox = screen.getByRole("listbox", { name: "Model" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(40);
    const maxHeight = Number.parseInt(listbox.style.maxHeight, 10);
    expect(maxHeight).toBeGreaterThan(0);
    expect(maxHeight).toBeLessThanOrEqual(320);
  });

  it("carries the edition marker onto the portaled list, so Hermes is green", () => {
    // The popover mounts on <body>, outside the wizard's skin ancestor, so it
    // has to carry `data-agent` itself — same reason ReconnectStage and the
    // step-3 dialog stamp their own portal roots. The colours themselves live
    // in globals.css keyed off this attribute; nothing re-types a hex here.
    const { unmount } = renderPicker({ hermes: true });
    let listbox = openList();
    expect(listbox.getAttribute("data-agent")).toBe("hermes");
    unmount();

    renderPicker();
    listbox = openList();
    expect(listbox.getAttribute("data-agent")).toBeNull();
  });

  it("names the trigger for a <label htmlFor> when given an id", () => {
    renderPicker({ id: "ai-provider-model" });
    expect(screen.getByRole("button", { name: /^Model:/ }).id).toBe("ai-provider-model");
  });
});
