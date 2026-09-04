/**
 * The desktop toast surface (src/components/ToastHost.tsx).
 *
 * Found on a real box: page.tsx dispatched `clawbox:toast` for every
 * `ui_notify`, `clawbox notify` and server-side owner notice, and nothing
 * listened — the events fired into the void. This pins that a dispatched
 * message is rendered as text, can be dismissed, and that junk is ignored.
 */
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/tests/helpers/test-utils";
import ToastHost, { TOAST_EVENT } from "@/components/ToastHost";
import { OPEN_APP_EVENT, OPEN_SETTINGS_SECTION_EVENT } from "@/lib/ui-events";
import { NOTICE_AUTO_HIDE_MS } from "@/lib/use-auto-hide";

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

/**
 * The owner asked for the email-approval bubble to be a door: "when I click
 * the bubble (not on the X) but inside the bubble" it should open Settings →
 * Email, where the draft is waiting. The destination rides on the notice as an
 * ALLOWLISTED pair, never as a free-form target — `ui_notify`'s text is
 * written by the agent, and the same ring carries it.
 */
describe("ToastHost — a notice that can be acted on", () => {
  function listen(name: string, into: unknown[]) {
    const on = (e: Event) => into.push((e as CustomEvent).detail);
    window.addEventListener(name, on);
    return () => window.removeEventListener(name, on);
  }

  it("opens Settings on the email section when the body is clicked, and takes the toast away", () => {
    const sections: unknown[] = [];
    const apps: unknown[] = [];
    const stopSections = listen(OPEN_SETTINGS_SECTION_EVENT, sections);
    const stopApps = listen(OPEN_APP_EVENT, apps);
    try {
      render(<ToastHost />);
      dispatch({
        message: "The assistant wants to send an email. Open Settings → Email to approve or delete it.",
        action: { open: "settings", section: "email" },
      });

      // The accessible name carries the notice AND where the click goes: the
      // toast is a live region, so a name that was only the destination would
      // be all a screen reader announced.
      const body = screen.getByRole("button", { name: /^The assistant wants to send an email\..* — Open Settings → Email$/ });
      expect(body.textContent).toContain("The assistant wants to send an email.");
      act(() => { fireEvent.click(body); });

      expect(sections).toEqual([{ section: "email" }]);
      expect(apps).toEqual([{ appId: "settings" }]);
      // The cold-open handoff, so a Settings window that is not up yet still
      // lands on the section.
      expect((window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection).toBe("email");
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      stopSections();
      stopApps();
      delete (window as Window & { __clawboxPendingSettingsSection?: unknown }).__clawboxPendingSettingsSection;
    }
  });

  it("the X still only dismisses — it never opens anything", () => {
    const sections: unknown[] = [];
    const apps: unknown[] = [];
    const stopSections = listen(OPEN_SETTINGS_SECTION_EVENT, sections);
    const stopApps = listen(OPEN_APP_EVENT, apps);
    try {
      render(<ToastHost />);
      dispatch({ message: "An email is waiting", action: { open: "settings", section: "email" } });
      act(() => { fireEvent.click(screen.getByRole("button", { name: "Dismiss" })); });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(sections).toEqual([]);
      expect(apps).toEqual([]);
    } finally {
      stopSections();
      stopApps();
    }
  });

  it("a plain notice has no clickable body at all", () => {
    render(<ToastHost />);
    dispatch({ message: "Coding agent finished" });
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Dismiss"]);
  });

  it("stays for the desktop's shared clock, not the eight seconds a plain notice gets", () => {
    // Eight seconds is how long it takes to READ a bubble. This one has to be
    // clicked, and a toast that vanishes under the pointer puts the owner back
    // on the walk to Settings this feature exists to remove.
    vi.useFakeTimers();
    try {
      render(<ToastHost />);
      dispatch({ message: "plain notice" });
      dispatch({ message: "an email is waiting", action: { open: "settings", section: "email" } });

      act(() => { vi.advanceTimersByTime(8_001); });
      const left = screen.getAllByRole("status").map((el) => el.textContent);
      expect(left).toHaveLength(1);
      expect(left[0]).toContain("an email is waiting");

      act(() => { vi.advanceTimersByTime(NOTICE_AUTO_HIDE_MS - 8_000); });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops an action that is not on the allowlist rather than rendering it", () => {
    render(<ToastHost />);
    dispatch({ message: "one", action: { open: "settings", section: "system" } });
    dispatch({ message: "two", action: { open: "browser", section: "email" } });
    dispatch({ message: "three", action: { open: "settings", section: "email", href: "https://example.invalid" } });
    dispatch({ message: "four", action: "settings" });
    dispatch({ message: "five", action: { open: "constructor", section: "email" } });

    // Only the one legitimate pair becomes a button, and the smuggled `href`
    // did not travel with it.
    const actionable = screen.getAllByRole("button").filter((b) => b.getAttribute("aria-label")?.endsWith("Open Settings → Email"));
    expect(actionable).toHaveLength(1);
    expect(actionable[0].textContent).toContain("three");
    expect(actionable[0].outerHTML).not.toContain("example.invalid");
  });
});
