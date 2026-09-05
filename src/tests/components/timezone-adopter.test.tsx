import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@/tests/helpers/test-utils";
import TimezoneAdopter from "@/components/TimezoneAdopter";

/**
 * TASK-514. The browser is the only thing on the network that knows where the
 * box lives: the server's own `Intl.DateTimeFormat().resolvedOptions()
 * .timeZone` reads the box's OS zone, which is the `Etc/UTC` being fixed.
 */

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

function stubBrowserZone(tz: string): void {
  const real = Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(((...args: unknown[]) => {
    const inst = new (real as unknown as new (...a: unknown[]) => Intl.DateTimeFormat)(...args);
    if (args.length === 0) {
      return { ...inst, resolvedOptions: () => ({ ...inst.resolvedOptions(), timeZone: tz }) } as Intl.DateTimeFormat;
    }
    return inst;
  }) as unknown as typeof Intl.DateTimeFormat);
}

function stubFetch(current: { timezone?: string | null; applied?: boolean; acceptsAdoption?: boolean } | "error") {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, init });
      if (current === "error") throw new Error("offline");
      if (!init || init.method !== "POST") return jsonResponse(current);
      return jsonResponse({ success: true, changed: true, timezone: "Europe/Sofia" });
    }),
  );
  return {
    posts: () => calls.filter((c) => c.init?.method === "POST"),
    all: () => calls,
  };
}

describe("TimezoneAdopter", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("offers the browser's zone to a box that has never been told one", async () => {
    stubBrowserZone("Europe/Sofia");
    const h = stubFetch({ timezone: null, applied: false, acceptsAdoption: true });

    render(<TimezoneAdopter />);

    await waitFor(() => expect(h.posts()).toHaveLength(1));
    expect(JSON.parse(String(h.posts()[0].init?.body))).toEqual({
      timezone: "Europe/Sofia",
      adopt: true,
    });
  });

  it("leaves a zone the owner CHOSE alone", async () => {
    // An explicit choice is never overwritten by whoever opens the dashboard
    // next; the server enforces the same rule again.
    stubBrowserZone("America/New_York");
    const h = stubFetch({ timezone: "Europe/Sofia", applied: true, acceptsAdoption: false });

    render(<TimezoneAdopter />);

    await waitFor(() => expect(h.all().length).toBeGreaterThan(0));
    expect(h.posts()).toHaveLength(0);
  });

  it("says nothing more when the box already has this zone and it landed", async () => {
    stubBrowserZone("Europe/Sofia");
    const h = stubFetch({ timezone: "Europe/Sofia", applied: true, acceptsAdoption: true });

    render(<TimezoneAdopter />);

    await waitFor(() => expect(h.all().length).toBeGreaterThan(0));
    expect(h.posts()).toHaveLength(0);
  });

  it("offers again when the zone is recorded but never landed on the harness", async () => {
    // The false success the applied marker exists for: `openclaw config set`
    // wants 10-12 s on a Jetson and can fail while the gateway is still coming
    // up, which is exactly when a first desktop load fires this.
    stubBrowserZone("Europe/Sofia");
    const h = stubFetch({ timezone: "Europe/Sofia", applied: false, acceptsAdoption: true });

    render(<TimezoneAdopter />);

    await waitFor(() => expect(h.posts()).toHaveLength(1));
  });

  it("does not stamp 'answered' over a browser that is itself in UTC", async () => {
    stubBrowserZone("UTC");
    const h = stubFetch({ timezone: null, applied: false, acceptsAdoption: true });

    render(<TimezoneAdopter />);

    await new Promise((r) => setTimeout(r, 20));
    expect(h.all()).toHaveLength(0);
  });

  it("says nothing to the owner when the box cannot be reached", async () => {
    stubBrowserZone("Europe/Sofia");
    const h = stubFetch("error");

    const { container } = render(<TimezoneAdopter />);

    await waitFor(() => expect(h.all().length).toBeGreaterThan(0));
    expect(container.textContent).toBe("");
  });
});
