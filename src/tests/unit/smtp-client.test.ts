// The SMTP client is tested against a real TCP server speaking real SMTP,
// not against a mock of itself. A mocked socket would have happily accepted
// every framing bug this file exists to catch (multi-line 250- replies, the
// DATA terminator, dot-stuffing, base64 AUTH).
//
// The sink here is plaintext, so these tests pass `requireTls: false`. That
// flag is not reachable from any product path: parseEmailConfigure never sets
// it and toSmtpConfig never forwards it, so a real save always demands
// STARTTLS. The encrypted path is proven separately by the on-device end-to-end
// run against a TLS sink.

import net from "net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMessage,
  encodeHeaderValue,
  isEmailAddress,
  isHostname,
  isPort,
  sendMail,
  SmtpError,
  verifySmtp,
} from "@/lib/smtp-client";

interface Sink {
  port: number;
  close: () => Promise<void>;
  /** Full DATA payloads the sink accepted. */
  messages: string[];
  /** Command lines the sink saw, excluding DATA bodies. */
  commands: string[];
}

interface SinkOptions {
  user?: string;
  password?: string;
  /** Advertise only AUTH LOGIN, to exercise the challenge/response path. */
  loginOnly?: boolean;
  rejectRecipient?: string;
  /** Refuse the message after DATA, like a provider blocking the sender. */
  rejectData?: boolean;
  /**
   * Quote the credential it was just given back in its failure reply. Real
   * servers should not, and some do quote the offending command; either way
   * that reply becomes SmtpError.detail, which /email/configure hands straight
   * to the browser — so the scrubbing has to hold rather than be assumed.
   */
  echoesCredentials?: boolean;
  /** Refuse AUTH with this code instead of 535 (501 exercises the non-auth throw). */
  authFailureCode?: number;
}

async function startSink(options: SinkOptions = {}): Promise<Sink> {
  const user = options.user ?? "box@example.com";
  const password = options.password ?? "correct-horse";
  const messages: string[] = [];
  const commands: string[] = [];
  /** "535 5.7.8" unless the caller asked for a code the client must NOT read as an auth failure. */
  const authFailure = () => `${options.authFailureCode ?? 535} 5.7.8`;

  const server = net.createServer((socket) => {
    let buffer = "";
    let inData = false;
    let dataBuffer = "";
    let loginStage: "none" | "user" | "password" = "none";

    socket.write("220 sink.test ESMTP ready\r\n");

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const idx = buffer.indexOf("\r\n");
        if (idx < 0) break;
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);

        if (inData) {
          if (line === ".") {
            inData = false;
            messages.push(dataBuffer);
            dataBuffer = "";
            socket.write(options.rejectData ? "550 5.7.1 Message refused\r\n" : "250 2.0.0 Ok: queued\r\n");
          } else {
            // RFC 5321 §4.5.2: the receiver strips one leading dot.
            dataBuffer += `${line.startsWith(".") ? line.slice(1) : line}\r\n`;
          }
          continue;
        }

        commands.push(line);

        if (loginStage === "user") {
          loginStage = "password";
          socket.write("334 UGFzc3dvcmQ6\r\n");
          continue;
        }
        if (loginStage === "password") {
          loginStage = "none";
          const supplied = Buffer.from(line, "base64").toString("utf8");
          if (supplied === password) {
            socket.write("235 2.7.0 Authentication successful\r\n");
          } else {
            // `line` is the base64 the client sent — the other shape the
            // password can take on the wire.
            socket.write(`${authFailure()} Bad credentials${options.echoesCredentials ? ` [${line}]` : ""}\r\n`);
          }
          continue;
        }

        if (/^EHLO /i.test(line)) {
          socket.write("250-sink.test\r\n");
          socket.write(options.loginOnly ? "250-AUTH LOGIN\r\n" : "250-AUTH PLAIN LOGIN\r\n");
          socket.write("250 SIZE 35882577\r\n");
        } else if (/^AUTH PLAIN /i.test(line)) {
          const decoded = Buffer.from(line.slice("AUTH PLAIN ".length), "base64").toString("utf8");
          const [, suppliedUser, suppliedPassword] = decoded.split("\0");
          if (suppliedUser === user && suppliedPassword === password) {
            socket.write("235 2.7.0 Authentication successful\r\n");
          } else {
            const echo = options.echoesCredentials ? ` (got "${suppliedPassword}")` : "";
            socket.write(`${authFailure()} Username and Password not accepted${echo}\r\n`);
          }
        } else if (/^AUTH LOGIN$/i.test(line)) {
          loginStage = "user";
          socket.write("334 VXNlcm5hbWU6\r\n");
        } else if (/^MAIL FROM:/i.test(line)) {
          socket.write("250 2.1.0 Ok\r\n");
        } else if (/^RCPT TO:/i.test(line)) {
          const bad = options.rejectRecipient && line.includes(options.rejectRecipient);
          socket.write(bad ? "550 5.1.1 No such user\r\n" : "250 2.1.5 Ok\r\n");
        } else if (/^DATA$/i.test(line)) {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        } else if (/^QUIT$/i.test(line)) {
          socket.write("221 2.0.0 Bye\r\n");
          socket.end();
        } else {
          socket.write("500 5.5.2 Unrecognized command\r\n");
        }
      }
    });
    socket.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");

  return {
    port: address.port,
    messages,
    commands,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const sinks: Sink[] = [];
async function sink(options?: SinkOptions): Promise<Sink> {
  const s = await startSink(options);
  sinks.push(s);
  return s;
}

afterEach(async () => {
  while (sinks.length) await sinks.pop()!.close();
});

function config(port: number, password = "correct-horse") {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    requireTls: false,
    user: "box@example.com",
    password,
  };
}

describe("verifySmtp", () => {
  it("authenticates with AUTH PLAIN when the server advertises it", async () => {
    const s = await sink();
    await expect(verifySmtp(config(s.port))).resolves.toBeUndefined();
    expect(s.commands.some((c) => c.startsWith("AUTH PLAIN "))).toBe(true);
  });

  // Routes pass request.signal. Without it, a user who navigates away mid-
  // "Connect" leaves the socket open until the 15 s/20 s timeouts fire.
  it("hangs up when the caller aborts", async () => {
    const s = await sink();
    const controller = new AbortController();
    const promise = verifySmtp(config(s.port), { signal: controller.signal });
    controller.abort();
    const err = (await promise.catch((e) => e)) as SmtpError;
    expect(err).toBeInstanceOf(SmtpError);
    expect(err.kind).toBe("network");
  });

  it("does not open a socket at all for an already-aborted caller", async () => {
    const s = await sink();
    const err = (await verifySmtp(config(s.port), { signal: AbortSignal.abort() }).catch(
      (e) => e,
    )) as SmtpError;
    expect(err).toBeInstanceOf(SmtpError);
    expect(s.commands).toEqual([]);
  });

  it("falls back to AUTH LOGIN when PLAIN is not advertised", async () => {
    const s = await sink({ loginOnly: true });
    await expect(verifySmtp(config(s.port))).resolves.toBeUndefined();
    expect(s.commands).toContain("AUTH LOGIN");
  });

  it("reports a bad password as an auth failure, not a network one", async () => {
    const s = await sink();
    const err = await verifySmtp(config(s.port, "wrong-password")).catch((e) => e);
    expect(err).toBeInstanceOf(SmtpError);
    expect((err as SmtpError).kind).toBe("auth");
    expect((err as SmtpError).message).toMatch(/App Password/i);
  });

  // SmtpError.detail is returned to the browser by /email/configure, so the
  // module's "nothing server-supplied leaves here unscrubbed" rule has to hold
  // on the throw paths too — not only in Session.expect().
  it("scrubs the password out of an auth-failure detail (AUTH PLAIN)", async () => {
    const s = await sink({ echoesCredentials: true });
    const secret = "hunter2-app-password";
    const err = (await verifySmtp(config(s.port, secret)).catch((e) => e)) as SmtpError;
    expect(err.kind).toBe("auth");
    expect(err.detail).toBeTruthy();
    expect(err.detail).not.toContain(secret);
    expect(err.detail).toContain("***");
  });

  it("scrubs the base64 password out of an auth-failure detail (AUTH LOGIN)", async () => {
    const s = await sink({ echoesCredentials: true, loginOnly: true });
    const secret = "hunter2-app-password";
    const encoded = Buffer.from(secret, "utf8").toString("base64");
    const err = (await verifySmtp(config(s.port, secret)).catch((e) => e)) as SmtpError;
    expect(err.kind).toBe("auth");
    expect(err.detail).not.toContain(secret);
    expect(err.detail).not.toContain(encoded);
    expect(err.detail).toContain("***");
  });

  it("scrubs the password when the refusal is not an auth code at all", async () => {
    // 501 does not read as an auth failure, so this takes the other throw in
    // authenticate() — the one that was also passing reply.text through raw.
    const s = await sink({ echoesCredentials: true, authFailureCode: 501 });
    const secret = "hunter2-app-password";
    const err = (await verifySmtp(config(s.port, secret)).catch((e) => e)) as SmtpError;
    expect(err.kind).toBe("protocol");
    expect(err.detail).not.toContain(secret);
    expect(err.detail).toContain("***");
  });

  it("never puts the password in the error it surfaces", async () => {
    const s = await sink();
    const secret = "sup3r-secret-value";
    const err = (await verifySmtp(config(s.port, secret)).catch((e) => e)) as SmtpError;
    const rendered = `${err.message} ${err.detail ?? ""}`;
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain(Buffer.from(secret, "utf8").toString("base64"));
  });

  it("classifies a closed port as a network failure", async () => {
    const s = await sink();
    const port = s.port;
    await s.close();
    sinks.pop();
    const err = (await verifySmtp(config(port)).catch((e) => e)) as SmtpError;
    expect(err.kind).toBe("network");
  });

  it("refuses to authenticate over an unencrypted connection by default", async () => {
    const s = await sink();
    // Same sink, but without the test-only opt-out: no STARTTLS is advertised.
    const err = (await verifySmtp({ ...config(s.port), requireTls: undefined }).catch((e) => e)) as SmtpError;
    expect(err.kind).toBe("tls");
    expect(err.message).toMatch(/STARTTLS/);
    expect(s.commands.some((c) => c.startsWith("AUTH"))).toBe(false);
  });
});

describe("sendMail", () => {
  it("delivers a message the sink can read back", async () => {
    const s = await sink();
    const result = await sendMail(config(s.port), {
      from: "box@example.com",
      fromName: "ClawBox",
      to: ["owner@example.com"],
      subject: "Hello",
      text: "Body line one.",
    });
    expect(result.messageId).toContain("@example.com");
    expect(s.messages).toHaveLength(1);
    const raw = s.messages[0];
    expect(raw).toContain("From: ClawBox <box@example.com>");
    expect(raw).toContain("To: <owner@example.com>");
    expect(raw).toContain("Subject: Hello");
    const body = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Body line one.");
  });

  it("survives a body whose base64 line would otherwise start with a dot", async () => {
    const s = await sink();
    // Enough text that the encoder produces many lines; the assertion is that
    // whatever lands, it decodes back to exactly what was sent.
    const text = ".\n.leading dot\n" + "x".repeat(5_000);
    await sendMail(config(s.port), {
      from: "box@example.com",
      to: ["owner@example.com"],
      subject: "Dots",
      text,
    });
    const raw = s.messages[0];
    const encoded = raw.split("\r\n\r\n").slice(1).join("\r\n\r\n").trim();
    // The sink strips one leading dot per line, exactly as a real server does.
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(text);
  });

  it("reports a refused recipient as a recipient failure", async () => {
    const s = await sink({ rejectRecipient: "nobody@example.com" });
    const err = (await sendMail(config(s.port), {
      from: "box@example.com",
      to: ["nobody@example.com"],
      subject: "Hi",
      text: "x",
    }).catch((e) => e)) as SmtpError;
    expect(err.kind).toBe("recipient");
  });

  it("reports a post-DATA refusal as blocked, not as an auth problem", async () => {
    const s = await sink({ rejectData: true });
    const err = (await sendMail(config(s.port), {
      from: "box@example.com",
      to: ["owner@example.com"],
      subject: "Hi",
      text: "x",
    }).catch((e) => e)) as SmtpError;
    expect(err.kind).toBe("blocked");
  });

  it("refuses a subject containing a line break", async () => {
    const s = await sink();
    const err = (await sendMail(config(s.port), {
      from: "box@example.com",
      to: ["owner@example.com"],
      subject: "Hi\r\nBcc: victim@example.com",
      text: "x",
    }).catch((e) => e)) as SmtpError;
    expect(err).toBeInstanceOf(SmtpError);
    expect(s.messages).toHaveLength(0);
  });
});

describe("header encoding and validation helpers", () => {
  it("leaves an ASCII header alone", () => {
    expect(encodeHeaderValue("Plain Subject")).toBe("Plain Subject");
  });

  it("encodes a non-ASCII header as RFC 2047 words", () => {
    const encoded = encodeHeaderValue("Здравей от ClawBox");
    expect(encoded.startsWith("=?UTF-8?B?")).toBe(true);
    const decoded = encoded
      .split("\r\n ")
      .map((word) => Buffer.from(word.replace(/^=\?UTF-8\?B\?/, "").replace(/\?=$/, ""), "base64").toString("utf8"))
      .join("");
    expect(decoded).toBe("Здравей от ClawBox");
  });

  it("builds a message with the headers a mail server requires", () => {
    const { id, data } = buildMessage(
      { from: "a@b.com", to: ["c@d.com"], subject: "S", text: "T" },
      "b.com",
    );
    expect(data).toContain(`Message-ID: <${id}>`);
    expect(data).toContain("MIME-Version: 1.0");
    expect(data).toContain("Content-Transfer-Encoding: base64");
  });

  it("accepts real addresses and rejects the shapes that break SMTP", () => {
    expect(isEmailAddress("owner@example.com")).toBe(true);
    expect(isEmailAddress("first.last+tag@sub.example.co.uk")).toBe(true);
    expect(isEmailAddress("no-at-sign")).toBe(false);
    expect(isEmailAddress("two@@example.com")).toBe(false);
    expect(isEmailAddress("spaced address@example.com")).toBe(false);
    expect(isEmailAddress("a@b")).toBe(false);
  });

  it("validates hosts and ports", () => {
    expect(isHostname("smtp.gmail.com")).toBe(true);
    expect(isHostname("smtp gmail com")).toBe(false);
    expect(isPort(587)).toBe(true);
    expect(isPort(0)).toBe(false);
    expect(isPort(70_000)).toBe(false);
  });
});
