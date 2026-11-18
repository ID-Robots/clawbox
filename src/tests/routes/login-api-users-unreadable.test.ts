import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { saveEnv } from "@/tests/helpers/env";

/**
 * GET /login-api/users when data/config.json is THERE but cannot be read
 * (TASK-2435): the users are known (another reader got them), the org switch
 * is not — and an unknown switch must list nobody, since the box may be an
 * organisation's. The real config-store and org-mode reader, an EACCES on the
 * real file: no reader is mocked between the route and the filesystem.
 */

vi.mock("@/lib/clawbox-users", () => ({
  listUsers: vi.fn(async () => [{ username: "alice", createdAt: "2026-09-27T10:00:00.000Z", sv: "a1b2c3d4e5f60718" }]),
}));
vi.mock("@/lib/host-allowlist", () => ({ isTunnelRequest: () => false }));
vi.mock("@/lib/auth", () => ({ getSystemUsername: () => "clawbox" }));

let root: string;
let restore: () => void;
let GET: (req: Request) => Promise<Response>;
const configPath = () => path.join(root, "data", "config.json");
const ask = async () => (await GET(new Request("http://box.local/login-api/users"))).json();
// Root reads a 0000 file anyway; the case is only meaningful for the box's own user.
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

beforeAll(async () => {
  restore = saveEnv("CLAWBOX_ROOT");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-login-users-unreadable-"));
  process.env.CLAWBOX_ROOT = root;
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  ({ GET } = await import("@/app/login-api/users/route"));
});

afterAll(() => {
  try {
    fs.chmodSync(configPath(), 0o600);
  } catch {
    // not there
  }
  restore();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("an unreadable config.json", () => {
  it("lists the users of a home box whose config CAN be read (the case below means something)", async () => {
    fs.writeFileSync(configPath(), JSON.stringify({ org_mode: false }), { mode: 0o600 });
    expect(await ask()).toEqual({ multiUser: true, users: [{ username: "clawbox", owner: true }, { username: "alice", owner: false }] });
  });

  it.skipIf(asRoot)("lists nobody when the file is there but EACCES keeps it from being read", async () => {
    fs.writeFileSync(configPath(), JSON.stringify({ org_mode: false }), { mode: 0o600 });
    fs.chmodSync(configPath(), 0o000);
    try {
      expect(await ask()).toEqual({ multiUser: true, users: null });
    } finally {
      fs.chmodSync(configPath(), 0o600);
    }
  });
});
