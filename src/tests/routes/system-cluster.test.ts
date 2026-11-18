import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * GET /setup-api/system/cluster (TASK-2670) — the cluster view's API.
 *
 * REAL sessions: a signed cookie for the owner and one for a staff user, checked
 * by the real `requireSession` against a throwaway CLAWBOX_ROOT. Only the Sparks
 * are scripted (the runner), because a test must not ssh anywhere.
 */

const SECRET = "test-session-secret-0123456789abcdef";
const STAFF_SV = "a1b2c3d4e5f60718";

const GOOD = (host: string) => [
  `CBX host ${host}`,
  "CBX cpu1 cpu  1000 0 500 8000 100 0 0 0",
  "CBX cpu2 cpu  1100 0 550 8050 100 0 0 0",
  "CBX mem MemTotal: 125829120 kB",
  "CBX mem MemAvailable: 25165824 kB",
  "CBX gpu NVIDIA GB10, 5, 44, [N/A], [N/A]",
  "CBX disk /dev/nvme0n1p2 976762584 488381292 488381292 50% /",
  "CBX end",
  "",
].join("\n");

function sign(claims: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600, gen: 0, ...claims })).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(payload).digest("hex");
  return `${payload}.${sig}`;
}

const owner = () => sign({});
const staff = () => sign({ u: "alice", sv: STAFF_SV });

function request(cookie?: string, query = ""): Request {
  return new Request(`http://localhost/setup-api/system/cluster${query}`, {
    headers: cookie ? { cookie: `clawbox_session=${cookie}` } : {},
  });
}

type Runner = (command: string, args: string[], input: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

describe("GET /setup-api/system/cluster", () => {
  let root: string;
  const saved = { root: process.env.CLAWBOX_ROOT, user: process.env.CLAWBOX_USER, secret: process.env.SESSION_SECRET, test: process.env.CLAWBOX_TEST_MODE };

  async function load(run: Runner, options: { workstation?: boolean; env?: Record<string, string> } = {}) {
    const route = await import("@/app/setup-api/system/cluster/route");
    const view = await import("@/lib/cluster-view");
    view._resetClusterForTest();
    // Tracked apart from the Sparks' runner, so a request that reads the engine
    // but no Spark cannot pass for one that reads nothing.
    const readEngine = vi.fn(async () => null);
    view._setClusterDepsForTest({
      env: { CLAWBOX_CLUSTER_PEERS: "spark-b spark-c spark-d", ...(options.env ?? {}) } as unknown as NodeJS.ProcessEnv,
      isWorkstation: () => options.workstation ?? true,
      readEngine,
      run,
    });
    return { GET: route.GET, readEngine };
  }

  beforeEach(() => {
    vi.resetModules();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-cluster-route-"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", ".session-secret"), SECRET, { mode: 0o600 });
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({
        password_configured: true,
        setup_complete: true,
        session_generation: 0,
        clawbox_users: [{ username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: STAFF_SV }],
      }),
    );
    process.env.CLAWBOX_ROOT = root;
    process.env.CLAWBOX_USER = "clawbox";
    delete process.env.SESSION_SECRET;
    delete process.env.CLAWBOX_TEST_MODE;
  });

  afterEach(async () => {
    const view = await import("@/lib/cluster-view");
    view._resetClusterForTest();
    for (const [key, value] of [["CLAWBOX_ROOT", saved.root], ["CLAWBOX_USER", saved.user], ["SESSION_SECRET", saved.secret], ["CLAWBOX_TEST_MODE", saved.test]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const allUp: Runner = vi.fn(async (command, args) => ({
    code: 0,
    stdout: GOOD(command === "ssh" ? args[args.indexOf("--") + 1] : "spark-a"),
    stderr: "",
    timedOut: false,
  }));

  describe("who may ask", () => {
    it("answers the owner with the whole cluster", async () => {
      const run = vi.fn(allUp);
      const { GET, readEngine } = await load(run);
      const res = await GET(request(owner()));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = await res.json();
      expect(body.enabled).toBe(true);
      expect(body.sparks.map((s: { hostname: string }) => s.hostname)).toEqual(["spark-a", "spark-b", "spark-c", "spark-d"]);
      expect(body.engine).toEqual({ configured: false });
      expect(run).toHaveBeenCalledTimes(4);
      expect(readEngine).toHaveBeenCalledTimes(1);
    });

    it("answers a staff user 403 owner_only — and reads nothing: no ssh, no engine request", async () => {
      const run = vi.fn(allUp);
      const { GET, readEngine } = await load(run);
      for (const query of ["", "?availability=1"]) {
        const res = await GET(request(staff(), query));
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ code: "owner_only" });
      }
      expect(run).not.toHaveBeenCalled();
      expect(readEngine).not.toHaveBeenCalled();
    });

    it("answers 401 (not 403, which would read as 'signed in') to a request with no session, and reads nothing", async () => {
      const run = vi.fn(allUp);
      const { GET, readEngine } = await load(run);
      expect((await GET(request())).status).toBe(401);
      expect((await GET(request("not-a-cookie"))).status).toBe(401);
      expect((await GET(request(sign({ exp: 1 })))).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
      expect(readEngine).not.toHaveBeenCalled();
    });

    it("refuses a staff user who was removed since they signed in", async () => {
      fs.writeFileSync(
        path.join(root, "data", "config.json"),
        JSON.stringify({ password_configured: true, setup_complete: true, session_generation: 0, clawbox_users: [] }),
      );
      const run = vi.fn(allUp);
      const { GET } = await load(run);
      expect((await GET(request(staff()))).status).toBe(401);
      expect(run).not.toHaveBeenCalled();
    });
  });

  describe("where there is no cluster", () => {
    it("tells the owner `enabled: false` on a box that is not a Workstation — 200, not an error — and reads nothing", async () => {
      const run = vi.fn(allUp);
      const { GET, readEngine } = await load(run, { workstation: false });
      const res = await GET(request(owner()));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ enabled: false });
      expect(run).not.toHaveBeenCalled();
      expect(readEngine).not.toHaveBeenCalled();
    });

    it("tells the owner `enabled: false` on a Workstation with no peers configured", async () => {
      const run = vi.fn(allUp);
      const { GET, readEngine } = await load(run, { env: { CLAWBOX_CLUSTER_PEERS: "" } });
      expect(await (await GET(request(owner()))).json()).toEqual({ enabled: false });
      expect(run).not.toHaveBeenCalled();
      expect(readEngine).not.toHaveBeenCalled();
    });

    it("answers the availability question alone, without reading a thing", async () => {
      const run = vi.fn(allUp);
      const { GET, readEngine } = await load(run);
      expect(await (await GET(request(owner(), "?availability=1"))).json()).toEqual({ enabled: true });
      expect(run).not.toHaveBeenCalled();
      expect(readEngine).not.toHaveBeenCalled();
      const off = await load(run, { workstation: false });
      expect(await (await off.GET(request(owner(), "?availability=1"))).json()).toEqual({ enabled: false });
      expect(off.readEngine).not.toHaveBeenCalled();
    });
  });

  describe("when a Spark is down", () => {
    it("still answers 200 at once, with the Sparks that are down marked offline and the reason", async () => {
      const run: Runner = vi.fn(async (command, args) => {
        const target = command === "ssh" ? args[args.indexOf("--") + 1] : "local";
        if (target === "spark-c") return { code: 255, stdout: "", stderr: "ssh: connect to host spark-c port 22: No route to host", timedOut: false };
        if (target === "spark-d") return { code: 255, stdout: "", stderr: "spark-d: Permission denied (publickey).", timedOut: false };
        return { code: 0, stdout: GOOD(target === "local" ? "spark-a" : target), stderr: "", timedOut: false };
      });
      const { GET } = await load(run);
      const started = Date.now();
      const res = await GET(request(owner()));
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.sparks.map((s: { online: boolean }) => s.online)).toEqual([true, true, false, false]);
      expect(body.sparks[2]).toMatchObject({ hostname: "spark-c", failure: "unreachable" });
      expect(body.sparks[3]).toMatchObject({ hostname: "spark-d", failure: "auth" });
      expect(body.sparks[2].figures).toBeUndefined();
    });

    it("does not hang on peers that never answer: it ends at the ssh ceiling and says timeout", async () => {
      const { runScript } = await import("@/lib/cluster-view");
      const run: Runner = vi.fn(async (command, args, input) => {
        if (command !== "ssh") return { code: 0, stdout: GOOD("spark-a"), stderr: "", timedOut: false };
        // A peer that accepts the connection and then says nothing, with the
        // real runner's ceiling shortened for the test.
        void args;
        void input;
        return runScript("sh", ["-c", "sleep 30"], "", 400);
      });
      const { GET } = await load(run);
      const started = Date.now();
      const res = await GET(request(owner()));
      const elapsed = Date.now() - started;
      expect(res.status).toBe(200);
      expect(elapsed).toBeLessThan(5_000);
      const body = await res.json();
      expect(body.sparks[0].online).toBe(true);
      expect(body.sparks.slice(1).map((s: { failure: string }) => s.failure)).toEqual(["timeout", "timeout", "timeout"]);
    });

    it("answers a second poll from memory: one more request does not ssh again", async () => {
      const run = vi.fn(allUp);
      const { GET } = await load(run);
      await GET(request(owner()));
      await GET(request(owner()));
      await GET(request(owner()));
      expect(run).toHaveBeenCalledTimes(4);
    });
  });
});
