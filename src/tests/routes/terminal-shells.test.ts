/**
 * GET /setup-api/terminal/shells — the list the Terminal's settings sheet
 * offers as a new tab's shell. Behind the session like every other setup-api
 * read, and only a list: the PTY server checks the choice again at spawn.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const auth = vi.hoisted(() => ({ requireSession: vi.fn() }));
vi.mock("@/lib/route-auth", () => auth);
vi.mock("@/lib/terminal-shells", () => ({
  DEFAULT_SHELL: "/bin/bash",
  readEtcShells: () => ["/bin/sh", "/bin/bash", "/usr/bin/bash", "/usr/bin/zsh"],
  availableShells: (listed: string[]) => listed.filter((s) => s !== "/usr/bin/bash"),
}));

import { GET } from "@/app/setup-api/terminal/shells/route";

beforeEach(() => {
  auth.requireSession.mockReset();
});

describe("GET /setup-api/terminal/shells", () => {
  it("answers the installed shells, one per binary, and the default", async () => {
    auth.requireSession.mockResolvedValue(null);
    const res = await GET(new Request("http://clawbox.local/setup-api/terminal/shells"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ shells: ["/bin/sh", "/bin/bash", "/usr/bin/zsh"], defaultShell: "/bin/bash" });
  });

  it("refuses a caller without a session", async () => {
    auth.requireSession.mockResolvedValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }));
    const res = await GET(new Request("http://clawbox.local/setup-api/terminal/shells"));
    expect(res.status).toBe(401);
  });
});
