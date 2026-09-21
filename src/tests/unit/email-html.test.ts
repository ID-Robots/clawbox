// The sanitiser is the load-bearing security control of the full-message view:
// everything it lets through is rendered inside the owner's dashboard from
// markup a stranger wrote. These tests are therefore written as attacks first
// and formatting second.

import { describe, expect, it } from "vitest";
import {
  blockRemoteImages,
  emailTextToNodes,
  isSafeHref,
  sanitizeEmailHtml,
  type EmailElementNode,
  type EmailImageNode,
  type EmailNode,
} from "@/lib/email-html";

/** Every tag name anywhere in the tree. */
function tags(nodes: EmailNode[]): string[] {
  const out: string[] = [];
  const walk = (list: EmailNode[]): void => {
    for (const node of list) {
      if (node.type === "element") {
        out.push(node.tag);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** All visible text, concatenated. */
function text(nodes: EmailNode[]): string {
  let out = "";
  const walk = (list: EmailNode[]): void => {
    for (const node of list) {
      if (node.type === "text") out += node.text;
      else if (node.type === "element") walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function images(nodes: EmailNode[]): EmailImageNode[] {
  const out: EmailImageNode[] = [];
  const walk = (list: EmailNode[]): void => {
    for (const node of list) {
      if (node.type === "image") out.push(node);
      else if (node.type === "element") walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

function links(nodes: EmailNode[]): EmailElementNode[] {
  const out: EmailElementNode[] = [];
  const walk = (list: EmailNode[]): void => {
    for (const node of list) {
      if (node.type === "element") {
        if (node.tag === "a") out.push(node);
        walk(node.children);
      }
    }
  };
  walk(nodes);
  return out;
}

/** The serialised tree, for "no trace of it survives anywhere" assertions. */
const dump = (nodes: EmailNode[]): string => JSON.stringify(nodes);

describe("script and executable content", () => {
  it("drops a script element and everything inside it", () => {
    const nodes = sanitizeEmailHtml("<p>before</p><script>alert(1)</script><p>after</p>");
    expect(text(nodes)).toBe("beforeafter");
    expect(dump(nodes)).not.toContain("alert");
  });

  it("cannot be tricked into reassembling a script tag it just removed", () => {
    // The classic incomplete-multi-character-sanitisation payload: a pass that
    // DELETES "<script>" turns this into a working one. A forward scanner
    // consumes `<scr<script>` whole as one (unknown, therefore dropped) tag and
    // never re-reads what it emitted, so the remainder can only ever be TEXT.
    //
    // The residue does still say "alert(1)" — as words. That is the correct
    // outcome and matches what a browser shows for the same payload: the
    // security property is that no script ELEMENT exists, not that the letters
    // never appear. A text node is rendered by React as text and cannot run.
    const nodes = sanitizeEmailHtml("<scr<script>ipt>alert(1)</script>");
    expect(tags(nodes)).toEqual([]);
    expect(nodes.every((n) => n.type === "text")).toBe(true);
  });

  it("drops the content of a script block that is never closed", () => {
    const nodes = sanitizeEmailHtml("<p>hi</p><script>alert(1)");
    expect(text(nodes)).toBe("hi");
    expect(dump(nodes)).not.toContain("alert");
  });

  it("drops an iframe, so no third-party document can be embedded", () => {
    const nodes = sanitizeEmailHtml('<iframe src="https://evil.example/x"></iframe><p>hi</p>');
    expect(tags(nodes)).not.toContain("iframe");
    expect(dump(nodes)).not.toContain("evil.example");
  });

  it.each(["object", "embed", "form", "button", "select", "textarea", "template", "noscript"])(
    "drops <%s> and its content",
    (tag) => {
      const nodes = sanitizeEmailHtml(`<${tag}>payload</${tag}><p>kept</p>`);
      expect(text(nodes)).toBe("kept");
    },
  );

  it("drops svg, which is a second parsing mode with its own script vectors", () => {
    const nodes = sanitizeEmailHtml("<svg><script>alert(1)</script></svg><p>kept</p>");
    expect(text(nodes)).toBe("kept");
    expect(dump(nodes)).not.toContain("alert");
  });

  it("keeps a '<' that is arithmetic rather than markup", () => {
    expect(text(sanitizeEmailHtml("<p>1 < 2 and 3 > 2</p>"))).toBe("1 < 2 and 3 > 2");
  });

  it("does not leak an attribute value that contains a '>'", () => {
    const nodes = sanitizeEmailHtml('<p title="a>b">hi</p>');
    expect(text(nodes)).toBe("hi");
  });

  it("drops a comment even when there is a '>' inside it", () => {
    expect(text(sanitizeEmailHtml("<p>a<!-- x > y -->b</p>"))).toBe("ab");
  });
});

describe("event handlers and attributes", () => {
  it("keeps no event handler, whatever the element", () => {
    const nodes = sanitizeEmailHtml(
      '<p onclick="steal()" onmouseover="steal()" onerror="steal()">hi</p>',
    );
    expect(dump(nodes)).not.toContain("steal");
    expect(dump(nodes)).not.toContain("onclick");
  });

  it("keeps no attribute outside the allow-list, including novel ones", () => {
    const nodes = sanitizeEmailHtml(
      '<div id="x" class="y" style="position:fixed" data-thing="z" srcset="a" formaction="b">hi</div>',
    );
    const el = nodes[0] as EmailElementNode;
    // Only the modelled fields exist; there is no attribute bag to leak into.
    expect(Object.keys(el).sort()).toEqual(["children", "tag", "type"]);
    expect(dump(nodes)).not.toContain("position:fixed");
  });
});

describe("CSS cannot escape the container", () => {
  it("drops a style element whole", () => {
    const nodes = sanitizeEmailHtml("<style>body{display:none}</style><p>kept</p>");
    expect(text(nodes)).toBe("kept");
    expect(dump(nodes)).not.toContain("display:none");
  });

  it("drops the content of a style block that is never closed", () => {
    const nodes = sanitizeEmailHtml("<p>a</p><style>p{color:red}");
    expect(text(nodes)).toBe("a");
    expect(dump(nodes)).not.toContain("color:red");
  });

  it("keeps no style attribute, so no message-authored CSS exists at all", () => {
    const nodes = sanitizeEmailHtml(
      '<div style="position:fixed;inset:0;z-index:99999;background:#000">overlay</div>',
    );
    expect(text(nodes)).toBe("overlay");
    expect(dump(nodes)).not.toContain("z-index");
    expect(dump(nodes)).not.toContain("inset");
  });
});

describe("links", () => {
  it("keeps an http, https or mailto link", () => {
    for (const href of ["http://a.example/x", "https://a.example/x", "mailto:sender@example.com"]) {
      const [link] = links(sanitizeEmailHtml(`<a href="${href}">go</a>`));
      expect(link.href).toBe(href);
    }
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])("drops the href but keeps the words for %s", (href) => {
    const nodes = sanitizeEmailHtml(`<a href="${href}">click me</a>`);
    expect(links(nodes)[0].href).toBeUndefined();
    expect(text(nodes)).toBe("click me");
  });

  it("rejects a relative or scheme-relative href, which has nothing to resolve against", () => {
    expect(isSafeHref("/inbox")).toBe(false);
    expect(isSafeHref("//evil.example/x")).toBe(false);
  });
});

describe("remote images are blocked by default", () => {
  it("keeps only the host of a remote image, never a usable src", () => {
    const nodes = sanitizeEmailHtml(
      '<img src="https://tracker.example/pixel.gif?id=abc123" alt="spacer">',
    );
    const [img] = images(nodes);
    expect(img.remoteHost).toBe("tracker.example");
    expect(img.src).toBeUndefined();
    expect(img.alt).toBe("spacer");
    // The tracking id must not survive anywhere in the payload the client gets:
    // a node the client cannot turn into a request cannot leak a read receipt.
    expect(dump(nodes)).not.toContain("abc123");
    expect(dump(nodes)).not.toContain("pixel.gif");
  });

  it("blocks http images as well as https", () => {
    const [img] = images(sanitizeEmailHtml('<img src="http://tracker.example/p.gif">'));
    expect(img.remoteHost).toBe("tracker.example");
    expect(img.src).toBeUndefined();
  });

  it("renders a data: image, which is already in the message and leaks nothing", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    const [img] = images(sanitizeEmailHtml(`<img src="${src}" alt="logo">`));
    expect(img.src).toBe(src);
    expect(img.remoteHost).toBeUndefined();
  });

  it("refuses a data: URI that is not an image type", () => {
    expect(blockRemoteImages("data:text/html;base64,PHNjcmlwdD4=")).toEqual({});
    expect(images(sanitizeEmailHtml('<img src="data:text/html,<script>alert(1)</script>">'))).toHaveLength(0);
  });

  it("drops an image whose src is a script URL rather than showing it", () => {
    expect(images(sanitizeEmailHtml('<img src="javascript:alert(1)">'))).toHaveLength(0);
  });

  it("drops an unresolved cid: reference, which names a part the message did not carry", () => {
    expect(images(sanitizeEmailHtml('<img src="cid:missing@example">'))).toHaveLength(0);
  });

  it("lets the caller resolve images, which is how consent is expressed", () => {
    // The "owner asked for images" path is the same walk with a different
    // resolver — not a second parser with its own escaping rules.
    const nodes = sanitizeEmailHtml('<img src="https://cdn.example/a.png">', () => ({
      src: "data:image/png;base64,AAAA",
    }));
    expect(images(nodes)[0].src).toBe("data:image/png;base64,AAAA");
    expect(images(nodes)[0].remoteHost).toBeUndefined();
  });
});

describe("structure worth keeping", () => {
  it("keeps paragraphs, emphasis, lists, quotes and headings", () => {
    const nodes = sanitizeEmailHtml(
      "<h2>Title</h2><p>Hello <strong>there</strong></p><ul><li>one</li><li>two</li></ul><blockquote>quoted</blockquote>",
    );
    expect(tags(nodes)).toEqual(["h2", "p", "strong", "ul", "li", "li", "blockquote"]);
    expect(text(nodes)).toContain("Hello there");
  });

  it("keeps a table, which is how a great deal of mail is laid out", () => {
    const nodes = sanitizeEmailHtml("<table><tr><td>a</td><td>b</td></tr></table>");
    expect(tags(nodes)).toEqual(["table", "tr", "td", "td"]);
  });

  it("keeps the words of an element it does not model", () => {
    expect(text(sanitizeEmailHtml("<font color=red><center>kept</center></font>"))).toBe("kept");
  });

  it("decodes entities on emitted text only, so &lt;script&gt; stays text", () => {
    const nodes = sanitizeEmailHtml("<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
    expect(text(nodes)).toBe("<script>alert(1)</script>");
    expect(tags(nodes)).toEqual(["p"]);
  });

  it("ignores a closing tag that never opened, instead of unwinding the tree", () => {
    const nodes = sanitizeEmailHtml("<p>a</b></div>b</p>");
    expect(text(nodes)).toBe("ab");
  });
});

describe("bounds on a body a stranger wrote", () => {
  it("survives deeply nested markup without unbounded nesting", () => {
    const depth = 500;
    const nodes = sanitizeEmailHtml("<div>".repeat(depth) + "deep" + "</div>".repeat(depth));
    // The words still arrive; only the nesting stops growing.
    expect(text(nodes)).toContain("deep");
    // Deepest ELEMENT nesting, counting a top-level element as level 1. The cap
    // is what bounds recursion in the renderer on the far side.
    let max = 0;
    const walk = (list: EmailNode[], level: number): void => {
      for (const node of list) {
        if (node.type !== "element") continue;
        max = Math.max(max, level);
        walk(node.children, level + 1);
      }
    };
    walk(nodes, 1);
    expect(max).toBeLessThanOrEqual(24);
    expect(max).toBeGreaterThan(1);
  });

  it("stops building nodes for an absurdly long body", () => {
    const nodes = sanitizeEmailHtml("<p>x</p>".repeat(50_000));
    expect(nodes.length).toBeLessThanOrEqual(12_000);
  });

  it("returns an empty tree for an empty body rather than throwing", () => {
    expect(sanitizeEmailHtml("")).toEqual([]);
  });
});

describe("plain text bodies", () => {
  it("keeps paragraphs and single line breaks as structure", () => {
    const nodes = emailTextToNodes("Line one\nLine two\n\nSecond para");
    expect(tags(nodes)).toEqual(["p", "br", "p"]);
    expect(text(nodes)).toBe("Line oneLine twoSecond para");
  });

  it("linkifies a bare URL", () => {
    const [link] = links(emailTextToNodes("See https://example.com/docs for more"));
    expect(link.href).toBe("https://example.com/docs");
  });

  it("leaves trailing sentence punctuation outside the link", () => {
    const [link] = links(emailTextToNodes("Go to https://example.com/x."));
    expect(link.href).toBe("https://example.com/x");
    expect(text(emailTextToNodes("Go to https://example.com/x."))).toContain(".");
  });

  it("does not turn a plain-text body into markup", () => {
    // A text/plain part saying "<script>" is a person typing about scripts.
    const nodes = emailTextToNodes("<script>alert(1)</script>");
    expect(tags(nodes)).toEqual(["p"]);
    expect(text(nodes)).toBe("<script>alert(1)</script>");
  });

  it("drops blank blocks rather than rendering a column of empty lines", () => {
    expect(emailTextToNodes("\n\n\n  \n\n")).toEqual([]);
  });
});
