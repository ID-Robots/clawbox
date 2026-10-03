import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * /setup-api/setup/edition — the first-setup wizard's "Choose your assistant"
 * on a unified-image box (TASK-1149).
 *
 * Pinned here: GET's answer for every lock the fleet can have (only
 * `unselected`, or a cut-short activation, ever asks); POST's refusals — 409
 * on every box whose edition is fixed and once setup is complete, so the route
 * is never a free swap — none of which stages a request or starts the step;
 * the request's bytes; the stream's phases and closing line; what a failure
 * before and after the lock flipped closes with; and the in-flight slot.
 *
 * The lock is a REAL file in a temp dir (CLAWBOX_EDITION_FILE), rewritten by
 * the follow mock the way the root step rewrites it. Every 200 is drained
 * before its test ends, for the reason harness-swap.test.ts gives.
 */

const h = vi.hoisted(() => ({
  session: vi.fn<(req: Request, opts?: unknown) => Promise<Response | null>>(async () => null),
  setupComplete: false,
  sameOrigin: vi.fn(() => true),
  updateLocked: vi.fn(async () => false),
  follow: vi.fn<(step: string, opts: { onStatus: (line: string) => void; label: string; timeoutMs: number }) => Promise<{ ok: boolean; error?: string }>>(
    async () => ({ ok: true }),
  ),
  unitState: "ActiveState=inactive\n",
  journal: [] as string[],
}));

vi.mock("@/lib/route-auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/route-auth")>()),
  requireSession: h.session,
  readSetupGateFacts: () => ({ setupComplete: h.setupComplete, passwordConfigured: false }),
}));
vi.mock("@/lib/same-origin", () => ({ isSameOriginRequest: h.sameOrigin }));
vi.mock("@/lib/update-lock", () => ({ isUpdateLocked: h.updateLocked }));
vi.mock("@/lib/root-step-follow", async (orig) => ({
  ...(await orig<typeof import("@/lib/root-step-follow")>()),
  followRootStep: h.follow,
}));
vi.mock("child_process", async (orig) => {
  const actual = await orig<typeof import("child_process")>();
  const run = async (cmd: string, args: string[]) => {
    if (cmd.endsWith("journalctl")) return { stdout: `${h.journal.join("\n")}\n`, stderr: "" };
    if (args.includes("ActiveState")) return { stdout: h.unitState, stderr: "" };
    return { stdout: "", stderr: "" };
  };
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: run }) };
});

const TEST_DIR = path.join(os.tmpdir(), `clawbox-setup-edition-route-${process.pid}-${Date.now()}`);
const LOCK = path.join(TEST_DIR, "etc", "edition.env");
const PENDING = path.join(TEST_DIR, "etc", "edition-select.pending");
const ROOT = path.join(TEST_DIR, "clawbox");
const REQUEST = path.join(ROOT, "data", "edition-select.env");

let restoreEnv: () => void;
let route: typeof import("@/app/setup-api/setup/edition/route");
let lib: typeof import("@/lib/edition-select");
let mtime = 1_700_000_000;

/** Rewrite the lock with a fresh mtime, so the reader's mtime cache sees it. */
function writeLock(body: string): void {
  fs.writeFileSync(LOCK, body);
  mtime += 10;
  fs.utimesSync(LOCK, mtime, mtime);
}

beforeAll(async () => {
  restoreEnv = saveEnv("CLAWBOX_ROOT", "CLAWBOX_EDITION_FILE", "CLAWBOX_EDITION");
  process.env.CLAWBOX_ROOT = ROOT;
  process.env.CLAWBOX_EDITION_FILE = LOCK;
  delete process.env.CLAWBOX_EDITION;
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.mkdirSync(path.dirname(REQUEST), { recursive: true });
  vi.resetModules();
  route = await import("@/app/setup-api/setup/edition/route");
  lib = await import("@/lib/edition-select");
});

afterAll(() => {
  restoreEnv();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  lib._resetEditionSelectForTests();
  writeLock("CLAWBOX_EDITION=unselected\n");
  fs.rmSync(PENDING, { force: true });
  h.setupComplete = false;
  h.unitState = "ActiveState=inactive\n";
  h.journal = [];
  h.session.mockReset().mockResolvedValue(null);
  h.sameOrigin.mockReset().mockReturnValue(true);
  h.updateLocked.mockReset().mockResolvedValue(false);
  h.follow.mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  fs.rmSync(REQUEST, { force: true });
});

function get(): Request {
  return new Request("http://box/setup-api/setup/edition");
}

function post(body: unknown, raw = false): Request {
  return new Request("http://box/setup-api/setup/edition", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw ? (body as string) : JSON.stringify(body),
  });
}

async function lines(res: Response): Promise<Record<string, unknown>[]> {
  return (await res.text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** The follow plays the root step: phases on the journal, then the lock flips and the marker comes off. */
function stepLandsOn(target: "openclaw" | "hermes", journal: string[] = []) {
  h.follow.mockImplementation(async (_step, opts) => {
    for (const line of journal) opts.onStatus(line);
    writeLock(`CLAWBOX_EDITION=${target}\n`);
    fs.rmSync(PENDING, { force: true });
    return { ok: true };
  });
}

async function expectRefusal(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const body = await res.json();
  expect(body.code).toBe(code);
  expect(typeof body.error).toBe("string");
  expect(h.follow).not.toHaveBeenCalled();
  expect(fs.existsSync(REQUEST)).toBe(false);
}

describe("GET /setup-api/setup/edition", () => {
  it("asks on an unselected box, with the order hint and the server's start time", async () => {
    writeLock("CLAWBOX_EDITION=unselected\nCLAWBOX_EDITION_HINT=hermes\n");
    const res = await route.GET(get());
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toMatchObject({
      needed: true,
      unselected: true,
      pending: null,
      edition: null,
      hint: "hermes",
      inProgress: false,
      inProgressTarget: null,
    });
    expect(typeof body.serverStartedAt).toBe("number");
  });

  it.each(["openclaw", "hermes", "dual"])("never asks a box locked to %s", async (edition) => {
    writeLock(`CLAWBOX_EDITION=${edition}\n`);
    const body = await (await route.GET(get())).json();
    expect(body).toMatchObject({ needed: false, unselected: false, edition, hint: null });
  });

  it("asks again to finish an activation that was cut short", async () => {
    writeLock("CLAWBOX_EDITION=hermes\n");
    fs.writeFileSync(PENDING, "TARGET_EDITION=hermes\n");
    const body = await (await route.GET(get())).json();
    expect(body).toMatchObject({ needed: true, unselected: false, pending: "hermes" });
  });

  it("reports a running step it did not start, from the unit and the request", async () => {
    h.unitState = "ActiveState=active\n";
    await lib.writeEditionSelectRequest("openclaw");
    const body = await (await route.GET(get())).json();
    expect(body).toMatchObject({ inProgress: true, inProgressTarget: "openclaw" });
  });

  it("answers whatever the session gate answers", async () => {
    h.session.mockResolvedValueOnce(new Response("no", { status: 401 }));
    expect((await route.GET(get())).status).toBe(401);
    expect(h.session).toHaveBeenCalledWith(expect.any(Request), { allowBootstrap: true });
  });
});

describe("POST /setup-api/setup/edition — refusals", () => {
  it("is behind the bootstrap-aware session gate", async () => {
    h.session.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const res = await route.POST(post({ edition: "hermes" }));
    expect(res.status).toBe(401);
    expect(h.session).toHaveBeenCalledWith(expect.any(Request), { allowBootstrap: true });
    expect(h.follow).not.toHaveBeenCalled();
  });

  it("refuses another site's page", async () => {
    h.sameOrigin.mockReturnValue(false);
    await expectRefusal(await route.POST(post({ edition: "hermes" })), 403, "cross_origin");
  });

  it.each([
    [{ edition: "dual" }],
    [{ edition: "unselected" }],
    [{ edition: "Hermes" }],
    [{}],
    [[]],
    ["not json"],
  ])("refuses the body %j", async (body) => {
    const res = await route.POST(post(body, typeof body === "string"));
    await expectRefusal(res, 400, "bad_body");
  });

  it.each(["openclaw", "hermes", "dual"])("answers 409 on a box locked to %s — never a free swap", async (edition) => {
    writeLock(`CLAWBOX_EDITION=${edition}\n`);
    for (const target of ["openclaw", "hermes"]) {
      await expectRefusal(await route.POST(post({ edition: target })), 409, "already_chosen");
    }
  });

  it("answers 409 once setup is complete, whatever the lock says", async () => {
    h.setupComplete = true;
    await expectRefusal(await route.POST(post({ edition: "hermes" })), 409, "setup_complete");
  });

  it("will only FINISH a cut-short activation for the agent it locked", async () => {
    writeLock("CLAWBOX_EDITION=hermes\n");
    fs.writeFileSync(PENDING, "TARGET_EDITION=hermes\n");
    await expectRefusal(await route.POST(post({ edition: "openclaw" })), 409, "pending_other");
  });

  it("waits for an update that owns the box", async () => {
    h.updateLocked.mockResolvedValue(true);
    await expectRefusal(await route.POST(post({ edition: "hermes" })), 409, "update_in_progress");
  });

  it("does not start a second activation over a running one", async () => {
    h.unitState = "ActiveState=activating\n";
    await expectRefusal(await route.POST(post({ edition: "hermes" })), 409, "busy");
  });
});

describe("POST /setup-api/setup/edition — the activation", () => {
  it("writes the request, follows edition_select, and closes on success with a restart", async () => {
    stepLandsOn("hermes", ["[edition-select] phase=check", "  -> install.sh --step edition_lock", "[edition-select] phase=cleanup"]);
    const res = await route.POST(post({ edition: "hermes" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const out = await lines(res);

    expect(h.follow).toHaveBeenCalledTimes(1);
    const [step, opts] = h.follow.mock.calls[0];
    expect(step).toBe("edition_select");
    expect(opts.timeoutMs).toBe(lib.SELECT_FOLLOW_TIMEOUT_MS);
    expect(out.filter((l) => "phase" in l).map((l) => l.phase)).toEqual([
      "request", "check", "lock", "provision", "cleanup", "done",
    ]);
    expect(out.at(-1)).toEqual({ success: true, edition: "hermes", restarting: true });
  });

  it("hands the step exactly the request the root reader accepts", async () => {
    let seen = "";
    h.follow.mockImplementation(async () => {
      seen = fs.readFileSync(REQUEST, "utf-8");
      writeLock("CLAWBOX_EDITION=openclaw\n");
      return { ok: true };
    });
    await lines(await route.POST(post({ edition: "openclaw" })));
    expect(seen).toMatch(/^TARGET_EDITION=openclaw\nREQUESTED_AT=\d{10}\n$/);
  });

  it("closes a failure BEFORE the lock flipped as 'still undecided' — choose again", async () => {
    h.follow.mockResolvedValue({ ok: false, error: "Error: the check phase failed — Hermes does not run on this box" });
    const out = await lines(await route.POST(post({ edition: "hermes" })));
    expect(out.at(-1)).toEqual({
      error: "Error: the check phase failed — Hermes does not run on this box",
      code: "select_failed",
      unselected: true,
      pending: null,
    });
    // The route removes a request the step did not consume.
    expect(fs.existsSync(REQUEST)).toBe(false);
  });

  it("closes a failure AFTER the lock flipped with the agent to finish", async () => {
    h.follow.mockImplementation(async () => {
      writeLock("CLAWBOX_EDITION=hermes\n");
      fs.writeFileSync(PENDING, "TARGET_EDITION=hermes\n");
      return { ok: false, error: "Error: the provision phase failed — the Hermes provisioning step did not finish." };
    });
    const out = await lines(await route.POST(post({ edition: "hermes" })));
    expect(out.at(-1)).toMatchObject({ code: "select_failed", unselected: false, pending: "hermes" });
    // …which the same POST can now finish.
    stepLandsOn("hermes");
    const again = await lines(await route.POST(post({ edition: "hermes" })));
    expect(again.at(-1)).toEqual({ success: true, edition: "hermes", restarting: true });
  });

  it("never dresses a step that exited 0 without flipping the lock as done", async () => {
    h.follow.mockResolvedValue({ ok: true });
    const out = await lines(await route.POST(post({ edition: "hermes" })));
    expect(out.at(-1)).toMatchObject({ code: "lock_unchanged", unselected: true });
    expect(out.some((l) => l.success)).toBe(false);
  });

  it("reports a lock that flipped but a marker that stayed as unfinished", async () => {
    h.follow.mockImplementation(async () => {
      writeLock("CLAWBOX_EDITION=openclaw\n");
      fs.writeFileSync(PENDING, "TARGET_EDITION=openclaw\n");
      return { ok: true };
    });
    const out = await lines(await route.POST(post({ edition: "openclaw" })));
    expect(out.at(-1)).toMatchObject({ code: "select_incomplete", pending: "openclaw" });
  });

  it("leaves a step that outlives the follow to the unit, request and all", async () => {
    h.follow.mockImplementation(async () => {
      h.unitState = "ActiveState=active\n";
      return { ok: false, error: "Timed out" };
    });
    const out = await lines(await route.POST(post({ edition: "hermes" })));
    expect(out.at(-1)).toMatchObject({ code: "still_running" });
    expect(fs.existsSync(REQUEST)).toBe(true);
  });

  it("releases the slot on every path", async () => {
    h.follow.mockResolvedValue({ ok: false, error: "nope" });
    await lines(await route.POST(post({ edition: "hermes" })));
    stepLandsOn("hermes");
    const out = await lines(await route.POST(post({ edition: "hermes" })));
    expect(out.at(-1)).toMatchObject({ success: true });
  });
});
