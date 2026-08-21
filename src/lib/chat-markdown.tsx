import React from "react";

function isSafeHref(url: string): boolean {
  try {
    const parsed = new URL(url, "https://localhost");
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function renderInline(text: string, keyPrefix: string) {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((seg, j) => {
    if (seg.startsWith('```') && seg.endsWith('```')) {
      const code = seg.slice(3, -3).replace(/^\w*\n/, '');
      return <pre key={`${keyPrefix}-${j}`} className="bg-white/[0.06] rounded-lg px-3 py-2 my-1.5 text-xs overflow-x-auto whitespace-pre-wrap break-words">{code}</pre>;
    }
    if (seg.startsWith('`') && seg.endsWith('`')) {
      return <code key={`${keyPrefix}-${j}`} className="bg-white/[0.08] rounded px-1.5 py-px text-[0.9em]">{seg.slice(1, -1)}</code>;
    }
    if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={`${keyPrefix}-${j}`}>{seg.slice(2, -2)}</strong>;
    if (seg.startsWith('*') && seg.endsWith('*')) return <em key={`${keyPrefix}-${j}`}>{seg.slice(1, -1)}</em>;
    const linkMatch = seg.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const href = isSafeHref(linkMatch[2]) ? linkMatch[2] : "#";
      return <a key={`${keyPrefix}-${j}`} href={href} target="_blank" rel="noopener noreferrer" className="text-[#f97316] underline">{linkMatch[1]}</a>;
    }
    return <span key={`${keyPrefix}-${j}`}>{seg}</span>;
  });
}

export function renderText(text: string) {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((para, i) => {
    const trimmed = para.trim();
    if (!trimmed) return null;
    const h2 = trimmed.match(/^##\s+(.+)/);
    if (h2) return <h2 key={i} className={`font-bold text-sm ${i > 0 ? "mt-2.5" : ""} mb-1`}>{renderInline(h2[1], `h-${i}`)}</h2>;
    const h3 = trimmed.match(/^###\s+(.+)/);
    if (h3) return <h3 key={i} className={`font-semibold text-[13.5px] ${i > 0 ? "mt-2" : ""} mb-0.5`}>{renderInline(h3[1], `h-${i}`)}</h3>;
    const lines = trimmed.split('\n');
    const isList = lines.every(l => /^\s*[-*]\s/.test(l) || !l.trim());
    if (isList) {
      return (
        <div key={i} className="my-1 pl-1">
          {lines.filter(l => l.trim()).map((line, li) => (
            <div key={li} className="flex gap-1.5 mb-0.5">
              <span className="opacity-40">•</span>
              <span>{renderInline(line.replace(/^\s*[-*]\s/, ''), `${i}-${li}`)}</span>
            </div>
          ))}
        </div>
      );
    }
    return (
      <div key={i} className={i > 0 ? "mt-2" : ""}>
        {lines.map((line, li) => (
          <span key={li}>
            {li > 0 && <br />}
            {renderInline(line, `${i}-${li}`)}
          </span>
        ))}
      </div>
    );
  });
}

/**
 * The same message as plain speech, for an accessible name.
 *
 * A control's accessible name is read aloud verbatim, so the markdown source
 * cannot go in it: `*"seventeen copper bells"*` is announced as "asterisk
 * quote seventeen copper bells quote asterisk", and a fenced block reads its
 * backticks out one by one. The audio player's label was the raw `msg.text`,
 * so every emphasis mark, link URL and heading hash in a spoken reply landed
 * in the screen reader.
 *
 * Deliberately in this file and not next to the player: it strips the same
 * markers `renderInline`/`renderText` consume, so the two cannot drift into
 * disagreeing about what counts as markup. Where it differs it strips MORE,
 * never less: `renderText` only promotes `##`/`###` to headings and only
 * bullets a paragraph made entirely of them, while this drops any leading
 * `#`s and any leading bullet. That asymmetry is the safe one — a stray `#`
 * that stays on screen costs nothing, but spoken aloud it is just noise.
 *
 * `max` is a budget for the SPOKEN name, so it cuts on a word boundary — the
 * previous `slice(0, 100)` could stop mid-word, and mid-token, which is worse
 * out loud than it looks on screen.
 */
export function plainTextForLabel(text: string, max = 100): string {
  const flat = text
    // Fenced blocks first: their content may contain any other marker.
    .replace(/```[\s\S]*?```/g, (seg) => seg.slice(3, -3).replace(/^\w*\n/, ""))
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    // Headings and list bullets are line-leading, so anchor them per line.
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour the word boundary if one exists late enough to leave a useful
  // label; a single very long token still gets truncated rather than dropped.
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
