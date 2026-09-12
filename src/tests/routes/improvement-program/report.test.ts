/**
 * /setup-api/improvement-program/report — the submit half.
 *
 * Deliberately NOT owner-only: `ask` mode exists precisely so the agent can
 * submit on the owner's yes. What keeps that safe is that the id names a
 * record whose text was sanitized when it was captured, the body template is
 * fixed, and every rule — the mode above all — lives in `incident-report.ts`
 * rather than in whichever surface happened to call.
 *
 * So this file pins the mapping the caller branches on: which refusal is a
 * "never" (409), which is a "not today" (429), and which is a "try later" (503).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reportIncident = vi.hoisted(() => vi.fn());
vi.mock("@/lib/incident-report", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/incident-report")>()),
  reportIncident,
}));

let route: typeof import("@/app/setup-api/improvement-program/report/route");

function request(body: unknown, raw?: string, headers: Record<string, string> = {}): Request {
  return new Request("http://clawbox.local/setup-api/improvement-program/report", {
    method: "POST",
    headers: { "content-type": "application/json", host: "clawbox.local", ...headers },
    body: raw ?? JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  route = await import("@/app/setup-api/improvement-program/report/route");
});

afterEach(() => vi.clearAllMocks());

describe("where a report may be asked for", () => {
  /**
   * Dropping the OWNER gate is not the same as dropping the ORIGIN gate, and
   * conflating them was a hole: the owner's browser attaches its session cookie
   * to a POST any other site fires at the box, so a cross-site page could
   * publish an incident to a PUBLIC tracker without the per-incident consent
   * this route's whole design rests on.
   */
  it.each([
    ["another site's page", { origin: "http://evil.example" }],
    ["a sandboxed frame's opaque origin", { origin: "null" }],
    ["a browser that says cross-site", { "sec-fetch-site": "cross-site" }],
    ["a sibling host", { "sec-fetch-site": "same-site" }],
  ])("refuses %s before anything is parsed", async (_name, headers) => {
    const res = await route.POST(request({ id: "inc-abc" }, undefined, headers));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it("allows this box's own page", async () => {
    reportIncident.mockResolvedValue({ ok: true, action: "created", issueNumber: 1 });
    const res = await route.POST(request({ id: "inc-abc" }, undefined, { origin: "http://clawbox.local" }));
    expect(res.status).toBe(200);
  });

  it("allows the agent, which sends neither header — that is what ask mode IS", async () => {
    reportIncident.mockResolvedValue({ ok: true, action: "created", issueNumber: 1 });
    const res = await route.POST(request({ id: "inc-abc" }));
    expect(res.status).toBe(200);
    expect(reportIncident).toHaveBeenCalledWith("inc-abc");
  });
});

describe("a report that goes out", () => {
  it("answers the issue it became", async () => {
    reportIncident.mockResolvedValue({ ok: true, action: "created", issueNumber: 912, url: "https://github.com/ID-Robots/clawbox/issues/912" });
    const res = await route.POST(request({ id: "inc-abc" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true, action: "created", issueNumber: 912, url: "https://github.com/ID-Robots/clawbox/issues/912",
    });
    expect(reportIncident).toHaveBeenCalledWith("inc-abc");
  });

  it("distinguishes a comment on a known fault from a new issue", async () => {
    reportIncident.mockResolvedValue({ ok: true, action: "commented", issueNumber: 404 });
    const body = await (await route.POST(request({ id: "inc-abc" }))).json();
    expect(body).toEqual({ ok: true, action: "commented", issueNumber: 404 });
  });
});

describe("the refusals, and what each one means to a caller", () => {
  it.each([
    ["off", 409],
    ["no_github", 409],
    ["not_found", 404],
    ["rate_limited", 429],
    ["search_failed", 503],
    ["gh_failed", 503],
  ] as const)("maps %s to %i", async (code, status) => {
    reportIncident.mockResolvedValue({ ok: false, code, detail: "a sentence about it" });
    const res = await route.POST(request({ id: "inc-abc" }));
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ ok: false, code, error: "a sentence about it" });
  });

  it("refuses while the programme is off — the same answer for every caller", async () => {
    reportIncident.mockResolvedValue({ ok: false, code: "off", detail: "switched off" });
    const res = await route.POST(request({ id: "inc-abc" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("off");
  });
});

describe("the body", () => {
  it.each([
    ["no id", {}],
    ["an empty id", { id: "   " }],
    ["a non-string id", { id: 7 }],
  ])("refuses %s before anything is sent", async (_name, body) => {
    const res = await route.POST(request(body));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("malformed");
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it("refuses something that is not JSON", async () => {
    const res = await route.POST(request(null, "not json"));
    expect(res.status).toBe(400);
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it.each([
    ["a newline, which would forge a log entry", "inc-abc\nreported as issue #1"],
    ["a carriage return", "inc-abc\rinjected"],
    ["a path segment", "../../etc/passwd"],
    ["an id that is not the shape the store mints", "incident-abc"],
    ["an over-long id", `inc-${"a".repeat(40)}`],
  ])("refuses %s before anything is looked up or logged", async (_name, id) => {
    const res = await route.POST(request({ id }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("malformed");
    expect(reportIncident).not.toHaveBeenCalled();
  });

  it("trims the id rather than passing whitespace through", async () => {
    reportIncident.mockResolvedValue({ ok: true, action: "created", issueNumber: 1 });
    await route.POST(request({ id: "  inc-abc  " }));
    expect(reportIncident).toHaveBeenCalledWith("inc-abc");
  });
});
