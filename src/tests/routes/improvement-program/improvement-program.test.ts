/**
 * /setup-api/improvement-program — the owner's switch, and what the agent may
 * and may not do with it.
 *
 * The property under test is the asymmetry: the READ is open to the MCP bearer
 * (the agent is its intended caller, and everything in the answer was
 * sanitized before it was written), while the WRITE refuses that bearer and
 * any other origin — opting a box into publishing its diagnostics is a consent
 * a tool must not be able to grant itself.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionCookie } from "@/lib/auth";
import { saveEnv } from "@/tests/helpers/env";

const SESSION_SECRET = "a".repeat(64);
const BEARER = "a-valid-looking-device-token";

const githubStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/coding-github", () => ({ githubStatus }));

let root: string;
let restore: () => void;
let route: typeof import("@/app/setup-api/improvement-program/route");
let store: typeof import("@/lib/incidents");

function ownerCookie(): string {
  return `clawbox_session=${createSessionCookie(3600, SESSION_SECRET, 0)}`;
}

function request(init: {
  method?: string; cookie?: string; bearer?: string; body?: unknown; raw?: string; origin?: string | null;
} = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", host: "clawbox.local" };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.origin !== null) headers.origin = init.origin ?? "http://clawbox.local";
  const method = init.method ?? "GET";
  return new Request("http://clawbox.local/setup-api/improvement-program", {
    method,
    headers,
    ...(method === "GET" ? {} : { body: init.raw ?? JSON.stringify(init.body ?? { mode: "ask" }) }),
  });
}

beforeEach(async () => {
  restore = saveEnv("SESSION_SECRET", "CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-ip-route-"));
  process.env.CLAWBOX_ROOT = root;
  process.env.SESSION_SECRET = SESSION_SECRET;
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  vi.resetModules();
  vi.clearAllMocks();
  githubStatus.mockResolvedValue({ installed: true, connected: true, login: "ada", loginCommand: "gh auth login" });
  store = await import("@/lib/incidents");
  route = await import("@/app/setup-api/improvement-program/route");
});

afterEach(() => {
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET", () => {
  it("answers off on a box nobody has asked", async () => {
    const res = await route.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe("off");
    expect(body.pending).toBe(0);
    expect(body.repo).toBe("ID-Robots/clawbox");
    expect(body.maxIssuesPerDay).toBe(5);
  });

  it("counts what is waiting and what has been filed", async () => {
    const a = await store.recordIncident({ source: "update", message: "one" });
    await store.recordIncident({ source: "update", message: "two" });
    store.markReported(a!.id, 12);
    const body = await (await route.GET()).json();
    expect(body.pending).toBe(1);
    expect(body.reported).toBe(1);
    expect(body.total).toBe(2);
  });

  it("carries the GitHub state so the card can say 'connect GitHub'", async () => {
    githubStatus.mockResolvedValue({ installed: false, connected: false, login: null, loginCommand: "x" });
    const body = await (await route.GET()).json();
    expect(body.github).toEqual({ installed: false, connected: false, login: null });
  });

  it("still answers when the GitHub probe throws — a queue is worth showing either way", async () => {
    githubStatus.mockRejectedValue(new Error("gh exploded"));
    const res = await route.GET();
    expect(res.status).toBe(200);
    expect((await res.json()).github.connected).toBe(false);
  });

  it("hands out only what was already sanitized on the way in", async () => {
    await store.recordIncident({
      source: "clawbox",
      message: "auth failed with claw_abcdef1234567890 for ada@example.org",
      stack: "Error: x\n    at run (/home/ada/clawbox/src/lib/a.ts:1:1)",
    });
    const text = JSON.stringify(await (await route.GET()).json());
    expect(text).not.toContain("claw_abcdef1234567890");
    expect(text).not.toContain("ada@example.org");
    expect(text).not.toContain("/home/ada");
  });
});

describe("POST — who may change the mode", () => {
  it("refuses the MCP bearer: a tool must not be able to opt the box in", async () => {
    const res = await route.POST(request({ method: "POST", bearer: BEARER, body: { mode: "auto" } }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("owner_only");
    expect(await store.getImprovementMode()).toBe("off");
  });

  it("refuses a request with no credential with the same answer", async () => {
    const bare = await route.POST(request({ method: "POST" }));
    const bearer = await route.POST(request({ method: "POST", bearer: BEARER }));
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual(await bearer.json());
  });

  it("refuses a forged cookie", async () => {
    const cookie = `clawbox_session=${createSessionCookie(3600, "b".repeat(64), 0)}`;
    expect((await route.POST(request({ method: "POST", cookie }))).status).toBe(403);
  });

  it("refuses the owner's own cookie from another origin", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), origin: "http://evil.example" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
    expect(await store.getImprovementMode()).toBe("off");
  });

  it("refuses a sandboxed frame's opaque origin", async () => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), origin: "null" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("cross_origin");
  });
});

describe("POST — the mode itself", () => {
  it.each(["off", "ask", "auto"] as const)("stores %s and answers the re-read state", async (mode) => {
    const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body: { mode } }));
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe(mode);
    expect(await store.getImprovementMode()).toBe(mode);
  });

  it("refuses a value that is not one of the three", async () => {
    for (const body of [{ mode: "everything" }, { mode: true }, {}, { mode: "ON" }]) {
      const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), body }));
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe("malformed");
    }
    expect(await store.getImprovementMode()).toBe("off");
  });

  it("refuses a body that is not JSON, and one that is a bare scalar", async () => {
    for (const raw of ["not json", '"a string"', "[]"]) {
      const res = await route.POST(request({ method: "POST", cookie: ownerCookie(), raw }));
      expect(res.status).toBe(400);
    }
  });
});
