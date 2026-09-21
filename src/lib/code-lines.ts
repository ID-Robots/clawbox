/**
 * The shape an editor draws: lines of typed pieces. Apart from the
 * highlighter so the editor can import it without the grammars — the
 * coloured lines arrive later, from `src/lib/code-highlight.ts`.
 */

/** One coloured piece of a line: its token type (null for plain text) and the text itself. */
export interface CodePiece {
  type: string | null;
  text: string;
}

export type CodeLine = CodePiece[];

/** Plain lines: one untyped piece each — what is drawn before the grammars arrive, and for text no grammar knows. */
export function plainLines(text: string): CodeLine[] {
  return text.split("\n").map((line) => (line ? [{ type: null, text: line }] : []));
}

/** Pieces cut at every newline into lines; the text joined back is the input. */
export function splitLines(pieces: CodePiece[]): CodeLine[] {
  const lines: CodeLine[] = [[]];
  for (const piece of pieces) {
    const parts = piece.text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i]) lines[lines.length - 1].push({ type: piece.type, text: parts[i] });
    }
  }
  return lines;
}
