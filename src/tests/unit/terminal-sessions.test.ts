/**
 * Terminal sessions that outlive the page (TASK-1306, scripts/terminal-sessions.mjs):
 * a shell keeps running when its socket goes, a later socket reattaches by id
 * and is shown the scrollback, a session nobody reattaches to is ended after
 * the idle time, one user never reaches another's, and closing by hand ends it.
 */
import { describe, expect, it, vi } from "vitest";
import {
  OWNER_KEY,
  Scrollback,
  createSessionRegistry,
  envInt,
  handleConnection,
} from "../../../scripts/terminal-sessions.mjs";

class FakePty {
  static next = 1000;
  pid = FakePty.next++;
  written: string[] = [];
  sizes: Array<[number, number]> = [];
  killed = false;
  private dataCbs: Array<(d: string) => void> = [];
  private exitCbs: Array<(e: { exitCode: number }) => void> = [];
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.sizes.push([c, r]); }
  kill() {
    this.killed = true;
    this.exit(0);
  }
  onData(cb: (d: string) => void) { this.dataCbs.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCbs.push(cb); }
  emit(d: string) { for (const cb of this.dataCbs) cb(d); }
  exit(code: number) { for (const cb of this.exitCbs) cb({ exitCode: code }); }
}

class FakeSocket {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.fire("close");
  }
  on(event: string, fn: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
  }
  fire(event: string, ...args: unknown[]) { for (const fn of this.handlers.get(event) ?? []) fn(...args); }
  message(msg: unknown) { this.fire("message", Buffer.from(JSON.stringify(msg))); }
  types() { return this.sent.map((m) => m.type); }
  output() { return this.sent.filter((m) => m.type === "output").map((m) => m.data).join(""); }
}

let idCounter = 0;
function setup(opts: Parameters<typeof createSessionRegistry>[0] = {}) {
  const ptys: FakePty[] = [];
  const registry = createSessionRegistry({
    idleMs: 60_000,
    newId: () => `session-${String(++idCounter).padStart(16, "0")}`,
    ...opts,
  });
  const connect = (query: string, owner = OWNER_KEY) => {
    const ws = new FakeSocket();
    handleConnection(registry, ws, {
      owner,
      params: new URLSearchParams(query),
      spawn: () => {
        const pty = new FakePty();
        ptys.push(pty);
        return { pty, info: { shell: "/bin/bash", cwd: "/home/owner" } };
      },
    });
    return ws;
  };
  return { registry, ptys, connect };
}

function startedId(ws: FakeSocket): string {
  const started = ws.sent.find((m) => m.type === "started");
  expect(typeof started?.session).toBe("string");
  return started!.session as string;
}

describe("a device session (session=new)", () => {
  it("keeps the shell running when its socket closes, and a reattach gets the scrollback then live output", () => {
    const { ptys, connect } = setup();
    const first = connect("session=new");
    const id = startedId(first);
    first.message({ type: "resize", cols: 120, rows: 40 });
    ptys[0].emit("tick 1\r\n");
    first.close();
    expect(ptys[0].killed).toBe(false);

    // Output produced while nobody watched is kept.
    ptys[0].emit("tick 2\r\n");
    const second = connect(`session=${id}`);
    expect(second.types().slice(0, 2)).toEqual(["attached", "output"]);
    expect(second.sent[0]).toMatchObject({ type: "attached", session: id, shell: "/bin/bash" });
    expect(second.sent[1]).toMatchObject({ replay: true });
    expect(second.output()).toBe("tick 1\r\ntick 2\r\n");

    ptys[0].emit("tick 3\r\n");
    expect(second.sent.at(-1)).toEqual({ type: "output", data: "tick 3\r\n" });
    second.message({ type: "input", data: "ls\r" });
    expect(ptys[0].written).toEqual(["ls\r"]);
    expect(ptys).toHaveLength(1);
  });

  it("gives every attached page the output and takes input from any", () => {
    const { ptys, connect } = setup();
    const a = connect("session=new");
    const id = startedId(a);
    a.message({ type: "resize", cols: 80, rows: 24 });
    const b = connect(`session=${id}`);
    ptys[0].emit("both\r\n");
    expect(a.output()).toContain("both");
    expect(b.output()).toContain("both");
    b.message({ type: "input", data: "x" });
    a.message({ type: "input", data: "y" });
    expect(ptys[0].written).toEqual(["x", "y"]);
  });

  it("ends a session nobody reattaches to after the idle time, and then answers gone", () => {
    vi.useFakeTimers();
    try {
      const { ptys, connect } = setup({ idleMs: 5_000 });
      const ws = connect("session=new");
      const id = startedId(ws);
      ws.message({ type: "resize", cols: 80, rows: 24 });
      ws.close();
      vi.advanceTimersByTime(4_999);
      expect(ptys[0].killed).toBe(false);
      // A reattach inside the window stops the clock...
      const back = connect(`session=${id}`);
      vi.advanceTimersByTime(60_000);
      expect(ptys[0].killed).toBe(false);
      // ...and leaving again starts it over.
      back.close();
      vi.advanceTimersByTime(5_000);
      expect(ptys[0].killed).toBe(true);
      const late = connect(`session=${id}`);
      expect(late.sent).toEqual([{ type: "gone" }]);
      expect(late.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets one user reach another's session — it is answered as one that does not exist", () => {
    const { ptys, connect } = setup();
    const owners = connect("session=new");
    const id = startedId(owners);
    owners.message({ type: "resize", cols: 80, rows: 24 });
    const alice = connect(`session=${id}`, "alice");
    expect(alice.sent).toEqual([{ type: "gone" }]);
    const aliceEnd = connect(`end=${id}`, "alice");
    expect(aliceEnd.sent).toEqual([{ type: "gone" }]);
    expect(ptys[0].killed).toBe(false);
  });

  it("ends the session when it is closed by hand, telling any page still attached", () => {
    const { ptys, registry, connect } = setup();
    const ws = connect("session=new");
    const id = startedId(ws);
    ws.message({ type: "resize", cols: 80, rows: 24 });
    const end = connect(`end=${id}`);
    expect(end.sent).toEqual([{ type: "ended" }]);
    expect(ptys[0].killed).toBe(true);
    expect(ws.closed).toBe(true);
    expect(registry.list()).toHaveLength(0);
    expect(connect(`session=${id}`).sent).toEqual([{ type: "gone" }]);
  });

  it("answers gone for an unknown or malformed id, without starting a shell", () => {
    const { ptys, connect } = setup();
    expect(connect("session=AAAAAAAAAAAAAAAAAAAA").sent).toEqual([{ type: "gone" }]);
    expect(connect("session=../../etc/passwd").sent).toEqual([{ type: "gone" }]);
    expect(connect("end=nope").sent).toEqual([{ type: "gone" }]);
    expect(ptys).toHaveLength(0);
  });

  it("keeps a shell that ended while nobody watched, so a reattach shows how it ended", () => {
    const { ptys, connect } = setup();
    const ws = connect("session=new");
    const id = startedId(ws);
    ws.message({ type: "resize", cols: 80, rows: 24 });
    ws.close();
    ptys[0].emit("done\r\n");
    ptys[0].exit(3);
    const back = connect(`session=${id}`);
    expect(back.types()).toEqual(["attached", "output", "exit"]);
    expect(back.sent[2]).toEqual({ type: "exit", code: 3 });
    expect(back.closed).toBe(true);
  });

  it("ends a new session whose page never spoke on it — a reload during the handshake leaves nothing behind", () => {
    const { ptys, registry, connect } = setup();
    const ws = connect("session=new");
    ws.close();
    expect(ptys[0].killed).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("holds each user to a number of unwatched sessions, ending the oldest first", () => {
    let clock = 0;
    const { ptys, registry, connect } = setup({ maxDetachedPerUser: 2, now: () => ++clock });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const ws = connect("session=new");
      ids.push(startedId(ws));
      ws.message({ type: "resize", cols: 80, rows: 24 });
      ws.close();
    }
    expect(ptys.map((p) => p.killed)).toEqual([true, false, false]);
    expect(registry.list().map((s) => s.id)).toEqual(ids.slice(1));
    // Another user's sessions are not counted against this one.
    const other = connect("session=new", "alice");
    other.message({ type: "resize", cols: 80, rows: 24 });
    expect(ptys.slice(0, 3).map((p) => p.killed)).toEqual([true, false, false]);
  });
});

describe("a plain connection (no session asked for)", () => {
  it("is the old behaviour: a fresh shell that ends with its socket, with no id handed out", () => {
    const { ptys, registry, connect } = setup();
    const ws = connect("");
    expect(ws.sent[0]).toEqual({ type: "started", shell: "/bin/bash", cwd: "/home/owner" });
    ws.message({ type: "resize", cols: 80, rows: 24 });
    ws.close();
    expect(ptys[0].killed).toBe(true);
    expect(registry.list()).toHaveLength(0);
  });

  it("tells the client and closes when the shell cannot start, leaving the server up", () => {
    const registry = createSessionRegistry();
    const ws = new FakeSocket();
    handleConnection(registry, ws, {
      owner: OWNER_KEY,
      params: new URLSearchParams("session=new"),
      spawn: () => { throw new Error("EAGAIN"); },
    });
    expect(ws.types()).toEqual(["output", "exit"]);
    expect(ws.output()).toContain("Failed to start shell: EAGAIN");
    expect(ws.closed).toBe(true);
  });

  it("ignores a malformed message and an invalid resize", () => {
    const { ptys, connect } = setup();
    const ws = connect("session=new");
    ws.fire("message", Buffer.from("not json"));
    ws.message({ type: "resize", cols: -1, rows: "x" });
    ws.message({ type: "resize", cols: 100, rows: 30 });
    expect(ptys[0].sizes).toEqual([[100, 30]]);
  });
});

describe("Scrollback", () => {
  it("keeps the last characters up to its cap, cut at a line start", () => {
    const sb = new Scrollback(20);
    sb.append("line-one\r\nline-two\r\n");
    sb.append("line-three\r\n");
    const text = sb.text();
    expect(text.length).toBeLessThanOrEqual(20);
    expect(text).toBe("line-three\r\n");
  });

  it("stays bounded under a flood of output", () => {
    const sb = new Scrollback(1000);
    for (let i = 0; i < 10_000; i++) sb.append(`row ${i}\r\n`);
    expect(sb.text().length).toBeLessThanOrEqual(1000);
    expect(sb.text().endsWith("row 9999\r\n")).toBe(true);
    expect(sb.buf.length).toBeLessThanOrEqual(1250);
  });
});

describe("envInt", () => {
  it.each([
    [undefined, 7],
    ["", 7],
    ["30", 30],
    ["0", 7],
    ["abc", 7],
    ["1.5", 7],
    ["99999999", 7],
  ])("reads %s as %s", (value, expected) => {
    expect(envInt(value as string | undefined, 7, 1, 1000)).toBe(expected);
  });
});
