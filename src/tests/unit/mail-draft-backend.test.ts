// The mail send backend as ClawBox reads it: what a draft is normalised to,
// what its content hash covers, what a card shows, and how every answer the
// backend can give is read — including the ones that must never be reported as
// "not sent".

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalJson,
  cleanBody,
  cleanLine,
  draftContentHash,
  draftView,
  fetchDraft,
  hasInvisible,
  htmlToText,
  isDraftId,
  normalizeDraft,
  probeBackend,
  sendDraft,
  BACKEND_MAX_BYTES,
  MAX_PREVIEW_CHARS,
} from "@/lib/mail-draft-backend";
import {
  isLoopbackHost,
  parseBackendEndpoint,
  parseDraftApprovalUpdate,
  isValidAuthHeaderName,
  isValidAuthHeaderValue,
  publicDraftApprovalConfig,
  type DraftApprovalConfig,
} from "@/lib/mail-draft-approval-config";

const CONFIG: DraftApprovalConfig = {
  enabled: true,
  endpoint: "http://127.0.0.1:8790/api",
  authHeader: "X-Api-Key",
  authValue: "k-placeholder",
};

/** A backend's answer for one draft, as raw JSON. */
const BASE: Record<string, unknown> = {
  id: "d1",
  to: ["ivan@example.com"],
  cc: [],
  bcc: [],
  subject: "Hello",
  bodyType: "text",
  body: "Body",
  attachments: [],
};

function draftOf(raw: Record<string, unknown>) {
  const draft = normalizeDraft(raw, String(raw.id));
  if (!draft) throw new Error("not a draft");
  return draft;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeDraft", () => {
  it("reads the simple shape", () => {
    expect(
      normalizeDraft(
        {
          id: "d1",
          to: ["Ivan Ivanov <ivan@example.com>", { address: "ops@example.com", name: "Ops" }],
          cc: "a@example.com; b@example.com",
          subject: "Offer",
          body: "Hi",
          attachments: [{ name: "offer.pdf", size: 2048 }],
        },
        "d1",
      ),
    ).toEqual({
      id: "d1",
      from: null,
      to: ["Ivan Ivanov <ivan@example.com>", "Ops <ops@example.com>"],
      cc: ["a@example.com", "b@example.com"],
      bcc: [],
      replyTo: [],
      subject: "Offer",
      bodyType: "text",
      body: "Hi",
      attachments: [{ name: "offer.pdf", size: 2048 }],
      hash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("reads a Microsoft Graph message passed straight through", () => {
    const draft = normalizeDraft(
      {
        id: "AAMk=",
        subject: "Q4",
        toRecipients: [{ emailAddress: { name: "Acme Buyer", address: "buyer@acme.example" } }],
        ccRecipients: [],
        bccRecipients: [{ emailAddress: { address: "hidden@example.net" } }],
        from: { emailAddress: { name: "Owner", address: "owner@acme.example" } },
        replyTo: [{ emailAddress: { address: "replies@acme.example" } }],
        body: { contentType: "HTML", content: "<p>Hi <b>there</b></p>" },
      },
      "AAMk=",
    );
    expect(draft).toMatchObject({
      from: "Owner <owner@acme.example>",
      to: ["Acme Buyer <buyer@acme.example>"],
      bcc: ["hidden@example.net"],
      replyTo: ["replies@acme.example"],
      bodyType: "html",
      body: "<p>Hi <b>there</b></p>",
    });
  });

  it("refuses an answer about another draft, or one it cannot read whole", () => {
    expect(normalizeDraft({ id: "other", to: [], subject: "", body: "" }, "d1")).toBeNull();
    expect(normalizeDraft({ to: [42], subject: "", body: "" }, "d1")).toBeNull();
    expect(normalizeDraft({ to: [], subject: 5, body: "" }, "d1")).toBeNull();
    expect(normalizeDraft({ to: [], body: { content: 5 } }, "d1")).toBeNull();
    expect(normalizeDraft({ to: [], body: "", attachments: [{ size: 1 }] }, "d1")).toBeNull();
    expect(normalizeDraft({ to: [], body: "", from: 7 }, "d1")).toBeNull();
    expect(normalizeDraft({ to: [], body: "", replyTo: [null] }, "d1")).toBeNull();
    expect(normalizeDraft("nope", "d1")).toBeNull();
    expect(normalizeDraft([], "d1")).toBeNull();
  });
});

describe("draftContentHash", () => {
  it("covers the backend's whole answer, whatever order it lists the fields in", () => {
    const base = draftContentHash(BASE);
    expect(draftContentHash({ ...BASE })).toBe(base);
    const reversed = Object.fromEntries(Object.entries(BASE).reverse());
    expect(draftContentHash(reversed)).toBe(base);
    expect(draftOf(BASE).hash).toBe(base);
    for (const changed of [
      { ...BASE, to: ["ivan@example.com", "x@example.net"] },
      { ...BASE, cc: ["x@example.net"] },
      { ...BASE, bcc: ["x@example.net"] },
      { ...BASE, subject: "Hello!" },
      { ...BASE, body: "Body." },
      { ...BASE, bodyType: "html" },
      { ...BASE, attachments: [{ name: "a.pdf", size: 1 }] },
      // What no card field shows but the mail carries: still bound.
      { ...BASE, replyTo: ["attacker@example.net"] },
      { ...BASE, from: "someone-else@example.net" },
      { ...BASE, internetMessageHeaders: [{ name: "X-Redirect", value: "1" }] },
      { ...BASE, id: "d2" },
    ]) {
      expect(draftContentHash(changed)).not.toBe(base);
    }
    expect(draftContentHash({ ...BASE, attachments: [{ name: "a.pdf", size: 1, sha256: "11" }] }))
      .not.toBe(draftContentHash({ ...BASE, attachments: [{ name: "a.pdf", size: 1, sha256: "22" }] }));
  });

  it("is sha256 over a prefix and the canonical JSON, as the docs say", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: "x" }] })).toBe('{"a":[{"c":"x","d":2}],"b":1}');
  });
});

describe("what a card shows", () => {
  it("shows where a link goes, not only its words", () => {
    const text = htmlToText('<p><a href="https://evil.example/pay">Open invoice</a> or <a href="https://acme.example">https://acme.example</a></p>');
    expect(text).toContain("Open invoice <https://evil.example/pay>");
    expect(text).not.toContain("https://acme.example <");
  });

  it("turns an HTML body into its words, scripts and markup gone", () => {
    const text = htmlToText("<div>Hello<br>World</div><script>alert(1)</script><ul><li>one</li><li>two</li></ul><img alt=\"logo\" src=\"x\">");
    expect(text).toContain("Hello\nWorld");
    expect(text).toContain("• one");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<");
  });

  it("shows, rather than hides, what would make a line read differently from what is sent", () => {
    expect(cleanLine("Pay\u202egnp.exe\u0007\r\nnow", 100)).toBe("Pay[U+202E]gnp.exe[U+0007] now");
    expect(cleanBody("a\r\nb\u2028c\u200bd\ufeff")).toBe("a\nb\nc[U+200B]d[U+FEFF]");
    expect(draftView(draftOf({ ...BASE, subject: "Invoice \u202efdp.exe" }))).toMatchObject({
      subject: "Invoice [U+202E]fdp.exe",
      hiddenCharacters: true,
    });
    expect(draftView(draftOf({ ...BASE, to: ["a\u202e@example.com"] })).hiddenCharacters).toBe(true);
    expect(draftView(draftOf(BASE)).hiddenCharacters).toBe(false);
  });

  it("marks every format and default-ignorable character, astral ones by their real code point", () => {
    for (const [ch, shown] of [
      ["\u00ad", "[U+00AD]"], // soft hyphen
      ["\u034f", "[U+034F]"], // combining grapheme joiner
      ["\u061c", "[U+061C]"], // Arabic letter mark
      ["\u115f", "[U+115F]"], // Hangul choseong filler
      ["\u180e", "[U+180E]"], // Mongolian vowel separator
      ["\u200b", "[U+200B]"], // zero-width space
      ["\u200c", "[U+200C]"], // zero-width non-joiner
      ["\u200d", "[U+200D]"], // zero-width joiner, between two letters
      ["\u200e", "[U+200E]"], // left-to-right mark
      ["\u2060", "[U+2060]"], // word joiner
      ["\u2064", "[U+2064]"], // invisible plus
      ["\u206f", "[U+206F]"], // nominal digit shapes
      ["\u3164", "[U+3164]"], // Hangul filler
      ["\ufe00", "[U+FE00]"], // variation selector 1
      ["\ufff9", "[U+FFF9]"], // interlinear annotation anchor
      ["\u{e0001}", "[U+E0001]"], // language tag
      ["\u{e0041}", "[U+E0041]"], // TAG LATIN CAPITAL LETTER A
      ["\u{e007f}", "[U+E007F]"], // cancel tag
      ["\u{e0100}", "[U+E0100]"], // variation selector 17
    ] as const) {
      expect(cleanBody(`a${ch}b`), shown).toBe(`a${shown}b`);
      expect(cleanLine(`a${ch}b`, 100), shown).toBe(`a${shown}b`);
      expect(hasInvisible(`a${ch}b`), shown).toBe(true);
      expect(draftView(draftOf({ ...BASE, body: `a${ch}b` })).hiddenCharacters, shown).toBe(true);
    }
    // ASCII smuggled in tag characters: every one of them shown.
    expect(cleanBody("Thanks!\u{e0070}\u{e0077}\u{e0064}\u{e007f}")).toBe("Thanks![U+E0070][U+E0077][U+E0064][U+E007F]");
  });

  it("leaves a standard emoji alone, and marks what is glued to one", () => {
    for (const emoji of [
      "\u{1f469}\u200d\u{1f4bb}", // woman technologist: ZWJ
      "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", // family
      "\u2764\ufe0f", // red heart: VS16
      "\u{1f3f3}\ufe0f\u200d\u{1f308}", // rainbow flag
      "\u{1f3c3}\u{1f3fd}\u200d\u2640\ufe0f", // runner, skin tone, female sign
      "1\ufe0f\u20e3", // keycap 1
      "\u{1f44d}\u{1f3fd}", // thumbs up, skin tone
      "\u{1f1e7}\u{1f1ec}", // a country flag
      "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}", // Scotland
    ]) {
      expect(cleanBody(`Thanks ${emoji}`), emoji).toBe(`Thanks ${emoji}`);
      expect(hasInvisible(`Thanks ${emoji}`), emoji).toBe(false);
      expect(draftView(draftOf({ ...BASE, body: `Thanks ${emoji}` })).hiddenCharacters, emoji).toBe(false);
    }
    for (const [text, shown] of [
      // Tags after an emoji that is not one of the three subdivision flags.
      ["\u{1f44d}\u{e0041}\u{e007f}", "\u{1f44d}[U+E0041][U+E007F]"],
      ["\u{1f3f4}\u{e0041}\u{e007f}", "\u{1f3f4}[U+E0041][U+E007F]"],
      // A joiner with nothing to join.
      ["\u{1f44d}\u200d", "\u{1f44d}[U+200D]"],
      ["\u200d\u{1f44d}", "[U+200D]\u{1f44d}"],
      // One VS16 belongs to the emoji; a second is hidden.
      ["\u{1f44d}\ufe0f\ufe0f", "\u{1f44d}\ufe0f[U+FE0F]"],
      // A plain digit with a VS16 and no keycap: a bit hidden in a number.
      ["Total 1\ufe0f2", "Total 1[U+FE0F]2"],
      // A text-style selector is not left alone either.
      ["\u2764\ufe0e", "\u2764[U+FE0E]"],
    ] as const) {
      expect(cleanBody(text), text).toBe(shown);
      expect(hasInvisible(text), text).toBe(true);
    }
  });

  it("never shows part of a recipient: one too long to show whole makes the draft unreadable", () => {
    const long = `${"a".repeat(400)}@evil.example`;
    expect(normalizeDraft({ ...BASE, to: [long] }, "d1")).toBeNull();
    expect(normalizeDraft({ ...BASE, to: `ivan@example.com, ${long}` }, "d1")).toBeNull();
    expect(normalizeDraft({ ...BASE, cc: [{ address: long }] }, "d1")).toBeNull();
    expect(normalizeDraft({ ...BASE, bcc: [{ emailAddress: { address: "ivan@example.com", name: "x".repeat(401) } }] }, "d1")).toBeNull();
    expect(normalizeDraft({ ...BASE, from: long }, "d1")).toBeNull();
    // Right at the cap is still shown whole.
    expect(draftOf({ ...BASE, to: ["a".repeat(400)] }).to).toEqual(["a".repeat(400)]);
  });

  it("offers no Send when the subject or an attachment name had to be cut", () => {
    expect(draftView(draftOf(BASE)).headerTruncated).toBe(false);
    const subject = draftView(draftOf({ ...BASE, subject: "s".repeat(1001) }));
    expect(subject.subject.endsWith("…")).toBe(true);
    expect(subject.headerTruncated).toBe(true);
    expect(draftView(draftOf({ ...BASE, subject: "s".repeat(1000) })).headerTruncated).toBe(false);
    const file = draftView(draftOf({ ...BASE, attachments: [{ name: `${"n".repeat(201)}.pdf`, size: 1 }] }));
    expect(file.attachments[0].name.endsWith("…")).toBe(true);
    expect(file.headerTruncated).toBe(true);
    expect(draftView(draftOf({ ...BASE, attachments: [{ name: "n".repeat(200), size: 1 }] })).headerTruncated).toBe(false);
  });

  it("shows the whole body of anything the backend can send, and says when it could not", () => {
    const big = draftView(draftOf({ ...BASE, body: "x".repeat(900_000) }));
    expect(big.bodyTruncated).toBe(false);
    expect(big.body).toHaveLength(900_000);
    const huge = draftView({ ...draftOf(BASE), body: "x".repeat(MAX_PREVIEW_CHARS + 50) });
    expect(huge.body).toHaveLength(MAX_PREVIEW_CHARS);
    expect(huge.bodyTruncated).toBe(true);
  });

  it("offers no Send when the HTML sanitiser had to drop part of the body", () => {
    // One run of text past the sanitiser's ceiling: the words that come out are
    // far under the preview cap, so only the sanitiser can say it was cut.
    const oneLongRun = draftView(draftOf({ ...BASE, bodyType: "html", body: `<p>${"x".repeat(100_000)}</p>` }));
    expect(oneLongRun.body.length).toBeLessThan(MAX_PREVIEW_CHARS);
    expect(oneLongRun.bodyTruncated).toBe(true);
    // The node ceiling, reached by absurd nesting of tables, says the same.
    const manyNodes = draftView(draftOf({ ...BASE, bodyType: "html", body: "<p>a</p>".repeat(20_000) }));
    expect(manyNodes.bodyTruncated).toBe(true);
    // An ordinary HTML body is shown whole and stays sendable.
    const ordinary = draftView(draftOf({ ...BASE, bodyType: "html", body: "<p>Hello Ivan,</p><p>the offer is attached.</p>" }));
    expect(ordinary.body).toBe("Hello Ivan,\n\nthe offer is attached.");
    expect(ordinary.bodyTruncated).toBe(false);
  });
});

describe("an answer too deep to hash", () => {
  function nested(depth: number, leaf: unknown): unknown {
    let value: unknown = leaf;
    for (let i = 0; i < depth; i += 1) value = { deeper: value };
    return value;
  }

  it("is refused, rather than hashed as if the depths were all null", () => {
    // Two answers that differ only past the limit used to hash alike, so a
    // Send bound to one would have accepted the other.
    expect(normalizeDraft({ ...BASE, extra: nested(65, "a") }, "d1")).toBeNull();
    expect(normalizeDraft({ ...BASE, extra: nested(65, "b") }, "d1")).toBeNull();
    expect(() => canonicalJson(nested(65, "a"))).toThrow();
  });

  it("leaves every answer a mailbox really gives alone, key order and all", () => {
    const deep = { ...BASE, extra: nested(60, { a: 1, b: 2 }) };
    expect(draftOf(deep).hash).toBe(draftContentHash(deep));
    const reversed = Object.fromEntries(Object.entries(deep).reverse());
    expect(draftContentHash(reversed)).toBe(draftContentHash(deep));
    expect(draftContentHash({ ...deep, extra: nested(60, { a: 1, b: 3 }) })).not.toBe(draftContentHash(deep));
  });
});

describe("draft ids", () => {
  it("accepts real ids and nothing that would change a URL", () => {
    for (const id of ["AAMkAGI2THVSAAA=", "r-123_4.5", "abc@mail.example", "imap:42", "a/b+c=="]) {
      expect(isDraftId(id), id).toBe(true);
    }
    for (const id of ["", "a b", "x?y=1", "x#y", "x\ny", "\"x\"", "a".repeat(513), ".", "..", "..."]) {
      expect(isDraftId(id), id).toBe(false);
    }
  });
});

describe("talking to the backend", () => {
  function stub(status: number, body: unknown, check?: (url: string, init: RequestInit) => void) {
    const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      check?.(String(input), init ?? {});
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }

  it("asks for the draft with the configured header, no redirects, the user named", async () => {
    const fn = stub(200, { id: "a/b", to: ["x@example.com"], subject: "S", body: "B" }, (url, init) => {
      expect(url).toBe("http://127.0.0.1:8790/api/drafts/a%2Fb?user=alice");
      expect(new Headers(init.headers).get("x-api-key")).toBe("k-placeholder");
      expect(init.redirect).toBe("manual");
      expect(init.method).toBe("GET");
    });
    const result = await fetchDraft(CONFIG, "alice", "a/b");
    expect(result).toMatchObject({ ok: true, draft: { id: "a/b", subject: "S" } });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("reads each answer to a read", async () => {
    stub(404, {});
    expect(await fetchDraft(CONFIG, "u", "d")).toEqual({ ok: false, reason: "not_found" });
    stub(401, {});
    expect(await fetchDraft(CONFIG, "u", "d")).toEqual({ ok: false, reason: "auth" });
    stub(302, "");
    expect(await fetchDraft(CONFIG, "u", "d")).toEqual({ ok: false, reason: "bad_response" });
    stub(200, "not json");
    expect(await fetchDraft(CONFIG, "u", "d")).toEqual({ ok: false, reason: "bad_response" });
    stub(200, JSON.stringify({ body: "x".repeat(BACKEND_MAX_BYTES + 1) }));
    expect(await fetchDraft(CONFIG, "u", "d")).toEqual({ ok: false, reason: "bad_response" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await fetchDraft(CONFIG, "u", "d")).toEqual({ ok: false, reason: "unreachable" });
  });

  it("sends with the hash, and never calls a lost answer 'not sent'", async () => {
    stub(202, "", (url, init) => {
      expect(url).toBe("http://127.0.0.1:8790/api/drafts/d/send");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({ user: "u", draftId: "d", contentHash: "h" });
    });
    expect(await sendDraft(CONFIG, "u", "d", "h")).toEqual({ ok: true });
    stub(409, {});
    expect(await sendDraft(CONFIG, "u", "d", "h")).toEqual({ ok: false, reason: "changed" });
    stub(412, {});
    expect(await sendDraft(CONFIG, "u", "d", "h")).toEqual({ ok: false, reason: "changed" });
    stub(404, {});
    expect(await sendDraft(CONFIG, "u", "d", "h")).toEqual({ ok: false, reason: "not_found" });
    stub(403, {});
    expect(await sendDraft(CONFIG, "u", "d", "h")).toEqual({ ok: false, reason: "auth" });
    stub(422, {});
    expect(await sendDraft(CONFIG, "u", "d", "h")).toEqual({ ok: false, reason: "refused" });
    stub(500, {});
    expect(await sendDraft(CONFIG, "u", "d", "h")).toEqual({ ok: false, reason: "uncertain" });
    vi.stubGlobal("fetch", vi.fn(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }));
    expect(await sendDraft(CONFIG, "u", "d", "h")).toEqual({ ok: false, reason: "uncertain" });
  });

  it("probes with an id nobody has", async () => {
    stub(404, {}, (url) => expect(url).toMatch(/\/drafts\/clawbox-probe-[0-9a-f]{12}\?user=u$/));
    expect(await probeBackend(CONFIG, "u")).toBe("ok");
    stub(401, {});
    expect(await probeBackend(CONFIG, "u")).toBe("auth");
    stub(500, {});
    expect(await probeBackend(CONFIG, "u")).toBe("bad_response");
  });

  it("does not call anything without an endpoint", async () => {
    const fn = stub(200, {});
    expect(await fetchDraft({ ...CONFIG, endpoint: null }, "u", "d")).toEqual({ ok: false, reason: "unreachable" });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe("the backend's configuration", () => {
  it("accepts only this box", () => {
    expect(parseBackendEndpoint("http://127.0.0.1:8790/")).toEqual({ ok: true, endpoint: "http://127.0.0.1:8790" });
    expect(parseBackendEndpoint("https://localhost/mail/")).toEqual({ ok: true, endpoint: "https://localhost/mail" });
    expect(parseBackendEndpoint("http://[::1]:9000")).toEqual({ ok: true, endpoint: "http://[::1]:9000" });
    expect(parseBackendEndpoint("http://127.1:9000")).toEqual({ ok: true, endpoint: "http://127.0.0.1:9000" });
    expect(parseBackendEndpoint("http://198.51.100.5")).toEqual({ ok: false, reason: "not_loopback" });
    expect(parseBackendEndpoint("http://localhost.example.com")).toEqual({ ok: false, reason: "not_loopback" });
    expect(parseBackendEndpoint("http://a:b@127.0.0.1")).toEqual({ ok: false, reason: "credentials" });
    expect(parseBackendEndpoint("http://127.0.0.1/?a=1")).toEqual({ ok: false, reason: "query" });
    expect(parseBackendEndpoint("http://127.0.0.1/#x")).toEqual({ ok: false, reason: "query" });
    expect(parseBackendEndpoint("ftp://127.0.0.1")).toEqual({ ok: false, reason: "invalid" });
    expect(parseBackendEndpoint(42)).toEqual({ ok: false, reason: "invalid" });
    expect(isLoopbackHost("127.255.0.1")).toBe(true);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
  });

  it("refuses header names and values that would change the request", () => {
    expect(isValidAuthHeaderName("Authorization")).toBe(true);
    expect(isValidAuthHeaderName("X-Api-Key")).toBe(true);
    for (const bad of ["Host", "cookie", "Content-Type", "a b", "x:y", "", "x\r\ny"]) {
      expect(isValidAuthHeaderName(bad), bad).toBe(false);
    }
    expect(isValidAuthHeaderValue("Bearer abc.def")).toBe(true);
    for (const bad of ["", "   ", "a\r\nX-Evil: 1", "naïve", "x".repeat(5000)]) {
      expect(isValidAuthHeaderValue(bad), bad).toBe(false);
    }
  });

  it("reads an update field by field", () => {
    expect(parseDraftApprovalUpdate({ enabled: true, endpoint: "http://127.0.0.1:1/", authHeader: "", authValue: null })).toEqual({
      ok: true,
      update: { enabled: true, endpoint: "http://127.0.0.1:1", authHeader: "Authorization", authValue: null },
    });
    expect(parseDraftApprovalUpdate({ enabled: "yes" })).toMatchObject({ ok: false, field: "enabled" });
    expect(parseDraftApprovalUpdate({ endpoint: "http://example.com" })).toMatchObject({ ok: false, field: "endpoint", reason: "not_loopback" });
    expect(parseDraftApprovalUpdate({ authHeader: "Host" })).toMatchObject({ ok: false, field: "authHeader" });
    expect(parseDraftApprovalUpdate({ authValue: "a\nb" })).toMatchObject({ ok: false, field: "authValue" });
    expect(parseDraftApprovalUpdate({ endpoint: "" })).toEqual({ ok: true, update: { endpoint: null } });
  });

  it("never puts the secret in what the panel sees", () => {
    const shown = publicDraftApprovalConfig(CONFIG);
    expect(shown).toEqual({ enabled: true, endpoint: CONFIG.endpoint, authHeader: "X-Api-Key", hasAuth: true, active: true });
    expect(JSON.stringify(shown)).not.toContain("k-placeholder");
    expect(publicDraftApprovalConfig({ ...CONFIG, endpoint: null }).active).toBe(false);
  });
});
