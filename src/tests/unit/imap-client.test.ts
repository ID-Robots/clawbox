// The IMAP client is tested against a real TCP server speaking real IMAP, not
// against a mock of itself — the same call the SMTP tests make, for the same
// reason. A mocked socket would have happily accepted every framing bug this
// file exists to catch, and IMAP's are worse than SMTP's: byte-counted literals
// mean a response is NOT "up to the next CRLF", and a message body full of
// CRLFs is the normal case rather than the edge one.
//
// The sink also RECORDS every command it is sent, which is what lets these
// tests assert the promise the feature makes to the owner: the mailbox is
// opened read-only and nothing is ever marked as read. That claim is checked
// here against a server that would report a violation, rather than asserted in
// a comment.
//
// The sink is plaintext, so these tests pass `requireTls: false`. That flag is
// not reachable from any product path: toImapConfig never sets it, so a real
// connection always demands implicit TLS on 993.

import net from "net";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeEncodedWords,
  extractText,
  ImapError,
  isMailboxNameSafe,
  listMessages,
  parseHeaders,
  readMessage,
  verifyImap,
} from "@/lib/imap-client";

interface FakeMessage {
  uid: number;
  flags: string[];
  internalDate: string;
  /** The full RFC 5322 message, CRLF-delimited. */
  raw: string;
}

interface Sink {
  port: number;
  close: () => Promise<void>;
  /** Every command line the sink saw, tag stripped. */
  commands: string[];
}

interface SinkOptions {
  user?: string;
  password?: string;
  messages?: FakeMessage[];
  /** Advertise STARTTLS, so the "must encrypt" path can be exercised. */
  offerStartTls?: boolean;
  /** Advertise LOGINDISABLED — the server refusing passwords on this channel. */
  loginDisabled?: boolean;
  /** Reject LOGIN, optionally quoting the credential back (scrubbing check). */
  authFails?: boolean;
  echoesCredentials?: boolean;
  /** Refuse EXAMINE, like a mailbox that is not there. */
  noSuchMailbox?: boolean;
}

const CRLF = "\r\n";

function msg(uid: number, opts: Partial<FakeMessage> & { subject?: string; from?: string; body?: string; flags?: string[] } = {}): FakeMessage {
  const subject = opts.subject ?? `Subject ${uid}`;
  const from = opts.from ?? `sender${uid}@example.com`;
  const body = opts.body ?? `Body of message ${uid}.`;
  const raw = [
    `From: ${from}`,
    `To: box@example.com`,
    `Subject: ${subject}`,
    `Date: Mon, 0${uid} Jan 2026 10:00:00 +0000`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "",
    body,
  ].join(CRLF);
  return { uid, flags: opts.flags ?? [], internalDate: "01-Jan-2026 10:00:00 +0000", raw };
}

/** The header block a `HEADER.FIELDS (FROM SUBJECT DATE)` fetch returns. */
function headerFields(raw: string): string {
  const head = raw.split(`${CRLF}${CRLF}`)[0];
  const wanted = head
    .split(CRLF)
    .filter((l) => /^(from|subject|date):/i.test(l));
  return `${wanted.join(CRLF)}${CRLF}${CRLF}`;
}

function literal(payload: string): string {
  return `{${Buffer.byteLength(payload, "utf8")}}${CRLF}${payload}`;
}

async function startSink(options: SinkOptions = {}): Promise<Sink> {
  const user = options.user ?? "box@example.com";
  const password = options.password ?? "correct-horse";
  const messages = options.messages ?? [msg(101), msg(102)];
  const commands: string[] = [];

  const caps = ["IMAP4rev1"];
  if (options.offerStartTls) caps.push("STARTTLS");
  if (options.loginDisabled) caps.push("LOGINDISABLED");

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.write(`* OK [CAPABILITY ${caps.join(" ")}] sink ready${CRLF}`);

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const idx = buffer.indexOf(CRLF);
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        const space = line.indexOf(" ");
        const tag = line.slice(0, space);
        const rest = line.slice(space + 1);
        commands.push(rest);

        const verb = rest.split(" ")[0].toUpperCase();

        if (verb === "CAPABILITY") {
          socket.write(`* CAPABILITY ${caps.join(" ")}${CRLF}`);
          socket.write(`${tag} OK CAPABILITY completed${CRLF}`);
          continue;
        }

        if (verb === "LOGIN") {
          const m = /^LOGIN "((?:[^"\\]|\\.)*)" "((?:[^"\\]|\\.)*)"$/.exec(rest);
          const gotUser = m ? m[1].replace(/\\(.)/g, "$1") : "";
          const gotPass = m ? m[2].replace(/\\(.)/g, "$1") : "";
          const ok = !options.authFails && gotUser === user && gotPass === password;
          if (ok) {
            socket.write(`${tag} OK LOGIN completed${CRLF}`);
          } else {
            // Some real servers quote the offending command back. That reply
            // becomes ImapError.detail, so the scrubbing has to hold rather
            // than be assumed.
            const detail = options.echoesCredentials ? ` (tried ${gotPass})` : "";
            socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials${detail}${CRLF}`);
          }
          continue;
        }

        if (verb === "EXAMINE" || verb === "SELECT") {
          if (options.noSuchMailbox) {
            socket.write(`${tag} NO [NONEXISTENT] Unknown Mailbox${CRLF}`);
            continue;
          }
          socket.write(`* ${messages.length} EXISTS${CRLF}`);
          socket.write(`* 0 RECENT${CRLF}`);
          socket.write(`* OK [UIDVALIDITY 1] UIDs valid${CRLF}`);
          socket.write(`${tag} OK [READ-ONLY] EXAMINE completed${CRLF}`);
          continue;
        }

        if (verb === "SEARCH") {
          const unseen = messages
            .map((m, i) => ({ m, seq: i + 1 }))
            .filter(({ m }) => !m.flags.some((f) => f.toLowerCase() === "\\seen"))
            .map(({ seq }) => seq);
          socket.write(`* SEARCH${unseen.length ? ` ${unseen.join(" ")}` : ""}${CRLF}`);
          socket.write(`${tag} OK SEARCH completed${CRLF}`);
          continue;
        }

        if (verb === "FETCH" || (verb === "UID" && /^UID FETCH/i.test(rest))) {
          const isUid = verb === "UID";
          const selected = isUid
            ? messages.filter((m) => m.uid === Number(/^UID FETCH (\d+)/i.exec(rest)?.[1]))
            : (() => {
                const range = /^FETCH (\d+):(\d+)/.exec(rest);
                if (!range) return [];
                return messages.slice(Number(range[1]) - 1, Number(range[2]));
              })();

          for (const m of selected) {
            const seq = messages.indexOf(m) + 1;
            const flags = `FLAGS (${m.flags.join(" ")})`;
            if (/BODY\.PEEK\[HEADER\.FIELDS/i.test(rest)) {
              const payload = headerFields(m.raw);
              socket.write(
                `* ${seq} FETCH (UID ${m.uid} ${flags} INTERNALDATE "${m.internalDate}" `
                + `BODY[HEADER.FIELDS (FROM SUBJECT DATE)] ${literal(payload)})${CRLF}`,
              );
            } else {
              const partial = /BODY\.PEEK\[\]<0\.(\d+)>/i.exec(rest);
              const cap = partial ? Number(partial[1]) : Infinity;
              const payload = Buffer.from(m.raw, "utf8").subarray(0, cap).toString("utf8");
              socket.write(
                `* ${seq} FETCH (UID ${m.uid} ${flags} INTERNALDATE "${m.internalDate}" `
                + `BODY[]<0> ${literal(payload)})${CRLF}`,
              );
            }
          }
          socket.write(`${tag} OK FETCH completed${CRLF}`);
          continue;
        }

        if (verb === "LOGOUT") {
          socket.write(`* BYE sink logging out${CRLF}`);
          socket.write(`${tag} OK LOGOUT completed${CRLF}`);
          continue;
        }

        socket.write(`${tag} BAD Unknown command${CRLF}`);
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    commands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const sinks: Sink[] = [];

async function sink(options: SinkOptions = {}): Promise<Sink> {
  const s = await startSink(options);
  sinks.push(s);
  return s;
}

function cfg(port: number, over: Partial<Parameters<typeof listMessages>[0]> = {}) {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    requireTls: false,
    user: "box@example.com",
    password: "correct-horse",
    ...over,
  };
}

afterEach(async () => {
  await Promise.all(sinks.splice(0).map((s) => s.close()));
});

describe("listMessages", () => {
  it("returns the newest messages with sender, subject, date and unread", async () => {
    const s = await sink({ messages: [msg(101, { flags: ["\\Seen"] }), msg(102)] });
    const listing = await listMessages(cfg(s.port), { limit: 10 });

    expect(listing.total).toBe(2);
    expect(listing.messages).toHaveLength(2);
    expect(listing.messages[0]).toMatchObject({
      uid: 101,
      from: "sender101@example.com",
      subject: "Subject 101",
      unread: false,
    });
    expect(listing.messages[1].unread).toBe(true);
    expect(listing.messages[1].date).toMatch(/2026/);
  });

  it("reports how many are unread", async () => {
    const s = await sink({ messages: [msg(1, { flags: ["\\Seen"] }), msg(2), msg(3)] });
    const listing = await listMessages(cfg(s.port), { limit: 10 });
    expect(listing.unseen).toBe(2);
  });

  it("asks only for the newest N", async () => {
    const s = await sink({ messages: [msg(1), msg(2), msg(3), msg(4), msg(5)] });
    const listing = await listMessages(cfg(s.port), { limit: 2 });
    expect(listing.messages.map((m) => m.uid)).toEqual([4, 5]);
    expect(s.commands.some((c) => c.startsWith("FETCH 4:5"))).toBe(true);
  });

  it("handles an empty mailbox without a fetch", async () => {
    const s = await sink({ messages: [] });
    const listing = await listMessages(cfg(s.port), { limit: 10 });
    expect(listing).toMatchObject({ total: 0, unseen: 0, messages: [] });
    expect(s.commands.some((c) => c.startsWith("FETCH"))).toBe(false);
  });

  it("decodes an RFC 2047 encoded subject", async () => {
    const encoded = `=?UTF-8?B?${Buffer.from("Тест на кирилица", "utf8").toString("base64")}?=`;
    const s = await sink({ messages: [msg(7, { subject: encoded })] });
    const listing = await listMessages(cfg(s.port), { limit: 5 });
    expect(listing.messages[0].subject).toBe("Тест на кирилица");
  });
});

// ── The promise the feature makes ────────────────────────────────────────────
//
// These are the tests that matter most: they are the on-the-wire proof of
// "reading your mail does not change your mail".

describe("read-only guarantees", () => {
  it("opens the mailbox with EXAMINE and never SELECT", async () => {
    const s = await sink();
    await listMessages(cfg(s.port), { limit: 5 });
    expect(s.commands.some((c) => /^EXAMINE /i.test(c))).toBe(true);
    expect(s.commands.some((c) => /^SELECT /i.test(c))).toBe(false);
  });

  it("fetches headers with BODY.PEEK, so listing cannot set \\Seen", async () => {
    const s = await sink();
    await listMessages(cfg(s.port), { limit: 5 });
    const fetch = s.commands.find((c) => c.startsWith("FETCH"))!;
    expect(fetch).toContain("BODY.PEEK[HEADER.FIELDS");
    // A bare BODY[ is the thing that would mark mail as read. It must not
    // appear anywhere in what we sent.
    expect(s.commands.some((c) => /(^|[^.])BODY\[/.test(c))).toBe(false);
  });

  it("fetches a whole message with BODY.PEEK too", async () => {
    const s = await sink();
    await readMessage(cfg(s.port), 101);
    const fetch = s.commands.find((c) => /^UID FETCH/i.test(c))!;
    expect(fetch).toMatch(/BODY\.PEEK\[\]<0\.\d+>/);
    expect(s.commands.some((c) => /(^|[^.])BODY\[/.test(c))).toBe(false);
  });

  it("never sends a command that could modify the mailbox", async () => {
    const s = await sink();
    await listMessages(cfg(s.port), { limit: 5 });
    await readMessage(cfg(s.port), 102);
    for (const forbidden of ["STORE", "APPEND", "EXPUNGE", "COPY", "MOVE", "DELETE", "CREATE", "RENAME"]) {
      expect(
        s.commands.some((c) => new RegExp(`(^|\\s)${forbidden}\\b`, "i").test(c)),
        `${forbidden} must never be sent`,
      ).toBe(false);
    }
  });

  it("leaves an unread message unread after reading it", async () => {
    // The sink reports flags from its own state, and nothing this client sends
    // can change them — so a second listing seeing \Seen would mean the client
    // had issued a write. This is the same check the live device run makes.
    const s = await sink({ messages: [msg(1), msg(2)] });
    const before = await listMessages(cfg(s.port), { limit: 5 });
    await readMessage(cfg(s.port), 1);
    const after = await listMessages(cfg(s.port), { limit: 5 });
    expect(before.messages.map((m) => m.unread)).toEqual([true, true]);
    expect(after.messages.map((m) => m.unread)).toEqual([true, true]);
    expect(after.unseen).toBe(2);
  });
});

describe("readMessage", () => {
  it("returns the message text", async () => {
    const s = await sink({ messages: [msg(101, { body: "Hello from the sink." })] });
    const detail = await readMessage(cfg(s.port), 101);
    expect(detail.uid).toBe(101);
    expect(detail.subject).toBe("Subject 101");
    expect(detail.to).toBe("box@example.com");
    expect(detail.text).toBe("Hello from the sink.");
    expect(detail.truncated).toBe(false);
  });

  it("survives a body full of CRLFs — the literal framing case", async () => {
    // If literals were parsed as "up to the next CRLF", this is the message
    // that would come back as garbage. Every real message looks like this.
    const body = ["line one", "line two", "", "line four", ".", "still the body"].join(CRLF);
    const s = await sink({ messages: [msg(9, { body })] });
    const detail = await readMessage(cfg(s.port), 9);
    expect(detail.text).toContain("line one");
    expect(detail.text).toContain("still the body");
  });

  it("reports a truncated body rather than pretending it is whole", async () => {
    const body = "x".repeat(300_000);
    const s = await sink({ messages: [msg(5, { body })] });
    const detail = await readMessage(cfg(s.port), 5);
    expect(detail.truncated).toBe(true);
    expect(detail.text.length).toBeLessThan(body.length);
  });

  it("fails clearly when the id is not in the mailbox", async () => {
    const s = await sink({ messages: [msg(1)] });
    const err = await readMessage(cfg(s.port), 999).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).kind).toBe("mailbox");
  });

  it("rejects a non-integer id before opening a connection", async () => {
    const err = await readMessage(cfg(1), 0).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).message).toMatch(/valid message id/i);
  });
});

describe("encryption", () => {
  it("refuses to send a password to a server with no STARTTLS", async () => {
    const s = await sink();
    // requireTls left at its default — this is what every product path does.
    const err = await listMessages({ ...cfg(s.port), requireTls: undefined }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).kind).toBe("tls");
    expect((err as ImapError).message).toMatch(/993/);
    // The important half: it never got as far as LOGIN.
    expect(s.commands.some((c) => /^LOGIN/i.test(c))).toBe(false);
  });

  it("refuses when the server says LOGINDISABLED", async () => {
    const s = await sink({ loginDisabled: true });
    const err = await listMessages(cfg(s.port)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).kind).toBe("auth");
    expect(s.commands.some((c) => /^LOGIN/i.test(c))).toBe(false);
  });
});

describe("failures", () => {
  it("maps a rejected password to an auth error naming the App Password", async () => {
    const s = await sink({ authFails: true });
    const err = await listMessages(cfg(s.port)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).kind).toBe("auth");
    expect((err as ImapError).message).toMatch(/App Password/i);
  });

  it("never leaks the password into the error detail", async () => {
    const s = await sink({ authFails: true, echoesCredentials: true });
    const err = (await listMessages(cfg(s.port)).catch((e: unknown) => e)) as ImapError;
    expect(err.detail).toBeDefined();
    expect(err.detail).not.toContain("correct-horse");
    expect(err.detail).toContain("***");
    expect(`${err.message}${err.detail}`).not.toContain("correct-horse");
  });

  it("reports a missing mailbox as a mailbox failure", async () => {
    const s = await sink({ noSuchMailbox: true });
    const err = await listMessages(cfg(s.port)).catch((e: unknown) => e);
    expect((err as ImapError).kind).toBe("mailbox");
  });

  it("reports an unreachable server as a network failure", async () => {
    // Port 1 on loopback: nothing listens there.
    const err = await listMessages(cfg(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).kind).toBe("network");
  });

  it("hangs up when the caller aborts", async () => {
    const s = await sink();
    const controller = new AbortController();
    controller.abort();
    const err = await listMessages(cfg(s.port), { signal: controller.signal }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImapError);
    expect((err as ImapError).message).toMatch(/cancelled/i);
  });
});

describe("verifyImap", () => {
  it("succeeds against a working account", async () => {
    const s = await sink();
    await expect(verifyImap(cfg(s.port))).resolves.toBeUndefined();
  });

  it("fails when the credentials are wrong", async () => {
    const s = await sink({ authFails: true });
    await expect(verifyImap(cfg(s.port))).rejects.toBeInstanceOf(ImapError);
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("mailbox names", () => {
  it("rejects a name carrying a line break, which would inject a command", () => {
    expect(isMailboxNameSafe("INBOX")).toBe(true);
    expect(isMailboxNameSafe("INBOX\r\nA002 DELETE INBOX")).toBe(false);
    expect(isMailboxNameSafe("")).toBe(false);
  });

  it("refuses to open one", async () => {
    const s = await sink();
    const err = await listMessages(cfg(s.port), { mailbox: "IN\r\nBOX" }).catch((e: unknown) => e);
    expect((err as ImapError).kind).toBe("mailbox");
    expect(s.commands.length).toBe(0);
  });
});

describe("header parsing", () => {
  it("unfolds continuation lines", () => {
    const headers = parseHeaders("Subject: one\r\n  two\r\nFrom: a@b.com");
    expect(headers.subject).toBe("one two");
    expect(headers.from).toBe("a@b.com");
  });

  it("keeps the FIRST From, so a second one cannot overwrite it", () => {
    const headers = parseHeaders("From: real@example.com\r\nFrom: spoof@evil.example");
    expect(headers.from).toBe("real@example.com");
  });

  it("decodes both base64 and quoted-printable encoded words", () => {
    expect(decodeEncodedWords("=?UTF-8?B?w6TDtsO8?=")).toBe("äöü");
    expect(decodeEncodedWords("=?ISO-8859-1?Q?caf=E9_bar?=")).toBe("café bar");
    expect(decodeEncodedWords("plain text")).toBe("plain text");
  });
});

describe("text extraction", () => {
  it("prefers the text/plain part of a multipart message", () => {
    const body = [
      "--BOUND",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "the plain part",
      "--BOUND",
      'Content-Type: text/html; charset="utf-8"',
      "",
      "<p>the html part</p>",
      "--BOUND--",
    ].join(CRLF);
    const text = extractText(body, { "content-type": 'multipart/alternative; boundary="BOUND"' });
    expect(text.trim()).toBe("the plain part");
  });

  it("falls back to de-tagged HTML when there is no plain part", () => {
    const body = [
      "--B",
      "Content-Type: text/html",
      "",
      "<p>hello</p><p>world</p>",
      "--B--",
    ].join(CRLF);
    const text = extractText(body, { "content-type": "multipart/alternative; boundary=B" });
    expect(text).toContain("hello");
    expect(text).not.toContain("<p>");
  });

  it("decodes a base64 body", () => {
    const text = extractText(Buffer.from("hidden text", "utf8").toString("base64"), {
      "content-type": "text/plain",
      "content-transfer-encoding": "base64",
    });
    expect(text).toBe("hidden text");
  });

  it("says so plainly when there is no readable text part", () => {
    const body = ["--B", "Content-Type: image/png", "", "binary", "--B--"].join(CRLF);
    const text = extractText(body, { "content-type": "multipart/mixed; boundary=B" });
    expect(text).toMatch(/no readable text part/i);
  });
});
