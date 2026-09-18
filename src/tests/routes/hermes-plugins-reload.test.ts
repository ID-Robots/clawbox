import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installSessionFixture, type SessionFixture } from "@/tests/helpers/session";
import { saveEnv } from "@/tests/helpers/env";

/**
 * POST /setup-api/hermes/plugins/reload — the deliberate half of the same
 * mechanism the watcher drives on its own.
 *
 * WHY THE AGENT IS AN INTENDED CALLER, unlike almost every other route that
 * changes device state. The owner's transcript is the case: the assistant
 * installed a plugin, verified it in a fresh `hermes chat -q`, then tried
 * `sudo systemctl restart clawbox-hermes-dashboard` and was refused — correctly,
 * because agent shells run with `no_new_privs` and no such grant exists or
 * should. The thing it actually needed is not privileged at all, and this route
 * is how it asks for it. Refusing the MCP bearer here would leave the assistant
 * exactly where it was: able to install a plugin and unable to make it work.
 *
 * What it can do is bounded to that: restart a unit the clawbox user already
 * owns, which comes straight back under `Restart=always`. It cannot start one
 * that is stopped, cannot reach any other unit, and takes no argument that
 * names one.
 */

const bounceMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const stateMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/hermes-dashboard-control", () => ({ bounceHermesDashboard: bounceMock }));
vi.mock("@/lib/email-notify", () => ({ notifyOwner: notifyMock }));
vi.mock("@/lib/hermes-plugin-set", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hermes-plugin-set")>()),
  readHermesPluginState: stateMock,
  readHermesPluginDeclaration: vi.fn(async () => ({
    names: ["superpowers"],
    enabled: ["superpowers"],
    signature: "sig",
    changedAt: 1,
  })),
}));

describe("POST /setup-api/hermes/plugins/reload", () => {
  let session: SessionFixture;
  let restoreEnv: () => void;
  const token = "b".repeat(64);
  let post: typeof import("@/app/setup-api/hermes/plugins/reload/route").POST;

  const req = (auth: "owner" | "agent" | "none") =>
    new Request("http://localhost/setup-api/hermes/plugins/reload", {
      method: "POST",
      headers:
        auth === "owner"
          ? { Cookie: session.cookie }
          : auth === "agent"
            ? { Authorization: `Bearer ${token}` }
            : {},
    });

  beforeEach(async () => {
    vi.resetModules();
    session = installSessionFixture();
    fs.writeFileSync(path.join(session.root, "data/.mcp-token"), token);
    restoreEnv = saveEnv("CLAWBOX_EDITION");
    process.env.CLAWBOX_EDITION = "hermes";
    bounceMock.mockReset();
    notifyMock.mockReset();
    stateMock.mockReset();
    bounceMock.mockResolvedValue("restarted");
    notifyMock.mockResolvedValue(undefined);
    stateMock.mockResolvedValue({
      declared: ["superpowers"],
      loaded: ["superpowers"],
      stale: false,
      dashboardStartedAt: 1,
    });
    post = (await import("@/app/setup-api/hermes/plugins/reload/route")).POST;
  });

  afterEach(() => {
    restoreEnv();
    session.cleanup();
  });

  it("admits the owner's session", async () => {
    const response = await post(req("owner"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.restarted).toBe(true);
    expect(body.ready).toBe(true);
    expect(body.plugins).toContain("superpowers");
  });

  it("admits the MCP bearer — the agent is who needs this", async () => {
    const response = await post(req("agent"));
    expect(response.status).toBe(200);
    expect(bounceMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an unauthenticated caller", async () => {
    expect((await post(req("none"))).status).toBe(401);
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("refuses on an edition with no Hermes dashboard, and restarts nothing", async () => {
    // An OpenClaw box has no dashboard by design. Bouncing "the chat backend"
    // there would be this route reaching for a unit the foreign-edition teardown
    // deliberately stopped.
    process.env.CLAWBOX_EDITION = "openclaw";
    vi.resetModules();
    const openclawPost = (await import("@/app/setup-api/hermes/plugins/reload/route")).POST;
    const response = await openclawPost(req("owner"));
    expect(response.status).toBe(404);
    expect(bounceMock).not.toHaveBeenCalled();
  });

  it("answers 502 — not 200 — when the dashboard did not come back", async () => {
    // THE FALSE SUCCESS THIS ROUTE EXISTS TO AVOID. Reporting 200 over a
    // dashboard that is down tells the assistant its plugin is live and sends it
    // on to use a tool that is not there.
    bounceMock.mockResolvedValue("failed");
    const response = await post(req("agent"));
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.restarted).toBe(false);
    expect(body.ready).toBe(false);
  });

  it("answers 200 with ready:false when the restart took but has not finished", async () => {
    // `pending` means systemd owns it and it is on its way. Acting makes it
    // worse, so this is not an error — but it is not "ready" either, and the
    // caller must be able to tell.
    bounceMock.mockResolvedValue("pending");
    const response = await post(req("agent"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.restarted).toBe(true);
    expect(body.ready).toBe(false);
  });

  it("tells the owner their chat window dropped", async () => {
    await post(req("agent"));
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(String(notifyMock.mock.calls[0][0]).toLowerCase()).toContain("new chat");
  });

  it("uses no sudo and names no unit — the mechanism needs neither", async () => {
    // The whole mechanism, asserted from the outside: the restart this route
    // performs is `bounceHermesDashboard()`, which is unprivileged. If this route
    // ever grew a `sudo systemctl restart clawbox-hermes-dashboard`, it would
    // need a grant that `install-sudoers-migration.test.ts` refuses to give it —
    // and that grant would let an OpenClaw box START the dashboard its
    // foreign-edition teardown had just stopped and disabled.
    //
    // COMMENTS ARE STRIPPED FIRST, deliberately. The file's own doc block has to
    // be able to say the words "sudo systemctl restart" in order to explain why
    // it does not do it, and a check that forbade the explanation would push the
    // reasoning out of the file it belongs in.
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/app/setup-api/hermes/plugins/reload/route.ts"),
      "utf-8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/sudo/);
    expect(code).not.toMatch(/systemctl/);
    expect(code).not.toMatch(/execFile|spawn/);
  });
});
