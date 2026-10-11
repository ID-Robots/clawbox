/**
 * The string work behind the Screenshot app's own renderer (TASK-1475): which
 * fonts a snapshot embeds, where the URLs in a CSS value are, and what must be
 * stripped before markup can be parsed as XML.
 */
import { describe, expect, it } from "vitest";
import {
  type LoadedFonts,
  cssPropertyName,
  cssUrls,
  fontFaceIsUsed,
  isXmlAttributeName,
  normalizeFontFamily,
  normalizeUnicodeRange,
  parseFontFaces,
  replaceCssUrls,
  rewriteFontFaces,
  sanitizeXml,
} from "@/lib/screenshot/capture-css";

describe("CSS urls", () => {
  it("finds every url() however it is quoted", () => {
    expect(cssUrls('url("/a.png"), linear-gradient(red, blue), url(\'b.jpg\'), url(c.gif)')).toEqual(["/a.png", "b.jpg", "c.gif"]);
    expect(cssUrls("none")).toEqual([]);
    expect(cssUrls('url("")')).toEqual([]);
  });

  it("replaces targets and leaves the rest of the value alone", () => {
    const value = 'url("/wall.jpg"), linear-gradient(#000, #fff)';
    expect(replaceCssUrls(value, () => "data:image/png;base64,AAA")).toBe('url("data:image/png;base64,AAA"), linear-gradient(#000, #fff)');
    expect(replaceCssUrls(value, () => null)).toBe(value);
    expect(replaceCssUrls("url(a.png) url(b.png)", (url) => (url === "a.png" ? "X" : null))).toBe('url("X") url(b.png)');
  });

  it("cannot be broken out of with a quote in the replacement", () => {
    expect(replaceCssUrls("url(a)", () => 'x") ; evil: url("y')).not.toMatch(/"\) ; evil/);
  });
});

describe("font faces", () => {
  const css = `
    .a { color: red }
    @font-face { font-family: "Material Symbols Rounded"; font-style: normal; src: url("/fonts/symbols.ttf") format("truetype"); }
    @font-face{font-family:Inter;src:url(/a.woff) format("woff"),url(/a.woff2) format("woff2");unicode-range:U+0000-00FF, u+0131}
    @font-face { font-family: 'Inter'; src: url(/b.woff2); unicode-range: U+0400-04FF }
    @font-face { font-family: Unused; src: url(/unused.woff2) }
    .b { background: url(/keep.png) }
  `;

  it("normalizes families and ranges so two spellings compare equal", () => {
    expect(normalizeFontFamily(' "Material Symbols Rounded" ')).toBe("material symbols rounded");
    expect(normalizeFontFamily("'Inter'")).toBe("inter");
    expect(normalizeUnicodeRange("U+0000-00FF, u+0131")).toBe("U+0-FF,U+131");
    expect(normalizeUnicodeRange("U+0-10FFFF")).toBe("U+0-10FFFF");
    expect(normalizeUnicodeRange("U+4??")).toBe("U+4??");
  });

  it("parses each block's family, range and best source", () => {
    const blocks = parseFontFaces(css);
    expect(blocks.map((b) => [b.family, b.unicodeRange, b.url])).toEqual([
      ["material symbols rounded", "", "/fonts/symbols.ttf"],
      ["inter", "U+0-FF,U+131", "/a.woff2"],
      ["inter", "U+400-4FF", "/b.woff2"],
      ["unused", "", "/unused.woff2"],
    ]);
  });

  it("keeps only the faces the page actually loaded", () => {
    const loaded: LoadedFonts = new Map([
      ["material symbols rounded", new Set(["U+0-10FFFF"])],
      ["inter", new Set(["U+0-FF,U+131"])],
    ]);
    const [symbols, latin, cyrillic, unused] = parseFontFaces(css);
    expect(fontFaceIsUsed(symbols, loaded)).toBe(true);
    expect(fontFaceIsUsed(latin, loaded)).toBe(true);
    expect(fontFaceIsUsed(cyrillic, loaded)).toBe(false);
    expect(fontFaceIsUsed(unused, loaded)).toBe(false);
    // Unknown (a browser without document.fonts): keep everything rather than lose glyphs.
    expect(fontFaceIsUsed(unused, null)).toBe(true);
    expect(fontFaceIsUsed({ ...unused, url: null }, null)).toBe(false);
  });

  it("rewrites used faces to embedded data and drops the rest", () => {
    const loaded: LoadedFonts = new Map([
      ["material symbols rounded", new Set(["U+0-10FFFF"])],
      ["inter", new Set(["U+0-FF,U+131"])],
    ]);
    const out = rewriteFontFaces(
      css,
      loaded,
      new Map([
        ["/fonts/symbols.ttf", "data:font/ttf;base64,SYM"],
        ["/a.woff2", "data:font/woff2;base64,LAT"],
      ]),
    );
    expect(out).toContain('src:url("data:font/ttf;base64,SYM")');
    expect(out).toContain('src:url("data:font/woff2;base64,LAT")');
    expect(out).toContain("unicode-range:U+0000-00FF, u+0131");
    expect(out).toContain('font-family: "Material Symbols Rounded"');
    // Nothing still points at a URL an image document may not fetch.
    expect(out).not.toMatch(/url\(["']?\/(fonts|a|b|unused)/);
    expect(out).not.toContain("Unused");
    // Ordinary rules pass through untouched.
    expect(out).toContain(".a { color: red }");
    expect(out).toContain("url(/keep.png)");
  });

  it("drops a used face whose file could not be embedded", () => {
    const loaded: LoadedFonts = new Map([["inter", new Set(["U+400-4FF"])]]);
    expect(rewriteFontFaces(css, loaded, new Map([["/b.woff2", null]]))).not.toContain("@font-face");
    expect(rewriteFontFaces(css, loaded, new Map())).not.toContain("@font-face");
  });
});

describe("XML safety", () => {
  it("strips the control characters a terminal leaves in its output", () => {
    expect(sanitizeXml("a\u0000b\u0007c\u001bd\u000be")).toBe("abcde");
  });

  it("keeps tabs, new lines and ordinary text in any script", () => {
    const text = "tab\tnew\nline\r café Здравей 日本語 👍";
    expect(sanitizeXml(text)).toBe(text);
  });

  it("strips unpaired surrogates, which would stop the picture decoding", () => {
    expect(sanitizeXml("a\ud83db")).toBe("ab");
    expect(sanitizeXml("a\udc4db")).toBe("ab");
    expect(() => encodeURIComponent(sanitizeXml("x\ud800y"))).not.toThrow();
  });

  it("accepts the attribute names XML can carry and refuses the rest", () => {
    for (const name of ["class", "data-window-id", "aria-label", "xlink:href", "viewBox", "_x"]) {
      expect(isXmlAttributeName(name), name).toBe(true);
    }
    for (const name of ["@click", ":bind", "x-on:click.prevent:extra", "1abc", "a b", ""]) {
      expect(isXmlAttributeName(name), name).toBe(false);
    }
  });

  it("names animated properties the way a style attribute spells them", () => {
    expect(cssPropertyName("backgroundColor")).toBe("background-color");
    expect(cssPropertyName("opacity")).toBe("opacity");
    expect(cssPropertyName("cssFloat")).toBe("float");
    expect(cssPropertyName("cssOffset")).toBe("offset");
    expect(cssPropertyName("--tw-Scale")).toBe("--tw-Scale");
  });
});
