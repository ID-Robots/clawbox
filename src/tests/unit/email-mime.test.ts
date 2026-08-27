// The full view's parser. Every fixture here is invented mail addressed to
// obviously-fake people — this repository is public and no real mailbox
// contributes to its tests.

import { describe, expect, it } from "vitest";
import {
  buildFullMessage,
  parseAddress,
  parseAddressList,
  remoteImageUrls,
  type FullMessage,
} from "@/lib/email-mime";
import type { EmailImageNode, EmailNode } from "@/lib/email-html";

const CRLF = "\r\n";

/** Join lines with CRLF, the line ending a real message uses. */
const mail = (...lines: string[]): string => lines.join(CRLF);

const META = { uid: 7, unread: true, internalDate: "Mon, 5 May 2025 10:00:00 +0000", truncated: false };

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

const build = (raw: string, resolve?: (url: string) => string | undefined): FullMessage =>
  buildFullMessage(raw, META, resolve);

// A 1×1 PNG, as a real message would carry it.
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("header block", () => {
  it("splits a display name from the address", () => {
    expect(parseAddress("Jane Doe <jane@example.com>")).toEqual({
      name: "Jane Doe",
      address: "jane@example.com",
    });
  });

  it("keeps a bare address as the address, not as a name", () => {
    expect(parseAddress("sender@example.com")).toEqual({ name: "", address: "sender@example.com" });
  });

  it("unquotes a quoted display name", () => {
    expect(parseAddress('"Doe, Jane" <jane@example.com>').name).toBe("Doe, Jane");
  });

  it("does not split a recipient list on a comma inside a quoted name", () => {
    const list = parseAddressList('"Doe, Jane" <jane@example.com>, bob@example.com');
    expect(list).toHaveLength(2);
    expect(list[0].address).toBe("jane@example.com");
    expect(list[1].address).toBe("bob@example.com");
  });

  it("decodes an RFC 2047 encoded display name", () => {
    // "Здравей" as a base64 encoded word — the case that used to come out as
    // gibberish elsewhere in this client.
    const parsed = parseAddress("=?utf-8?B?0JfQtNGA0LDQstC10Lk=?= <hi@example.com>");
    expect(parsed.name).toBe("Здравей");
  });

  it("returns an empty list for an absent header rather than a phantom recipient", () => {
    expect(parseAddressList("")).toEqual([]);
  });

  it("carries the parsed header block through to the full message", () => {
    const message = build(
      mail(
        "From: Jane Doe <jane@example.com>",
        "To: Owner <owner@example.com>, Second <second@example.com>",
        "Cc: cc@example.com",
        "Subject: Quarterly update",
        "Date: Mon, 5 May 2025 09:30:00 +0000",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Body text.",
      ),
    );
    expect(message.from).toEqual({ name: "Jane Doe", address: "jane@example.com" });
    expect(message.to.map((a) => a.address)).toEqual(["owner@example.com", "second@example.com"]);
    expect(message.cc.map((a) => a.address)).toEqual(["cc@example.com"]);
    expect(message.subject).toBe("Quarterly update");
    expect(message.date).toBe("Mon, 5 May 2025 09:30:00 +0000");
    expect(message.uid).toBe(7);
    expect(message.unread).toBe(true);
  });

  it("falls back to the server's own date when the message carried none", () => {
    const message = build(mail("From: a@example.com", "Subject: No date", "", "hi"));
    expect(message.date).toBe(META.internalDate);
  });
});

describe("plain-text mail", () => {
  it("keeps paragraphs and line breaks as structure", () => {
    const message = build(
      mail(
        "From: Jane Doe <jane@example.com>",
        "Subject: Notes",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "First line",
        "Second line",
        "",
        "New paragraph",
      ),
    );
    expect(message.format).toBe("text");
    expect(tags(message.body)).toEqual(["p", "br", "p"]);
    expect(text(message.body)).toContain("First line");
    expect(text(message.body)).toContain("New paragraph");
  });

  it("linkifies a bare URL in plain text", () => {
    const message = build(
      mail("From: a@example.com", "Content-Type: text/plain", "", "See https://example.com/docs"),
    );
    expect(tags(message.body)).toContain("a");
  });

  it("reads a body written in a language that needs more than ASCII", () => {
    const message = build(
      mail(
        "From: a@example.com",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from("Здравей, свят", "utf8").toString("base64"),
      ),
    );
    expect(text(message.body)).toContain("Здравей, свят");
  });

  it("does not turn a plain-text body into markup", () => {
    const message = build(
      mail("From: a@example.com", "Content-Type: text/plain", "", "<script>alert(1)</script>"),
    );
    expect(tags(message.body)).toEqual(["p"]);
    expect(text(message.body)).toBe("<script>alert(1)</script>");
  });
});

describe("HTML mail", () => {
  it("keeps the structure instead of flattening it to text", () => {
    const message = build(
      mail(
        "From: Jane Doe <jane@example.com>",
        "Subject: Newsletter",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<h1>Heading</h1><p>Hello <strong>there</strong></p><ul><li>one</li></ul>",
      ),
    );
    expect(message.format).toBe("html");
    expect(tags(message.body)).toEqual(["h1", "p", "strong", "ul", "li"]);
  });

  it("sanitises the HTML part — a script in real mail does not survive", () => {
    const message = build(
      mail(
        "From: a@example.com",
        "Content-Type: text/html",
        "",
        '<p>hi</p><script>fetch("https://evil.example")</script><style>body{display:none}</style>',
      ),
    );
    expect(JSON.stringify(message.body)).not.toContain("evil.example");
    expect(JSON.stringify(message.body)).not.toContain("display:none");
    expect(text(message.body)).toBe("hi");
  });

  it("prefers the HTML part of a multipart/alternative, which is the real thing", () => {
    // The opposite of the agent's summary path, and deliberately so: the plain
    // part of an alternative is the sender's lossy fallback.
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "plain fallback",
        "--b1",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>rich <em>version</em></p>",
        "--b1--",
      ),
    );
    expect(message.format).toBe("html");
    expect(text(message.body)).toContain("rich version");
    expect(text(message.body)).not.toContain("plain fallback");
  });

  it("falls back to the plain part when there is no HTML one", () => {
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "only plain",
        "--b1--",
      ),
    );
    expect(message.format).toBe("text");
    expect(text(message.body)).toContain("only plain");
  });

  it("decodes a quoted-printable HTML part", () => {
    const message = build(
      mail(
        "From: a@example.com",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "<p>caf=C3=A9</p>",
      ),
    );
    expect(text(message.body)).toBe("café");
  });
});

describe("remote images are blocked until asked for", () => {
  const withTracker = mail(
    "From: Sender <sender@example.com>",
    "Subject: Newsletter",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Hello</p><img src="https://tracker.example/open.gif?u=secret-token" alt="">',
  );

  it("blocks a tracking pixel by default and counts it", () => {
    const message = build(withTracker);
    expect(message.blockedImages).toBe(1);
    const [img] = images(message.body);
    expect(img.src).toBeUndefined();
    expect(img.remoteHost).toBe("tracker.example");
  });

  it("never puts the tracking URL in the payload, so nothing can request it by accident", () => {
    const message = build(withTracker);
    expect(JSON.stringify(message)).not.toContain("secret-token");
    expect(JSON.stringify(message)).not.toContain("open.gif");
  });

  it("shows the image once the owner has asked, and stops counting it as blocked", () => {
    const message = build(withTracker, () => `data:image/png;base64,${PNG_B64}`);
    expect(message.blockedImages).toBe(0);
    expect(images(message.body)[0].src).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it("leaves an image blocked when the fetch did not produce one", () => {
    // A tracker that refused, timed out, or resolved to a LAN address.
    const message = build(withTracker, () => undefined);
    expect(message.blockedImages).toBe(1);
    expect(images(message.body)[0].src).toBeUndefined();
  });

  it("lists the remote URLs for the consent path, taken from the message itself", () => {
    expect(remoteImageUrls(withTracker)).toEqual(["https://tracker.example/open.gif?u=secret-token"]);
  });

  it("finds no remote URLs in a plain-text message", () => {
    expect(remoteImageUrls(mail("From: a@example.com", "Content-Type: text/plain", "", "hi"))).toEqual([]);
  });
});

describe("images the message carried itself", () => {
  const withInline = mail(
    "From: Sender <sender@example.com>",
    'Content-Type: multipart/related; boundary="rel"',
    "",
    "--rel",
    "Content-Type: text/html; charset=utf-8",
    "",
    '<p>Signature</p><img src="cid:logo@example" alt="Logo">',
    "--rel",
    "Content-Type: image/png",
    "Content-Transfer-Encoding: base64",
    "Content-ID: <logo@example>",
    "Content-Disposition: inline; filename=\"logo.png\"",
    "",
    PNG_B64,
    "--rel--",
  );

  it("renders a cid: image from the message's own bytes, with no network call", () => {
    const message = build(withInline);
    const [img] = images(message.body);
    expect(img.src).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(img.alt).toBe("Logo");
  });

  it("does not count an inline image as blocked — there is nothing to consent to", () => {
    expect(build(withInline).blockedImages).toBe(0);
  });

  it("drops a cid: reference that names no part in the message", () => {
    const message = build(
      mail(
        "From: a@example.com",
        "Content-Type: text/html",
        "",
        '<img src="cid:missing@example" alt="gone">',
      ),
    );
    expect(images(message.body)).toHaveLength(0);
    expect(message.blockedImages).toBe(0);
  });

  it("refuses to inline an SVG part, which is a scriptable document", () => {
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/related; boundary="rel"',
        "",
        "--rel",
        "Content-Type: text/html",
        "",
        '<img src="cid:s@example">',
        "--rel",
        "Content-Type: image/svg+xml",
        "Content-ID: <s@example>",
        "",
        "<svg onload=\"alert(1)\"></svg>",
        "--rel--",
      ),
    );
    expect(images(message.body)).toHaveLength(0);
    expect(JSON.stringify(message)).not.toContain("alert(1)");
  });
});

describe("attachments", () => {
  const withAttachment = mail(
    "From: Sender <sender@example.com>",
    "Subject: Invoice",
    'Content-Type: multipart/mixed; boundary="mix"',
    "",
    "--mix",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "See attached.",
    "--mix",
    "Content-Type: application/pdf; name=\"invoice.pdf\"",
    "Content-Transfer-Encoding: base64",
    "Content-Disposition: attachment; filename=\"invoice.pdf\"",
    "",
    Buffer.from("x".repeat(300), "utf8").toString("base64"),
    "--mix--",
  );

  it("lists an attachment by name, type and size", () => {
    const [file] = build(withAttachment).attachments;
    expect(file.filename).toBe("invoice.pdf");
    expect(file.contentType).toBe("application/pdf");
    expect(file.size).toBe(300);
  });

  it("keeps the body readable alongside the attachment", () => {
    expect(text(build(withAttachment).body)).toContain("See attached.");
  });

  it("decodes an RFC 2231 encoded filename", () => {
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        "Content-Type: text/plain",
        "",
        "hi",
        "--mix",
        "Content-Type: application/pdf",
        "Content-Disposition: attachment; filename*=utf-8''report%20final.pdf",
        "",
        "data",
        "--mix--",
      ),
    );
    expect(message.attachments[0].filename).toBe("report final.pdf");
  });

  it("names an attachment that carried no filename rather than dropping it", () => {
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/mixed; boundary="mix"',
        "",
        "--mix",
        "Content-Type: text/plain",
        "",
        "hi",
        "--mix",
        "Content-Type: application/octet-stream",
        "Content-Disposition: attachment",
        "",
        "data",
        "--mix--",
      ),
    );
    expect(message.attachments[0].filename).toBe("(unnamed)");
  });

  it("does not list the body parts as attachments", () => {
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/alternative; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain",
        "",
        "plain",
        "--b1",
        "Content-Type: text/html",
        "",
        "<p>html</p>",
        "--b1--",
      ),
    );
    expect(message.attachments).toEqual([]);
  });
});

describe("messages that are not well formed", () => {
  it("says a message was cut short rather than presenting it as whole", () => {
    const message = buildFullMessage(
      mail("From: a@example.com", "Content-Type: text/html", "", "<p>start of a long"),
      { ...META, truncated: true },
    );
    expect(message.truncated).toBe(true);
  });

  it("survives a message with no body at all", () => {
    const message = build("From: a@example.com\r\nSubject: Empty\r\n\r\n");
    expect(message.body).toEqual([]);
    expect(message.subject).toBe("Empty");
  });

  it("survives a multipart with a boundary that never appears", () => {
    const message = build(
      mail("From: a@example.com", 'Content-Type: multipart/mixed; boundary="nope"', "", "orphan text"),
    );
    expect(message.format).toBe("text");
    expect(message.body).toEqual([]);
  });

  it("survives deeply nested multiparts without running away", () => {
    let body = "deepest";
    for (let i = 0; i < 40; i++) {
      body = mail(
        `Content-Type: multipart/mixed; boundary="b${i}"`,
        "",
        `--b${i}`,
        "Content-Type: text/plain",
        "",
        body,
        `--b${i}--`,
      );
    }
    expect(() => build(`From: a@example.com\r\n${body}`)).not.toThrow();
  });

  it("keeps the first From, so a second one cannot overwrite it", () => {
    const message = build(
      mail("From: real@example.com", "From: spoof@example.com", "Subject: s", "", "hi"),
    );
    expect(message.from.address).toBe("real@example.com");
  });
});

describe("header parameters are matched by name, not by suffix (CodeRabbit #499)", () => {
  it("splits on the real boundary when another parameter ends in the same word", () => {
    // `xboundary` must not answer a request for `boundary`: splitting on the
    // wrong string finds no parts and renders the message as empty.
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/mixed; xboundary="AAA"; boundary="BBB"',
        "",
        "--BBB",
        "Content-Type: text/plain",
        "",
        "the real body",
        "--BBB--",
      ),
    );
    expect(text(message.body)).toContain("the real body");
  });

  it("does not let `filename` answer a request for `name`", () => {
    // A text part carrying a filename parameter is still the body, not an
    // attachment, and must not be listed as one.
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: text/plain; charset=utf-8; filename="notes.txt"',
        "",
        "just the body",
      ),
    );
    expect(text(message.body)).toContain("just the body");
    // The claim in the name: if `name` started answering for `filename`, this
    // text part would be read as an attachment, and the body could still be
    // there — so the body assertion alone would not have caught it.
    expect(message.attachments).toEqual([]);
  });

  it("still reads a parameter that genuinely is the first one", () => {
    const message = build(
      mail(
        "From: a@example.com",
        'Content-Type: multipart/mixed; boundary="B1"',
        "",
        "--B1",
        "Content-Type: text/plain",
        "",
        "body",
        "--B1",
        'Content-Type: application/pdf; name="report.pdf"',
        "Content-Disposition: attachment",
        "",
        "data",
        "--B1--",
      ),
    );
    expect(message.attachments[0].filename).toBe("report.pdf");
  });
});
