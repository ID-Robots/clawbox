/**
 * The shared code editor (src/components/CodeEditor.tsx): a numbered
 * gutter, coloured text drawn as TEXT, a textarea over it while editing
 * that indents on Tab and saves on Ctrl+S, and none of that textarea in
 * the read-only view.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@/tests/helpers/test-utils";
import CodeEditor from "@/components/CodeEditor";

describe("CodeEditor", () => {
  it("draws every line numbered, coloured once the grammar has loaded, as text and never markup", async () => {
    render(<CodeEditor value={"<b>hi</b>\n<script>alert(1)</script>\n"} language="markup" testId="ed" />);
    const text = screen.getByTestId("ed-text");
    // Three rows: the trailing newline's empty row is dropped in the read-only view.
    expect(text.querySelectorAll(".cb-code-line")).toHaveLength(2);
    expect(screen.getByTestId("ed").querySelectorAll(".cb-code-gutter-line")).toHaveLength(2);
    // The agent-written <script> is characters on the page, not an element.
    expect(text.querySelector("script")).toBeNull();
    expect(text.querySelector("b")).toBeNull();
    expect(text.textContent).toContain("<script>alert(1)</script>");
    await waitFor(() => expect(text.querySelector(".tok-tag")).not.toBeNull());
    expect(screen.getByTestId("ed")).toHaveAttribute("data-language", "markup");
    expect(screen.getByTestId("ed").querySelector("textarea")).toBeNull();
  });

  it("stays plain, with the rows still numbered, when no grammar applies", () => {
    render(<CodeEditor value={"one\ntwo\nthree"} language={null} testId="ed" />);
    expect(screen.getByTestId("ed")).toHaveAttribute("data-language", "plain");
    expect(screen.getByTestId("ed-text").querySelectorAll(".cb-code-line")).toHaveLength(3);
    expect(screen.getByTestId("ed").querySelector("[class^=tok-]")).toBeNull();
  });

  it("edits through a textarea that mirrors the text, indents on Tab, keeps indentation on Enter and saves on Ctrl+S", () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    render(<CodeEditor value={"  a"} onChange={onChange} onSave={onSave} language="javascript" ariaLabel="app.js" testId="ed" />);
    const input = screen.getByRole("textbox", { name: "app.js" }) as HTMLTextAreaElement;
    expect(input).toHaveValue("  a");
    // The editor keeps the empty row a trailing newline makes, so the caret can stand there.
    expect(screen.getByTestId("ed")).toHaveAttribute("data-editable", "true");

    fireEvent.change(input, { target: { value: "  ab" } });
    expect(onChange).toHaveBeenLastCalledWith("  ab");

    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onChange).toHaveBeenLastCalledWith("  a  ");

    input.value = "  a";
    input.setSelectionRange(3, 3);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith("  a\n  ");

    fireEvent.keyDown(input, { key: "s", ctrlKey: true });
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: "S", metaKey: true });
    expect(onSave).toHaveBeenCalledTimes(2);
  });

  it("takes one indent back on Shift+Tab", () => {
    const onChange = vi.fn();
    render(<CodeEditor value={"    x"} onChange={onChange} language={null} testId="ed" />);
    const input = screen.getByTestId("ed-input") as HTMLTextAreaElement;
    input.setSelectionRange(5, 5);
    fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith("  x");
  });
});
