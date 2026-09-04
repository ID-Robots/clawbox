import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { StrictMode } from "react";
import { act, render, waitFor } from "@/tests/helpers/test-utils";
import ChatApp from "@/components/ChatApp";
import ChatPopup from "@/components/ChatPopup";
import { resetHarnessCache } from "@/lib/client-harness";

/**
 * A state updater is a PURE function of the previous state, and React is
 * entitled to call it twice.
 *
 * Both chat surfaces appended the interrupted turn from INSIDE the
 * `setStreaming` updater on a gateway abort:
 *
 *   setStreaming(prev => {
 *     const kept = dropUnfinishedDirective(prev)
 *     if (kept.trim()) setMessages(msgs => [...msgs, { … }])   // <- side effect
 *     return ''
 *   })
 *
 * Under Strict Mode — and under concurrent rendering, which is not a dev-only
 * behaviour — that runs twice and the owner's interrupted answer is appended
 * to the transcript TWICE. CodeRabbit raised it on both surfaces during PR
 * #605 and it was refuted there as pre-existing and out of scope; this is the
 * card it was deferred to (TASK-703).
 *
 * Strict Mode is how the test provokes it, not what the fix is for: the same
 * double-invocation is what React does when it re-renders a component whose
 * update was interrupted, which is why the rule is "no side effects in an
 * updater" rather than "no side effects in an updater in development".
 */

const REPLY = "Half an answer before the owner pressed Stop.";

type Frame = Record<string, unknown>;

const instances: FakeGatewayWs[] = [];

class FakeGatewayWs {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeGatewayWs.OPEN;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(public url: string) {
    instances.push(this);
    setTimeout(
      () => this.emit({ type: "event", event: "connect.challenge", payload: { nonce: "test-nonce" } }),
      0,
    );
  }

  send(raw: string) {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }
    if (frame.type !== "req") return;
    const id = frame.id as string;
    if (frame.method === "connect") {
      this.respond(id, { snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } } });
      return;
    }
    if (frame.method === "chat.history") {
      this.respond(id, { messages: [] });
      return;
    }
    this.respond(id, {});
  }

  close() {
    this.readyState = FakeGatewayWs.CLOSED;
  }

  addEventListener() {}
  removeEventListener() {}

  private respond(id: string, payload: unknown) {
    setTimeout(() => this.emit({ type: "res", id, ok: true, payload }), 0);
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  pushChat(state: string, message: unknown) {
    this.emit({
      type: "event",
      event: "chat",
      payload: { sessionKey: "agent:main:main", state, message },
    });
  }
}

async function socket() {
  await waitFor(() => expect(instances.length).toBeGreaterThan(0));
  return instances[instances.length - 1];
}

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/setup-api/gateway/ws-config")) {
        return { ok: true, json: async () => ({ token: "t", wsUrl: "ws://localhost/gw" }) };
      }
      if (url.includes("/setup-api/harness/active")) {
        return { ok: true, json: async () => ({ active: "openclaw", edition: "openclaw" }) };
      }
      if (url.includes("/setup-api/chat/model")) {
        return { ok: true, json: async () => ({ options: [], activeOptionId: "" }) };
      }
      return { ok: true, json: async () => ({}) };
    }),
  );
}

/** How many times `needle` appears in what is on screen. */
function occurrences(needle: string): number {
  return (document.body.textContent ?? "").split(needle).length - 1;
}

/** Let the handshake and the one `chat.history` round-trip settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Push a partial reply, then the abort the Stop button produces. */
async function streamThenAbort(ws: FakeGatewayWs): Promise<void> {
  await settle();
  await act(async () => {
    ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: REPLY }] });
    await Promise.resolve();
  });
  await act(async () => {
    ws.pushChat("aborted", { role: "assistant", content: [{ type: "text", text: "" }] });
    await Promise.resolve();
  });
}

beforeEach(() => {
  // jsdom has no `scrollIntoView`, and `scrollToBottomAfterLayout` (src/lib/scroll.ts)
  // calls it from a double-rAF — OUTSIDE any test body, so vitest counts the
  // TypeError as an unhandled error and the whole components project exits 1
  // while every assertion here passes. Every other chat suite in this repo
  // stubs it for the same reason.
  Element.prototype.scrollIntoView = vi.fn();
  instances.length = 0;
  resetHarnessCache();
  vi.stubGlobal("WebSocket", FakeGatewayWs as unknown as typeof WebSocket);
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("an interrupted turn is appended once, however many times React renders", () => {
  it("full-screen chat", async () => {
    render(
      <StrictMode>
        <ChatApp />
      </StrictMode>,
    );
    const ws = await socket();

    await streamThenAbort(ws);

    // Once. Twice is the defect: the streaming bubble is gone by now, so every
    // copy on screen is an appended transcript entry.
    expect(occurrences(REPLY)).toBe(1);
  });

  it("mascot popup", async () => {
    render(
      <StrictMode>
        <ChatPopup isOpen onClose={() => {}} />
      </StrictMode>,
    );
    const ws = await socket();

    await streamThenAbort(ws);

    expect(occurrences(REPLY)).toBe(1);
  });

  it("keeps the interrupted answer above the error line, as it was", async () => {
    // Moving the append out of the updater also moved it in TIME: on beta it
    // was queued during the render pass, i.e. AFTER the system error line the
    // handler had already queued, so the owner saw the red line and then the
    // fragment. Outside the updater it queues first. Same commit either way,
    // but the two bubbles swap — a customer-visible change with nothing
    // pinning it. Pinned here: the answer the box managed to write comes
    // first, and the line explaining that it stopped comes after it.
    render(
      <StrictMode>
        <ChatApp />
      </StrictMode>,
    );
    const ws = await socket();
    await settle();
    await act(async () => {
      ws.pushChat("delta", { role: "assistant", content: [{ type: "text", text: REPLY }] });
      await Promise.resolve();
    });
    await act(async () => {
      ws.emit({
        type: "event",
        event: "chat",
        payload: {
          sessionKey: "agent:main:main",
          state: "error",
          message: { role: "assistant", content: [{ type: "text", text: "" }] },
          errorMessage: "gateway said no",
        },
      });
      await Promise.resolve();
    });

    const rendered = document.body.textContent ?? "";
    const reply = rendered.indexOf(REPLY);
    // The failure notice, whatever its wording — the surface picks between a
    // sanitised gateway line and its own generic one.
    const notice = rendered.search(/Error:|did not go through|could not|failed|try again/i);
    expect(reply, `the interrupted answer was not kept:\n${rendered}`).toBeGreaterThan(-1);
    expect(notice, `no failure notice was shown:\n${rendered}`).toBeGreaterThan(-1);
    expect(reply, `the notice came before the answer:\n${rendered}`).toBeLessThan(notice);
  });

  // The behavioural cases above pin the two paths that were reported. This one
  // pins the RULE, for the sites a component test cannot reach — the effort
  // picker's "Switched effort to …" was appended from inside the
  // `setThinkingLevel` updater the same way, and only a header dropdown with a
  // provider that offers more than one level renders it at all.
  it("has no state setter inside a state updater, anywhere in the UI", () => {
    // The whole UI tree, not just the two surfaces: after this fix there are NO
    // such sites left in src/components, src/hooks or src/app, so the rule can
    // be stated as a rule. `src/app/page.tsx` held two more — the wallpaper
    // upload and delete, each writing localStorage and calling two sibling
    // setters from inside a `setCustomWallpapers` updater — and they are fixed
    // here rather than excluded by the scope of the test that claims to cover
    // them. They were idempotent, which is exactly why they went unnoticed.
    const offenders = [...walk("src/components"), ...walk("src/hooks"), ...walk("src/app")]
      .flatMap((file) => nestedSetters(file));

    expect(offenders).toEqual([]);
  });
});

/**
 * Every `setX(prev => …)` in a file whose body calls another `setY(`.
 *
 * The body is taken by balancing parentheses from the updater's own `(`, so a
 * nested arrow or object cannot end it early, and string/comment contents are
 * not parsed — a `setSomething(` inside a string would be a false positive, and
 * there are none in these two files today.
 */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Blank out comments and string bodies, preserving length and newlines.
 *
 * The paren scan below counts brackets, so ONE unmatched paren inside a prose
 * comment closes an updater's body early and the rule silently stops guarding
 * that site — and an unmatched one inside a string runs the scan to EOF and
 * reports every setter in the rest of the file. `ChatPopup.tsx` is 6 300 lines
 * of dense comments; a `// … the ) …` would have disarmed this with no signal.
 */
function blankNonCode(source: string): string {
  const out = source.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== "\n") out[k] = " ";
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      blank(i, end < 0 ? source.length : end);
      i = end < 0 ? source.length : end;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      blank(i, end < 0 ? source.length : end + 2);
      i = end < 0 ? source.length : end + 2;
    } else if (source[i] === '"' || source[i] === "'" || source[i] === "`") {
      const quote = source[i];
      let j = i + 1;
      while (j < source.length && source[j] !== quote) j += source[j] === "\\" ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join("");
}

function nestedSetters(relativePath: string): string[] {
  const source = blankNonCode(fs.readFileSync(path.join(process.cwd(), relativePath), "utf-8"));
  // `set` + capital is also `setTimeout`/`setInterval`, whose callback is NOT a
  // state updater — React does not re-run it — so they cannot open one. They
  // stay in the nested set below, where scheduling a timer from inside an
  // updater would be the same impurity. A leading `.` means a method
  // (`localStorage.setItem`, `el.setAttribute`), never a setter from useState.
  const opener = /(?<![.\w])set(?!Timeout|Interval|Immediate)[A-Z]\w*\(\s*(?:\w+|\([^)]*\))\s*=>/g;
  const found: string[] = [];
  for (const match of source.matchAll(opener)) {
    const openParen = source.indexOf("(", match.index!);
    let depth = 0;
    let end = openParen;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      else if (source[end] === ")" && --depth === 0) break;
    }
    // A scan that ran to EOF found no closing paren, which means the blanking
    // above missed something. Reporting garbage from it would be worse than
    // saying so.
    if (end >= source.length) {
      found.push(`${relativePath}: unbalanced parentheses while scanning ${match[0]}`);
      continue;
    }
    const body = source.slice(source.indexOf("=>", openParen) + 2, end);
    // The project's OWN wrappers count: `setMessages(prev => { applyStreaming("");
    // return prev })` would pass a setter-only rule while being strictly worse
    // than the defect — React may run it twice AND it mutates a ref during the
    // render phase, so the ref and the state can disagree at commit time.
    const nested = [...body.matchAll(/(?<![.\w])(?:set|apply)[A-Z]\w*\(/g)].map((m) => m[0]);
    if (nested.length > 0) {
      const line = source.slice(0, match.index!).split("\n").length;
      found.push(`${relativePath}:${line} ${match[0]} -> ${[...new Set(nested)].join(", ")}`);
    }
  }
  return found;
}
