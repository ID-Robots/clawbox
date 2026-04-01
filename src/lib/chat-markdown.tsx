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
      return <pre key={`${keyPrefix}-${j}`} style={{ background: 'rgba(255,255,255,0.06)', borderRadius: 8, padding: '8px 12px', margin: '6px 0', fontSize: 12, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{code}</pre>;
    }
    if (seg.startsWith('`') && seg.endsWith('`')) {
      return <code key={`${keyPrefix}-${j}`} style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 4, padding: '1px 5px', fontSize: '0.9em' }}>{seg.slice(1, -1)}</code>;
    }
    if (seg.startsWith('**') && seg.endsWith('**')) return <strong key={`${keyPrefix}-${j}`}>{seg.slice(2, -2)}</strong>;
    if (seg.startsWith('*') && seg.endsWith('*')) return <em key={`${keyPrefix}-${j}`}>{seg.slice(1, -1)}</em>;
    const linkMatch = seg.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const href = isSafeHref(linkMatch[2]) ? linkMatch[2] : "#";
      return <a key={`${keyPrefix}-${j}`} href={href} target="_blank" rel="noopener noreferrer" style={{ color: '#f97316', textDecoration: 'underline' }}>{linkMatch[1]}</a>;
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
    if (h2) return <h2 key={i} style={{ fontWeight: 700, fontSize: 14, marginTop: i > 0 ? 10 : 0, marginBottom: 4 }}>{renderInline(h2[1], `h-${i}`)}</h2>;
    const h3 = trimmed.match(/^###\s+(.+)/);
    if (h3) return <h3 key={i} style={{ fontWeight: 600, fontSize: 13.5, marginTop: i > 0 ? 8 : 0, marginBottom: 3 }}>{renderInline(h3[1], `h-${i}`)}</h3>;
    const lines = trimmed.split('\n');
    const isList = lines.every(l => /^\s*[-*]\s/.test(l) || !l.trim());
    if (isList) {
      return (
        <div key={i} style={{ margin: '4px 0', paddingLeft: 4 }}>
          {lines.filter(l => l.trim()).map((line, li) => (
            <div key={li} style={{ display: 'flex', gap: 6, marginBottom: 2 }}>
              <span style={{ opacity: 0.4 }}>•</span>
              <span>{renderInline(line.replace(/^\s*[-*]\s/, ''), `${i}-${li}`)}</span>
            </div>
          ))}
        </div>
      );
    }
    return (
      <div key={i} style={{ marginTop: i > 0 ? 8 : 0 }}>
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
