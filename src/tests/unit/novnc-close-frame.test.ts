import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every close of the Remote Desktop window — and of the Browser app, which
 * embeds the same view — put a red line in the browser console:
 *
 *   WebSocket connection to 'ws://127.0.0.1/novnc-ws' failed:
 *   Received a broken close frame containing a reserved status code.
 *
 * noVNC calls `WebSocket.close()` with no arguments, so the browser's close
 * frame carries no status code. Python websockify answers that by inventing
 * 1005 ("No close status code specified by peer") and sending it back on the
 * wire — and 1005 is one of the codes RFC 6455 reserves for the API and
 * forbids in a frame. production-server.js pipes the two together byte for
 * byte, so the forbidden code reached the browser unaltered and a clean
 * goodbye was reported as a failed connection.
 *
 * production-server.js is the standalone CommonJS entry point: it monkey-
 * patches http.Server.prototype.listen and then requires Next's server, so it
 * cannot be imported here. These cases run the SHIPPED functions, lifted out
 * of the file by name — the same technique as
 * production-server-parked-build.test.ts.
 */

const SRC = readFileSync(path.join(process.cwd(), "production-server.js"), "utf-8");

/** One top-level `function NAME(…) { … }` from the file, by balanced braces. */
function shippedFunction(name: string): string {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`production-server.js no longer defines ${name}()`);
  const open = SRC.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < SRC.length; i++) {
    if (SRC[i] === "{") depth++;
    else if (SRC[i] === "}" && --depth === 0) return SRC.slice(start, i + 1);
  }
  throw new Error(`${name}() in production-server.js is not brace-balanced`);
}

type Rewrite = (chunk: Buffer) => Buffer;

/** The shipped rewriter, instantiated for one connection. */
function newRewriter(): Rewrite {
  const factory = new Function(
    `${shippedFunction("isSendableCloseCode")}\n${shippedFunction("createCloseFrameRewriter")}\nreturn createCloseFrameRewriter();`,
  ) as () => Rewrite;
  return factory();
}

const sendable = new Function(`${shippedFunction("isSendableCloseCode")}\nreturn isSendableCloseCode;`)() as (
  code: number,
) => boolean;

const HANDSHAKE = Buffer.from(
  "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
  "latin1",
);

/** An unmasked server→client frame, the way websockify writes one. */
function frame(opcode: number, payload: Buffer): Buffer {
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  const head = Buffer.alloc(4);
  head[0] = 0x80 | opcode;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

function closeFrame(code: number | null): Buffer {
  if (code === null) return frame(0x8, Buffer.alloc(0));
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return frame(0x8, payload);
}

/** Everything the rewriter would write to the browser for these upstream chunks. */
function through(chunks: Buffer[]): Buffer {
  const rewrite = newRewriter();
  return Buffer.concat(chunks.map((c) => rewrite(c)));
}

describe("close codes that may travel in a frame", () => {
  it("refuses the three RFC 6455 reserves for the API, and 1004", () => {
    for (const code of [1004, 1005, 1006, 1015]) expect(sendable(code)).toBe(false);
  });

  it("accepts the ordinary ones and the application range", () => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1011, 1012, 3000, 4999]) {
      expect(sendable(code)).toBe(true);
    }
  });

  it("refuses codes outside the registry", () => {
    for (const code of [0, 999, 1016, 2999, 5000]) expect(sendable(code)).toBe(false);
  });
});

describe("the /novnc-ws close frame the browser is given", () => {
  it("replaces websockify's 1005 with the empty close it is the stand-in for", () => {
    const out = through([HANDSHAKE, closeFrame(1005)]);
    expect(out.subarray(0, HANDSHAKE.length)).toEqual(HANDSHAKE);
    // 0x88 0x00 — FIN + close, no payload: "no status code", legally spelled.
    expect([...out.subarray(HANDSHAKE.length)]).toEqual([0x88, 0x00]);
  });

  it("leaves a close the browser accepts exactly as it found it", () => {
    const out = through([HANDSHAKE, closeFrame(1000)]);
    expect(out.subarray(HANDSHAKE.length)).toEqual(closeFrame(1000));
  });

  it("keeps an already-empty close empty", () => {
    const out = through([HANDSHAKE, closeFrame(null)]);
    expect(out.subarray(HANDSHAKE.length)).toEqual(closeFrame(null));
  });

  it("repairs a close that arrives one byte at a time", () => {
    const rewrite = newRewriter();
    const wire = Buffer.concat([HANDSHAKE, closeFrame(1005)]);
    const parts: Buffer[] = [];
    for (const byte of wire) parts.push(rewrite(Buffer.from([byte])));
    expect([...Buffer.concat(parts).subarray(HANDSHAKE.length)]).toEqual([0x88, 0x00]);
  });
});

describe("everything that is not a close frame", () => {
  it("forwards framebuffer data byte for byte, however it is chunked", () => {
    const pixels = Buffer.alloc(4096);
    for (let i = 0; i < pixels.length; i++) pixels[i] = i & 0xff;
    const wire = Buffer.concat([HANDSHAKE, frame(0x2, pixels), frame(0x2, Buffer.from("second")), closeFrame(1000)]);
    const rewrite = newRewriter();
    const parts: Buffer[] = [];
    for (let at = 0; at < wire.length; at += 700) parts.push(rewrite(wire.subarray(at, at + 700)));
    expect(Buffer.concat(parts)).toEqual(wire);
  });

  it("passes a payload that happens to look like a close frame through untouched", () => {
    // The bug this guards: a parser that scanned for 0x88 rather than tracking
    // frame boundaries would rewrite the app's own pixels.
    const payload = Buffer.from([0x88, 0x02, 0x03, 0xed, 0x88, 0x02, 0x03, 0xed]);
    const wire = Buffer.concat([HANDSHAKE, frame(0x2, payload)]);
    expect(through([wire])).toEqual(wire);
  });

  it("hands back a non-101 response and its body untouched", () => {
    const wire = Buffer.from("HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\nno", "latin1");
    expect(through([wire])).toEqual(wire);
  });

  it("forwards a ping and a pong on the way to the close", () => {
    const wire = Buffer.concat([HANDSHAKE, frame(0x9, Buffer.from("hi")), frame(0xa, Buffer.from("hi"))]);
    expect(through([wire])).toEqual(wire);
  });
});

describe("how the proxy wires it up", () => {
  it("marks the noVNC route as the one needing the repair, and no other", () => {
    const routes = SRC.slice(SRC.indexOf("const UPGRADE_ROUTES = ["), SRC.indexOf("];", SRC.indexOf("const UPGRADE_ROUTES = [")));
    expect(/"\/novnc-ws"[^}]*sanitizeClose: true/.test(routes)).toBe(true);
    expect(/"\/terminal-ws"[^}]*sanitizeClose/.test(routes)).toBe(false);
  });

  it("puts the sanitizer in the upstream half of the pipe only", () => {
    const proxy = shippedFunction("attachUpgradeProxy");
    expect(proxy).toContain("upstream.pipe(filter).pipe(socket)");
    // The client half must stay a plain pipe: the browser never sends a
    // reserved code, and parsing its frames would only add a way to be wrong.
    expect(proxy).toContain("socket.pipe(upstream);");
  });
});
