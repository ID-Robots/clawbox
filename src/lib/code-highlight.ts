/**
 * Colour for code: Prism's grammars, answered as LINES of typed pieces
 * rather than as HTML. The editors draw each piece as a React text node
 * inside a span classed by its type — the text never becomes markup, which
 * matters here because most of what is coloured was written by a run.
 *
 * Loaded on demand (`import("@/lib/code-highlight")`) by the editor, so the
 * desktop's own bundle does not carry twenty grammars for a pane most
 * sessions never open.
 */
import Prism from "prismjs";
import "prismjs/components/prism-markup";
import "prismjs/components/prism-css";
import "prismjs/components/prism-clike";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-json";
import "prismjs/components/prism-python";
import "prismjs/components/prism-bash";
import "prismjs/components/prism-yaml";
import "prismjs/components/prism-markdown";
import "prismjs/components/prism-sql";
import "prismjs/components/prism-go";
import "prismjs/components/prism-rust";
import "prismjs/components/prism-c";
import "prismjs/components/prism-cpp";
import "prismjs/components/prism-java";
import "prismjs/components/prism-ruby";
import "prismjs/components/prism-scss";
import "prismjs/components/prism-toml";
import "prismjs/components/prism-docker";
import "prismjs/components/prism-ini";
import type { CodeLanguage } from "@/lib/code-language";

import { plainLines, splitLines, type CodeLine, type CodePiece } from "@/lib/code-lines";

export type { CodeLine, CodePiece } from "@/lib/code-lines";
export { plainLines, splitLines } from "@/lib/code-lines";

/** Past this many characters a file is drawn plain: tokenising it on every keystroke would stall the editor. */
export const MAX_HIGHLIGHT_CHARS = 200_000;

/** Prism's token tree flattened to leaves, each carrying the innermost type it sits under. */
function flatten(tokens: Array<string | Prism.Token>, out: CodePiece[], parent: string | null): void {
  for (const token of tokens) {
    if (typeof token === "string") {
      out.push({ type: parent, text: token });
      continue;
    }
    // A `language-*` wrapper (a <script> block's body) says nothing about
    // colour itself; its children do.
    const type = token.type.startsWith("language-") ? parent : token.type;
    if (typeof token.content === "string") {
      out.push({ type, text: token.content });
    } else if (Array.isArray(token.content)) {
      flatten(token.content, out, type);
    } else {
      flatten([token.content], out, type);
    }
  }
}

/**
 * The text coloured by the grammar, line by line. An unknown or unloaded
 * grammar, or a text past the cap, is answered plain — never refused.
 */
export function highlightLines(text: string, language: CodeLanguage | string | null): CodeLine[] {
  if (!language || text.length > MAX_HIGHLIGHT_CHARS) return plainLines(text);
  const grammar = Prism.languages[language];
  if (!grammar) return plainLines(text);
  let tokens: Array<string | Prism.Token>;
  try {
    tokens = Prism.tokenize(text, grammar);
  } catch {
    return plainLines(text);
  }
  const pieces: CodePiece[] = [];
  flatten(tokens, pieces, null);
  return splitLines(pieces);
}
