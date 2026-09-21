"use client";

/**
 * The one code editor on the device: the Files app's viewer and the Coding
 * Agent's Files tab both draw through it. A numbered gutter, the text
 * coloured by Prism's grammars — loaded on demand and drawn as React text
 * nodes, never as markup, since most of what is coloured was written by a
 * run — and, when the host hands an `onChange`, a transparent textarea laid
 * over the coloured text that takes the typing: the two share one font and
 * one padding, so the caret stands on the glyph it moves. Without
 * `onChange` it is a read-only, selectable view.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CodeLanguage } from "@/lib/code-language";
import { plainLines, type CodeLine } from "@/lib/code-lines";

type Highlighter = typeof import("@/lib/code-highlight");
let loaded: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;

/** The grammars, fetched once per page and shared by every editor on it. */
function loadHighlighter(): Promise<Highlighter> {
  if (loaded) return Promise.resolve(loaded);
  loading ??= import("@/lib/code-highlight").then((mod) => {
    loaded = mod;
    return mod;
  });
  return loading;
}

/** What one Tab inserts. Two spaces: what the runs write, and what `tab-size` draws a tab as. */
export const INDENT = "  ";

/**
 * Put `text` over [start, end) the way a keystroke would, so the browser
 * records the edit on the textarea's OWN undo stack. `setRangeText` writes the
 * value without one, which made Tab, Shift+Tab and the auto-indent the only
 * edits in a file that Ctrl+Z could not take back: the spaces stayed, the
 * dirty dot stayed, and Close asked to discard a change the owner had already
 * undone. `execCommand` is deprecated and still the only API that offers this;
 * where it is missing or refuses (jsdom, a future removal) fall back to
 * `setRangeText` — the old behaviour, which is better than no edit at all.
 */
function typeInto(el: HTMLTextAreaElement, text: string, start: number, end: number): void {
  if (!text && start === end) return;
  const doc = el.ownerDocument;
  if (typeof doc?.execCommand === "function") {
    el.setSelectionRange(start, end);
    try {
      // Replacing a selection with nothing is a deletion: insertText("") is a
      // no-op in some engines.
      if (doc.execCommand(text ? "insertText" : "delete", false, text)) return;
    } catch { /* fall through to the write that costs the undo entry */ }
  }
  el.setRangeText(text, start, end, "end");
}

export interface CodeEditorProps {
  value: string;
  /** Present: the text can be typed into. Absent: a read-only view. */
  onChange?: (next: string) => void;
  language: CodeLanguage | null;
  /** Ctrl/Cmd+S while editing. */
  onSave?: () => void;
  autoFocus?: boolean;
  ariaLabel?: string;
  className?: string;
  testId?: string;
}

export default function CodeEditor({ value, onChange, language, onSave, autoFocus, ariaLabel, className = "", testId }: CodeEditorProps) {
  const [highlighter, setHighlighter] = useState<Highlighter | null>(loaded);
  useEffect(() => {
    if (highlighter || !language) return;
    let cancelled = false;
    loadHighlighter()
      .then((mod) => { if (!cancelled) setHighlighter(mod); })
      .catch(() => { /* drawn plain */ });
    return () => { cancelled = true; };
  }, [highlighter, language]);

  const editable = typeof onChange === "function";
  const lines = useMemo<CodeLine[]>(() => {
    const out = highlighter && language ? highlighter.highlightLines(value, language) : plainLines(value);
    // A read-only view drops the empty row a trailing newline makes; the
    // editor keeps it, since the caret can stand there.
    if (!editable && out.length > 1 && out[out.length - 1].length === 0) out.pop();
    return out;
  }, [highlighter, language, value, editable]);

  const inputRef = useRef<HTMLTextAreaElement>(null);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      if (!onSave) return;
      e.preventDefault();
      e.stopPropagation();
      onSave();
      return;
    }
    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Tab indents rather than walking the focus: a code editor whose Tab
      // key leaves the editor is not one. At a caret or over one line's
      // selection it inserts; over lines it indents every line the
      // selection touches and keeps the selection over them. Shift+Tab
      // takes one indent back the same way.
      e.preventDefault();
      const { selectionStart, selectionEnd, value } = el;
      const spansLines = selectionStart !== selectionEnd && value.slice(selectionStart, selectionEnd).includes("\n");
      if (e.shiftKey || spansLines) {
        const firstLine = value.lastIndexOf("\n", selectionStart - 1) + 1;
        // A selection that ends right after a newline does not touch the next line.
        const endProbe = selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd;
        const nextBreak = value.indexOf("\n", endProbe);
        const blockEnd = nextBreak === -1 ? value.length : nextBreak;
        const lines = value.slice(firstLine, blockEnd).split("\n");
        let firstDelta = 0;
        let total = 0;
        const next = lines.map((line, i) => {
          const delta = e.shiftKey ? -(/^ {1,2}/.exec(line)?.[0].length ?? 0) : INDENT.length;
          if (i === 0) firstDelta = delta;
          total += delta;
          return e.shiftKey ? line.slice(-delta) : INDENT + line;
        }).join("\n");
        if (total === 0) return;
        typeInto(el, next, firstLine, blockEnd);
        const start = Math.max(firstLine, selectionStart + firstDelta);
        el.setSelectionRange(start, Math.max(start, selectionEnd + total));
      } else {
        typeInto(el, INDENT, selectionStart, selectionEnd);
      }
      onChange?.(el.value);
      return;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
      // A new line keeps the indentation of the one it leaves.
      const { selectionStart, selectionEnd } = el;
      const lineStart = el.value.lastIndexOf("\n", selectionStart - 1) + 1;
      const indent = /^[ \t]*/.exec(el.value.slice(lineStart, selectionStart))?.[0] ?? "";
      if (!indent) return;
      e.preventDefault();
      typeInto(el, `\n${indent}`, selectionStart, selectionEnd);
      onChange?.(el.value);
    }
  };

  return (
    <div
      className={`cb-code ${className}`}
      data-testid={testId}
      data-language={language ?? "plain"}
      data-editable={editable || undefined}
      onClick={editable ? (e) => { if (e.target === e.currentTarget) inputRef.current?.focus(); } : undefined}
    >
      <div className="cb-code-gutter" aria-hidden="true">
        {lines.map((_, i) => <div key={i} className="cb-code-gutter-line">{i + 1}</div>)}
      </div>
      <div className="cb-code-body">
        <pre className="cb-code-pre" aria-hidden={editable || undefined} data-testid={testId ? `${testId}-text` : undefined}>
          {lines.map((line, i) => (
            <div key={i} className="cb-code-line">
              {line.map((piece, j) => <span key={j} className={piece.type ? `tok-${piece.type}` : undefined}>{piece.text}</span>)}
            </div>
          ))}
        </pre>
        {editable && (
          <textarea
            ref={inputRef}
            className="cb-code-input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            autoComplete="off"
            wrap="off"
            autoFocus={autoFocus}
            aria-label={ariaLabel}
            data-testid={testId ? `${testId}-input` : undefined}
          />
        )}
      </div>
    </div>
  );
}
