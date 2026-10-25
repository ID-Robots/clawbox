import { afterEach, describe, expect, it, vi } from "vitest";
import { controlUiSessionGuardScriptBody } from "@/lib/control-ui-session-guard";
import { SESSION_PROBE_URL, sessionExpiredHeaders } from "@/lib/session-expiry";

// The gateway's own Control UI chat on a lapsed session. Its page is the
// gateway's bundle, not ours, so the one ClawBox code on it is the program the
// Control UI routes inject — run here EXACTLY as it ships, against a page made
// of the few things it is allowed to touch: `window` (its fetch, its
// WebSocket, its location and the page that frames it) and `document`.

const GAP_MS = 50;

const gate401 = () => new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: sessionExpiredHeaders() });
const ok = () => new Response("{}", { status: 200 });

type Answer = () => Response | Promise<Response>;

class FakeSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static opened: FakeSocket[] = [];
  constructor(public url: string, public protocols?: string | string[]) {
    super();
    FakeSocket.opened.push(this);
  }
  /** The socket closes — from the box's side, or refused at its upgrade. */
  closeWith(code: number) {
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }
}

interface FakeLocation { origin: string; pathname: string; replace: ReturnType<typeof vi.fn> }
interface FakeWindow {
  location: FakeLocation;
  top: FakeWindow | null;
  fetch: typeof fetch;
  WebSocket: typeof FakeSocket;
  __clawboxSessionGuard?: boolean;
}

function fakeLocation(pathname: string): FakeLocation {
  return { origin: "http://clawbox.local", pathname, replace: vi.fn() };
}

/**
 * A Control UI page with the guard installed. `probe` answers the session
 * probe, `request` every other request the page makes.
 */
function page(opts: { probe?: Answer; request?: Answer; pathname?: string; framedBy?: FakeWindow } = {}) {
  FakeSocket.opened = [];
  const probe = opts.probe ?? ok;
  const request = opts.request ?? ok;
  const nativeFetch = vi.fn(async (input: RequestInfo | URL) => (String(input) === SESSION_PROBE_URL ? probe() : request()));
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const win: FakeWindow = {
    location: fakeLocation(opts.pathname ?? "/chat"),
    top: null,
    fetch: nativeFetch as unknown as typeof fetch,
    WebSocket: FakeSocket,
  };
  win.top = opts.framedBy ?? win;
  const install = () => new Function("window", "document", controlUiSessionGuardScriptBody({ closeProbeGapMs: GAP_MS }))(win, doc);
  install();
  const probes = () => nativeFetch.mock.calls.filter(([input]) => String(input) === SESSION_PROBE_URL).length;
  return { win, doc, nativeFetch, probes, install };
}

async function flush() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the Control UI's lapsed-session guard", () => {
  it("takes the chat to /login, carrying where it was, when a refused request's session is refused too", async () => {
    const { win, probes } = page({ request: gate401, probe: gate401 });
    const res = await win.fetch("/api/sessions");
    // The page still gets its answer.
    expect(res.status).toBe(401);
    await vi.waitFor(() => expect(win.location.replace).toHaveBeenCalledWith("/login?redirect=%2Fchat"));
    expect(probes()).toBe(1);
  });

  it("leaves the chat alone on a late refusal for a session another tab has already renewed", async () => {
    const { win, probes } = page({ request: gate401, probe: ok });
    await win.fetch("/api/sessions");
    await flush();
    expect(probes()).toBe(1);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("never asks about a route's own 401 or any other answer", async () => {
    const answers = [new Response("{}", { status: 401 }), ok(), new Response("", { status: 403 })];
    const { win, probes } = page({ request: () => answers.shift()! });
    for (let i = 0; i < 3; i++) await win.fetch("/api/x");
    await flush();
    expect(probes()).toBe(0);
  });

  it("takes the chat to /login when the box closes its socket for the session", async () => {
    const { win } = page({ probe: gate401 });
    const ws = new win.WebSocket("ws://clawbox.local");
    ws.closeWith(4401);
    await vi.waitFor(() => expect(win.location.replace).toHaveBeenCalledWith("/login?redirect=%2Fchat"));
  });

  it("asks when a socket is cut with no code — plain HTTP — and when every reconnect is refused, at most once per gap", async () => {
    const { win, probes } = page({ probe: ok });
    const sockets = [0, 1, 2].map(() => new win.WebSocket("ws://clawbox.local"));
    for (const ws of sockets) ws.closeWith(1006);
    await flush();
    expect(probes()).toBe(1);

    await new Promise((r) => setTimeout(r, GAP_MS + 10));
    new win.WebSocket("ws://clawbox.local").closeWith(1006);
    await flush();
    expect(probes()).toBe(2);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("never asks about a socket closed on purpose or by the page going away", async () => {
    const { win, probes } = page({ probe: gate401 });
    new win.WebSocket("ws://clawbox.local").closeWith(1000);
    new win.WebSocket("ws://clawbox.local").closeWith(1001);
    await flush();
    expect(probes()).toBe(0);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("a box that cannot be reached is not a sign-out", async () => {
    const { win, probes } = page({ request: gate401, probe: () => Promise.reject(new TypeError("Failed to fetch")) });
    await win.fetch("/api/sessions");
    new win.WebSocket("ws://clawbox.local").closeWith(4401);
    await flush();
    expect(probes()).toBeGreaterThan(0);
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("sends the standalone app page that frames the chat to /login, not just the frame", async () => {
    const parent = { location: fakeLocation("/app/openclaw") } as unknown as FakeWindow;
    const { win } = page({ probe: gate401, framedBy: parent });
    new win.WebSocket("ws://clawbox.local").closeWith(4401);
    await vi.waitFor(() => expect(parent.location.replace).toHaveBeenCalledWith("/login?redirect=%2Fapp%2Fopenclaw"));
    expect(win.location.replace).not.toHaveBeenCalled();
  });

  it("asks when the tab is shown again, since a page in the background is refused nothing", async () => {
    const { win, doc } = page({ probe: gate401 });
    doc.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(win.location.replace).toHaveBeenCalledWith("/login?redirect=%2Fchat"));
  });

  it("leaves the page's sockets the WebSockets they were", () => {
    const { win } = page();
    const ws = new win.WebSocket("ws://clawbox.local/", ["v1"]);
    expect(ws).toBeInstanceOf(FakeSocket);
    expect(ws.url).toBe("ws://clawbox.local/");
    expect(ws.protocols).toEqual(["v1"]);
    expect(win.WebSocket.OPEN).toBe(1);
    expect(win.WebSocket.CLOSED).toBe(3);
  });

  it("installs once, however many routes inject it", async () => {
    const { win, install, probes } = page({ request: gate401, probe: ok });
    install();
    await win.fetch("/api/sessions");
    await flush();
    expect(probes()).toBe(1);
  });
});
