import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// The MCP decides its whole tool set from the edition, once, before it connects
// its transport — so getting this wrong is not a cosmetic bug, it is the wrong
// device surface handed to the agent for the life of the process.
//
// The two properties pinned here:
//   1. The ROOT-OWNED lock file is the authority, ahead of the environment.
//      clawbox-setup.service builds its environment partly from a file the
//      device user can write, so an environment-first resolver is not a lock.
//   2. A lock that EXISTS but cannot be read fails CLOSED — to the smaller
//      Hermes set. OpenClaw is the larger surface and the only one carrying the
//      shell and file tools, so defaulting to it on a read failure hands those
//      tools to a device that was configured never to have them.

let dir: string;
let lockPath: string;

function writeLock(body: string): void {
  fs.writeFileSync(lockPath, body);
}

async function loadEdition() {
  vi.resetModules();
  return import("../../../mcp/lib/edition");
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-edition-"));
  lockPath = path.join(dir, "edition.env");
  process.env.CLAWBOX_EDITION_FILE = lockPath;
  delete process.env.CLAWBOX_EDITION;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.CLAWBOX_EDITION;
  vi.unstubAllGlobals();
});

describe("resolveEdition — the lock file is the authority", () => {
  it("reports hermes from the lock even when the environment says openclaw", async () => {
    writeLock("CLAWBOX_EDITION=hermes\n");
    process.env.CLAWBOX_EDITION = "openclaw";
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition(null)).toBe("hermes");
  });

  it("reports openclaw from the lock even when the environment says hermes", async () => {
    writeLock("CLAWBOX_EDITION=openclaw\n");
    process.env.CLAWBOX_EDITION = "hermes";
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition(null)).toBe("openclaw");
  });

  it("reads the lock through comments and surrounding quotes", async () => {
    writeLock("# ClawBox edition lock\n\nexport CLAWBOX_EDITION=\"hermes\"\n");
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition(null)).toBe("hermes");
  });

  it("never asks the API when the edition is locked", async () => {
    // `resolveAppHarness` is the one that may ask; a locked edition settles it
    // from the file and the device is left alone.
    writeLock("CLAWBOX_EDITION=hermes\n");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveAppHarness } = await loadEdition();
    await expect(resolveAppHarness("http://127.0.0.1:80", null)).resolves.toBe("hermes");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolveEdition — no lock file", () => {
  it("falls back to the environment, for dev machines and CI", async () => {
    process.env.CLAWBOX_EDITION = "hermes";
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition(null)).toBe("hermes");
  });

  it("defaults to openclaw when there is neither a lock nor an environment value", async () => {
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition(null)).toBe("openclaw");
  });
});

describe("resolveEdition — an unreadable lock fails closed", () => {
  it("registers the smaller Hermes set when the lock carries no edition", async () => {
    writeLock("# nothing useful in here\n");
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition(null)).toBe("hermes");
  });

  it("ignores the environment when the lock exists but cannot be parsed", async () => {
    writeLock("GARBAGE\n");
    process.env.CLAWBOX_EDITION = "openclaw";
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition(null)).toBe("hermes");
  });

  it("does not treat an empty lock file as openclaw", async () => {
    writeLock("");
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition(null)).toBe("hermes");
  });
});

describe("the unlocked dual SKU — one probe, two answers", () => {
  it("asks the device which harness is active, and the tool set follows it", async () => {
    writeLock("CLAWBOX_EDITION=dual\n");
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: "hermes" }),
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveAppHarness, resolveEdition } = await loadEdition();
    const appHarness = await resolveAppHarness("http://127.0.0.1:80", null);
    expect(appHarness).toBe("hermes");
    expect(resolveEdition(appHarness)).toBe("hermes");
    // ONE request for both facts — the whole point of handing the answer on.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("uses the default harness when the device cannot answer", async () => {
    writeLock("CLAWBOX_EDITION=dual\n");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const { resolveAppHarness, resolveEdition } = await loadEdition();
    const appHarness = await resolveAppHarness("http://127.0.0.1:80", null);
    // The app list makes no claim; the tool set still needs one, and takes the
    // default. Two different right answers to a silence, from one probe.
    expect(appHarness).toBeNull();
    expect(resolveEdition(appHarness)).toBe("openclaw");
  });

  it("sends the bearer so a session-gated device can answer", async () => {
    writeLock("CLAWBOX_EDITION=dual\n");
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ active: "openclaw" }) });
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveAppHarness } = await loadEdition();
    await resolveAppHarness("http://127.0.0.1:80", "Bearer secret");
    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.authorization).toBe("Bearer secret");
  });
});

describe("resolveEdition — it never asks the device itself", () => {
  it("makes no request even on the unlocked dual SKU", async () => {
    // ONE PROBE PER STARTUP. `main()` resolves the APP harness (which does ask)
    // and hands the answer here, so the tool set and the app list cannot come
    // from two different replies: a dual box whose first probe said `hermes`
    // and whose second timed out registered the Hermes tool set beside an app
    // list that hid both dashboards, for the life of that stdio child.
    writeLock("CLAWBOX_EDITION=dual\n");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition("hermes")).toBe("hermes");
    expect(resolveEdition(null)).toBe("openclaw");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still fails CLOSED on an unreadable lock, whatever the device said", async () => {
    // The two questions differ HERE, which is why they are two functions: the
    // app list may take the device's word for an unreadable lock (the desktop
    // does), but the TOOL SET must not — OpenClaw is the larger surface and
    // carries the shell and file tools.
    writeLock("GARBAGE\n");
    const { resolveEdition } = await loadEdition();
    expect(resolveEdition("openclaw")).toBe("hermes");
  });
});

describe("resolveAppHarness — an unreadable lock still asks the device", () => {
  it("takes the device's answer rather than hiding apps the box has", async () => {
    // /setup-api/harness/active ALWAYS answers: getActiveHarness() falls back
    // through readEdition(), whose default for an unreadable lock is
    // "openclaw". So the desktop grid shows twelve apps while this returned
    // null and the agent was told three of them could not be placed — the two
    // surfaces disagreeing in exactly the state this PR is about.
    writeLock("GARBAGE\n");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ active: "openclaw" }),
    }));
    const { resolveAppHarness } = await loadEdition();
    await expect(resolveAppHarness("http://127.0.0.1:80", null)).resolves.toBe("openclaw");
  });

  it("is null only when the device does not answer either", async () => {
    writeLock("GARBAGE\n");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const { resolveAppHarness } = await loadEdition();
    await expect(resolveAppHarness("http://127.0.0.1:80", null)).resolves.toBeNull();
  });
});

describe("installEdition — reports the SKU as installed, including dual", () => {
  it.each(["openclaw", "hermes", "dual"])("reports %s", async (edition) => {
    writeLock(`CLAWBOX_EDITION=${edition}\n`);
    const { installEdition } = await loadEdition();
    expect(installEdition()).toBe(edition);
  });
});
