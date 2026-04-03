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
