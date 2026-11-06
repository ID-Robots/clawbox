import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@/tests/helpers/test-utils";
import UpdatingPage from "@/app/updating/page";
import { SESSION_PROBE_URL, sessionExpiredHeaders } from "@/lib/session-expiry";

// The update screen and a session that runs out while it is up. Its status
// poll reads every failure as "the rebuild stopped the server" and holds the
// screen, so a lapsed session kept the owner on it for ever, every poll
// answered 401. It now leaves for /login like the desktop — and still holds
// through a server that is simply down.

vi.mock("@/lib/i18n", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n")>()),
  I18nProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const gate401 = () => new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers: sessionExpiredHeaders() });
const running = () => new Response(JSON.stringify({ phase: "running", steps: [] }), { status: 200, headers: { "content-type": "application/json" } });

let replace: ReturnType<typeof vi.fn>;
let savedLocation: PropertyDescriptor | undefined;

beforeEach(() => {
  savedLocation = Object.getOwnPropertyDescriptor(window, "location");
  const real = window.location;
  replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { href: `${real.origin}/updating`, origin: real.origin, pathname: "/updating", search: "", hash: "", replace, assign: vi.fn(), reload: vi.fn() },
  });
});

afterEach(() => {
  if (savedLocation) Object.defineProperty(window, "location", savedLocation);
  vi.unstubAllGlobals();
});

/** Every request the screen makes, answered by `status` for the poll and `probe` for the session probe. */
function stubBox(status: () => Response | Promise<Response>, probe: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/setup-api/update/status")) return status();
    if (url === SESSION_PROBE_URL) return probe();
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

describe("the update screen on a lapsed session", () => {
  it("goes to /login, carrying where it was, when its very first status poll is refused by the session gate", async () => {
    stubBox(gate401, gate401);
    render(<UpdatingPage />);
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/login?redirect=%2Fupdating"));
  });

  it("stays while the server is down, which is what an update does", async () => {
    const fetchMock = stubBox(() => Promise.reject(new TypeError("Failed to fetch")), gate401);
    render(<UpdatingPage />);
    await settle();
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/setup-api/update/status"))).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });

  it("stays on a late refusal for a session that is good again", async () => {
    const answers = [gate401(), running()];
    stubBox(() => answers.shift() ?? running(), () => new Response("{}", { status: 200 }));
    render(<UpdatingPage />);
    await settle();
    expect(replace).not.toHaveBeenCalled();
  });
});
