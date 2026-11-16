// The mail send backend as ClawBox reads it: what a draft is normalised to,
// what its content hash covers, what a card shows, and how every answer the
// backend can give is read — including the ones that must never be reported as
// "not sent".

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanBody,
  cleanLine,
  draftContentHash,
  draftView,
  fetchDraft,
  htmlToText,
  isDraftId,
  normalizeDraft,
  probeBackend,
  sendDraft,
  BACKEND_MAX_BYTES,
  MAX_PREVIEW_CHARS,
  type MailDraft,
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

const BASE: MailDraft = {
  id: "d1",
  to: ["ivan@example.com"],
  cc: [],
  bcc: [],
  subject: "Hello",
  bodyType: "text",
  body: "Body",
  attachments: [],
};

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
      to: ["Ivan Ivanov <ivan@example.com>", "Ops <ops@example.com>"],
      cc: ["a@example.com", "b@example.com"],
      bcc: [],
      subject: "Offer",
      bodyType: "text",
      body: "Hi",
      attachments: [{ name: "offer.pdf", size: 2048 }],
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
        body: { contentType: "HTML", content: "<p>Hi <b>there</b></p>" },
      },
      "AAMk=",
    );
    expect(draft).toMatchObject({
      to: ["Acme Buyer <buyer@acme.example>"],
      bcc: ["hidden@example.net"],
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
    expect(normalizeDraft("nope", "d1")).toBeNull();
    expect(normalizeDraft([], "d1")).toBeNull();
  });
});

describe("draftContentHash", () => {
  it("changes with everything that decides what is sent, and only with that", () => {
    const base = draftContentHash(BASE);
    expect(draftContentHash({ ...BASE })).toBe(base);
    for (const changed of [
      { ...BASE, to: ["ivan@example.com", "x@example.net"] },
      { ...BASE, cc: ["x@example.net"] },
      { ...BASE, bcc: ["x@example.net"] },
      { ...BASE, subject: "Hello!" },
      { ...BASE, body: "Body." },
      { ...BASE, bodyType: "html" as const },
      { ...BASE, attachments: [{ name: "a.pdf", size: 1 }] },
      { ...BASE, id: "d2" },
    ]) {
      expect(draftContentHash(changed)).not.toBe(base);
    }
  });
});

describe("what a card shows", () => {
  it("turns an HTML body into its words, scripts and markup gone", () => {
    const text = htmlToText("<div>Hello<br>World</div><script>alert(1)</script><ul><li>one</li><li>two</li></ul><img alt=\"logo\" src=\"x\">");
    expect(text).toContain("Hello\nWorld");
    expect(text).toContain("• one");
    expect(text).not.toContain("alert");
    expect(text).not.toContain("<");
  });

  it("removes what would make a line read differently from what is sent", () => {
    expect(cleanLine("Pay‮gnp.exe\u0007\r\nnow", 100)).toBe("Paygnp.exe now");
    expect(cleanBody("a\r\nb c​d﻿")).toBe("a\nb\nc​d");
  });

  it("caps the preview but never the hash", () => {
    const long = { ...BASE, body: "x".repeat(MAX_PREVIEW_CHARS + 50) };
    const view = draftView(long);
    expect(view.body).toHaveLength(MAX_PREVIEW_CHARS);
    expect(view.bodyTruncated).toBe(true);
    expect(draftContentHash(long)).not.toBe(draftContentHash({ ...long, body: long.body.slice(0, -1) }));
  });
});

describe("draft ids", () => {
  it("accepts real ids and nothing that would change a URL", () => {
    for (const id of ["AAMkAGI2THVSAAA=", "r-123_4.5", "abc@mail.example", "imap:42", "a/b+c=="]) {
      expect(isDraftId(id), id).toBe(true);
    }
    for (const id of ["", "a b", "x?y=1", "x#y", "x\ny", "\"x\"", "a".repeat(513)]) {
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
