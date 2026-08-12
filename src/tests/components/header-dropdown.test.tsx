// The chat header's selector pills.
//
// Defect this covers: at the docked panel width the three pills all truncated
// their own labels — measured on-device, "Thinking: Medium" needed 111px and
// got 56, so it rendered "Thinki…" and the customer could not read the active
// reasoning level, model or provider without opening a dropdown.
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@/tests/helpers/test-utils";
import { HeaderDropdown } from "@/components/HeaderDropdown";
import { REASONING_PILL_ICON } from "@/lib/chat-header-pills";

const LEVELS = [
  { id: "off", label: "Off" },
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

function renderReasoningPill(value = "medium") {
  return render(
    <HeaderDropdown
      ariaLabel="Reasoning effort"
      value={value}
      triggerLabel={LEVELS.find(l => l.id === value)?.label ?? value}
      triggerIcon={REASONING_PILL_ICON}
      options={LEVELS}
      onChange={vi.fn()}
    />,
  );
}

describe("HeaderDropdown trigger", () => {
  it("shows the reasoning level without a word prefix", () => {
    renderReasoningPill();
    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toContain("Medium");
    // The prefix that used to eat half the pill.
    expect(trigger.textContent).not.toContain("Thinking");
  });

  it("carries the icon that says WHICH dial the value belongs to", () => {
    renderReasoningPill();
    const icon = document.querySelector(
      ".header-dropdown-trigger .material-symbols-rounded",
    );
    expect(icon?.textContent).toBe(REASONING_PILL_ICON);
    // Decorative: the accessible name must come from aria-label, not from the
    // ligature text, or a screen reader would announce "neurology".
    expect(icon?.getAttribute("aria-hidden")).toBe("true");
  });

  it("announces the control AND its current value", () => {
    // Previously aria-label was just "Reasoning effort", which REPLACED the
    // visible text — assistive tech heard the dial's name but never its value.
    renderReasoningPill("high");
    expect(screen.getByRole("button", { name: "Reasoning effort: High" })).toBeTruthy();
  });

  it("exposes the same string as a hover tooltip", () => {
    renderReasoningPill();
    expect(screen.getByRole("button").getAttribute("title")).toBe("Reasoning effort: Medium");
  });

  it("reserves less horizontal chrome than the stylesheet default", () => {
    // globals.css ships 12px/24px. The pills only fit the 400px docked default
    // once that is trimmed, and a pill with a leading glyph gives up most of
    // its left padding because the glyph is the visual inset.
    renderReasoningPill();
    const withIcon = screen.getByRole("button") as HTMLButtonElement;
    expect(withIcon.style.paddingRight).toBe("20px");
    expect(withIcon.style.paddingLeft).toBe("5px");
  });

  it("keeps the normal left padding on a pill without an icon", () => {
    render(
      <HeaderDropdown
        ariaLabel="Chat provider"
        value="anthropic"
        triggerLabel="Claude"
        options={[{ id: "anthropic", label: "Anthropic" }]}
        onChange={vi.fn()}
      />,
    );
    const trigger = screen.getByRole("button") as HTMLButtonElement;
    expect(trigger.style.paddingLeft).toBe("10px");
    expect(trigger.style.paddingRight).toBe("20px");
  });

  it("still renders no icon when none is asked for", () => {
    render(
      <HeaderDropdown
        ariaLabel="Chat provider"
        value="anthropic"
        triggerLabel="Claude"
        options={[{ id: "anthropic", label: "Anthropic" }]}
        onChange={vi.fn()}
      />,
    );
    const glyphs = document.querySelectorAll(
      ".header-dropdown-trigger .material-symbols-rounded",
    );
    // Only the chevron.
    expect(glyphs.length).toBe(1);
    expect(glyphs[0].textContent).toBe("expand_more");
  });

  it("falls back to the active option's label when no triggerLabel is given", () => {
    render(
      <HeaderDropdown
        ariaLabel="Hermes model"
        value="m2"
        options={[{ id: "m1", label: "One" }, { id: "m2", label: "Two" }]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Hermes model: Two" })).toBeTruthy();
  });
});
