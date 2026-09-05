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
      // key leaves the editor is not one. Shift+Tab takes one indent back.
      e.preventDefault();
      const { selectionStart, selectionEnd } = el;
      if (e.shiftKey) {
        const lineStart = el.value.lastIndexOf("\n", selectionStart - 1) + 1;
        const leading = /^ {1,2}/.exec(el.value.slice(lineStart))?.[0] ?? "";
        if (!leading) return;
        el.setRangeText("", lineStart, lineStart + leading.length, "preserve");
        const caret = Math.max(lineStart, selectionStart - leading.length);
        el.setSelectionRange(caret, Math.max(caret, selectionEnd - leading.length));
      } else {
        el.setRangeText(INDENT, selectionStart, selectionEnd, "end");
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
      el.setRangeText(`\n${indent}`, selectionStart, selectionEnd, "end");
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
