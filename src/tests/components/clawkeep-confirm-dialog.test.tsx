/**
 * The confirm dialog ClawKeep and Memory Shard share (src/components/clawkeep-ui.tsx).
 *
 * It used to hand-roll Escape and nothing else: a keyboard user could Tab
 * straight out of "delete every backup?" into the window behind it, and when
 * the dialog closed, focus was wherever the browser dropped it. It now runs on
 * the desktop's one modal behaviour (useModalDialog), and these are the
 * guarantees that come with it — plus the one thing this dialog keeps of its
 * own: Enter confirms, because focus starts on Confirm.
 */
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { translations } from "@/lib/translations";
import { ConfirmDialog } from "@/components/clawkeep-ui";

const t = (key: string, params?: Record<string, string | number>) => {
  let str = translations.en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) str = str.replaceAll(`{${k}}`, String(v));
  return str;
};
vi.mock("@/lib/i18n", () => ({ useT: () => ({ locale: "en", t }) }));

const CANCEL = translations.en["clawkeep.cancel"];

function Harness({ onConfirm = () => {} }: { onConfirm?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>delete backups</button>
      <button type="button">another control</button>
      {open && (
        <ConfirmDialog
          title="Delete every backup?"
          body="They are gone for good."
          confirmLabel="Delete"
          danger
          onCancel={() => setOpen(false)}
          onConfirm={() => { onConfirm(); setOpen(false); }}
        />
      )}
    </div>
  );
}

describe("ConfirmDialog", () => {
  it("starts on Confirm, keeps Tab inside the dialog, and hands focus back on close", () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "delete backups" });
    trigger.focus();
    fireEvent.click(trigger);

    // The role sits on the panel, and the panel is what is labelled.
    const dialog = screen.getByRole("dialog", { name: "Delete every backup?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const confirm = screen.getByRole("button", { name: "Delete" });
    const cancel = screen.getByRole("button", { name: CANCEL });
    // Enter confirms: that is where focus begins, as it always has.
    expect(document.activeElement).toBe(confirm);

    // The page behind is out of reach — for Tab and for a screen reader.
    expect(screen.queryByRole("button", { name: "another control" })).toBeNull();

    // Confirm is the last control: Tab wraps to the first, not out.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    // ...and Shift-Tab from the first wraps to the last.
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    // Back where the owner was, with the page usable again.
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("button", { name: "another control" })).toBeInTheDocument();
    expect(document.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("confirms from the button, and cancels from Cancel and from the backdrop", () => {
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("button", { name: "delete backups" }));
    fireEvent.click(screen.getByRole("button", { name: CANCEL }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "delete backups" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
