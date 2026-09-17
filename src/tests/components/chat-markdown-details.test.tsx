/**
 * `<details><summary>…</summary>…</details>` in a reply.
 *
 * OpenClaw agents fold asides into a `<details>` block — a correction, a long
 * tool dump, a second opinion — and OpenClaw's own UI draws them as a
 * disclosure. This renderer printed the tags, so a reply whose interesting half
 * was inside one reached the owner as a wall of angle brackets (seen on the
 * box: "raw `<details><summary>Two corrections to earlier claims</summary>`" in
 * the mascot chat).
 *
 * It is also the ONLY HTML this renderer admits, and the tags are CONSUMED into
 * a block rather than handed to `innerHTML` — the cases below pin both halves.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@/tests/helpers/test-utils";
import { plainTextForLabel, renderText } from "@/lib/chat-markdown";

function bubble(text: string) {
  return render(<div data-testid="bubble">{renderText(text)}</div>);
}

describe("details blocks", () => {
  it("folds the aside behind its summary instead of printing the tags", () => {
    const { container } = bubble(
      "Here is the plan.\n\n<details><summary>Two corrections to earlier claims</summary>\n\nThe first claim was wrong.\n\n</details>",
    );

    expect(container.textContent).toContain("Here is the plan.");
    expect(container.textContent).toContain("Two corrections to earlier claims");
    // The tags themselves are gone from the bubble.
    expect(container.textContent).not.toContain("<details>");
    expect(container.textContent).not.toContain("<summary>");
    expect(container.textContent).not.toContain("</details>");
    // Closed by default: the aside is an aside.
    expect(container.textContent).not.toContain("The first claim was wrong.");
    expect(screen.getByTestId("chat-markdown-details-toggle")).toHaveAttribute("aria-expanded", "false");
  });

  it("opens on the summary and renders the body as markdown", () => {
    const { container } = bubble(
      "<details>\n<summary>What I ran</summary>\n\n- one\n- two\n\n</details>",
    );

    fireEvent.click(screen.getByTestId("chat-markdown-details-toggle"));
    expect(screen.getByTestId("chat-markdown-details-toggle")).toHaveAttribute("aria-expanded", "true");
    expect(container.textContent).toContain("one");
    expect(container.textContent).toContain("two");
    // Rendered as markdown, not as a blob of source.
    expect(container.textContent).not.toContain("- one");
  });

  it("folds a block whose closing tag has not streamed in yet", () => {
    // A partial reply is the normal shape while a turn is still streaming, and
    // flashing raw tags for every delta is the bug in miniature.
    const { container } = bubble("<details><summary>Still writing</summary>\nthe first half");
    expect(container.textContent).toContain("Still writing");
    expect(container.textContent).not.toContain("<details>");
    expect(container.textContent).not.toContain("<summary>");
  });

  it("keeps the prose that shares the line with the tag", () => {
    const { container } = bubble("Done. <details><summary>Details</summary>body</details> Anything else?");
    expect(container.textContent).toContain("Done.");
    expect(container.textContent).toContain("Anything else?");
    expect(container.textContent).not.toContain("<details>");
  });

  it("admits no other HTML", () => {
    // Nothing here is a sanitiser: React prints text, and this is the proof
    // that consuming `<details>` did not open a door beside it.
    const { container } = bubble("<b>bold</b> and <script>alert(1)</script>");
    expect(container.textContent).toContain("<b>bold</b>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
  });

  it("never reads the tags out loud", () => {
    // A control's accessible name is spoken verbatim; "less than details
    // greater than" is not something anyone asked to hear.
    expect(plainTextForLabel("<details><summary>Why</summary>because</details>")).toBe(
      "Why because",
    );
  });
});
