import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("util", () => ({
  promisify: vi.fn().mockReturnValue(vi.fn().mockResolvedValue({ stdout: "", stderr: "" })),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  readdirSync: vi.fn().mockReturnValue([]),
}));

// Inline implementations, not chained .mockResolvedValue: the config's
// `mockReset: true` wipes chained values before every test while a vi.fn(impl)
// keeps its implementation, and these factories only run once per file.
vi.mock("@/lib/config-store", () => ({
  DATA_DIR: "/tmp/test-data",
  CONFIG_ROOT: "/tmp/test-data",
  getAll: vi.fn(async () => ({})),
  setMany: vi.fn(async () => undefined),
}));

vi.mock("@/lib/openclaw-config", () => ({
  getSkillsDir: vi.fn(() => "/home/clawbox/.openclaw/workspace"),
  findOpenclawBin: vi.fn(() => "/usr/local/bin/openclaw"),
}));

vi.mock("@/lib/openclaw-skill-info", () => ({
  refreshSkillsCache: vi.fn(),
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const CLAWHUB = "https://clawhub.ai/api/v1/skills/";
const STORE_DETAIL = "https://clawbox.com/api/store/apps/";
const STORE_ICONS = "https://clawbox.com/store/icons/";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
  };
}

const AMBIGUOUS = {
  code: "AMBIGUOUS_SKILL_SLUG",
  slug: "weather",
  matches: [
    { ownerHandle: "steipete", slug: "weather", ref: "@steipete/weather", url: "https://clawhub.ai/steipete/skills/weather" },
    { ownerHandle: "thcjp", slug: "weather", ref: "@thcjp/weather", url: "https://clawhub.ai/thcjp/skills/weather" },
  ],
};

/** What each upstream answers; unset hosts answer a network failure. */
function upstream(answers: { clawhub?: unknown; store?: unknown; icon?: unknown }) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.startsWith(CLAWHUB)) {
      if (answers.clawhub === undefined) throw new Error("fetch failed");
      return answers.clawhub;
    }
    if (url.startsWith(STORE_DETAIL)) {
      if (answers.store === undefined) throw new Error("fetch failed");
      return answers.store;
    }
    if (url.startsWith(STORE_ICONS)) {
      if (answers.icon === undefined) throw new Error("fetch failed");
      return answers.icon;
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

function install(body: unknown) {
  return new Request("http://localhost/setup-api/apps/install", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/setup-api/apps/install", () => {
  let POST: (req: Request) => Promise<Response>;
  let exec: ReturnType<typeof vi.fn>;
  let writeFile: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const { promisify } = await import("util");
    exec = vi.fn().mockResolvedValue({ stdout: "installed", stderr: "" });
    vi.mocked(promisify).mockReturnValue(exec as never);
    const fsMod = await import("fs/promises");
    vi.mocked(fsMod.default.mkdir).mockResolvedValue(undefined as never);
    writeFile = vi.mocked(fsMod.default.writeFile).mockResolvedValue(undefined);
    const { getSkillsDir } = await import("@/lib/openclaw-config");
    vi.mocked(getSkillsDir).mockReturnValue("/home/clawbox/.openclaw/workspace");
    upstream({
      clawhub: jsonResponse(200, { skill: { slug: "test-app" }, owner: { handle: "someone" } }),
      store: jsonResponse(200, { slug: "test-app", name: "Test App", category: "developer", developer: "someone" }),
      icon: jsonResponse(200, null),
    });
    const mod = await import("@/app/setup-api/apps/install/route");
    POST = mod.POST;
  });

  /** The ref the CLI was handed. */
  function installedRef(): string | undefined {
    const call = exec.mock.calls[0];
    return call ? (call[1] as string[])[2] : undefined;
  }

  it("installs an app successfully under the publisher ClawHub names", async () => {
    const res = await POST(install({ appId: "test-app" }));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.appId).toBe("test-app");
    expect(body.ref).toBe("@someone/test-app");
    // The CLI takes `@owner/slug` now; a bare slug fails for every slug more
    // than one publisher uses.
    expect(exec).toHaveBeenCalledWith(
      "/usr/local/bin/openclaw",
      ["skills", "install", "@someone/test-app", "--force"],
      expect.anything(),
    );
  });

  it("does not pass --acknowledge-clawhub-risk: a review-required release is the owner's call", async () => {
    await POST(install({ appId: "test-app" }));
    expect((exec.mock.calls[0][1] as string[])).not.toContain("--acknowledge-clawhub-risk");
  });

  it("rejects invalid appId", async () => {
    const res = await POST(install({ appId: "../hack" }));
    expect(res.status).toBe(400);
  });

  it("rejects missing appId", async () => {
    const res = await POST(install({}));
    expect(res.status).toBe(400);
  });

  it("keeps the leading-dash guard on both id shapes", async () => {
    expect((await POST(install({ appId: "-x" }))).status).toBe(400);
    expect((await POST(install({ appId: "@owner/-x" }))).status).toBe(400);
    expect((await POST(install({ appId: "@-owner/x" }))).status).toBe(400);
  });

  it("accepts a @owner/slug ref and keys everything local by the bare slug", async () => {
    const res = await POST(install({ appId: "@steipete/weather" }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.appId).toBe("weather");
    expect(installedRef()).toBe("@steipete/weather");
    // No ClawHub lookup when the caller already named the publisher.
    expect(mockFetch.mock.calls.some(([url]) => String(url).startsWith(CLAWHUB))).toBe(false);
    const { setMany } = await import("@/lib/config-store");
    expect(vi.mocked(setMany).mock.calls[0][0]).toMatchObject({ "pref:installed_apps": ["weather"] });
  });

  it("accepts an owner field and refuses one that is not a handle", async () => {
    let res = await POST(install({ appId: "weather", owner: "steipete" }));
    expect(res.status).toBe(200);
    expect(installedRef()).toBe("@steipete/weather");

    res = await POST(install({ appId: "weather", owner: "not a handle" }));
    expect(res.status).toBe(400);
    res = await POST(install({ appId: "@steipete/weather", owner: "thcjp" }));
    expect(res.status).toBe(400);
  });

  it("answers 404 not_found when ClawHub has no such skill, without running the CLI", async () => {
    upstream({ clawhub: jsonResponse(404, "Skill not found"), store: jsonResponse(404, null), icon: jsonResponse(404, null) });
    const res = await POST(install({ appId: "zz-not-a-real-skill" }));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body).toMatchObject({ ok: false, code: "not_found", appId: "zz-not-a-real-skill" });
    expect(body.error).toContain("zz-not-a-real-skill");
    expect(exec).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("answers 409 ambiguous with the publishers when the slug has several and the store names none", async () => {
    upstream({
      clawhub: jsonResponse(409, AMBIGUOUS),
      store: jsonResponse(200, { slug: "weather", name: "Weather", developer: "ClawHub Community" }),
      icon: jsonResponse(200, null),
    });
    const res = await POST(install({ appId: "weather" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ ok: false, code: "ambiguous", appId: "weather" });
    // The lookup normalises ClawHub's rows to the documented { ownerHandle,
    // ref, url } shape; whatever else ClawHub sends does not pass through.
    expect(body.matches).toEqual(AMBIGUOUS.matches.map(({ ownerHandle, ref, url }) => ({ ownerHandle, ref, url })));
    expect(exec).not.toHaveBeenCalled();
  });

  it("settles an ambiguous slug by the store listing's developer, never by the first match", async () => {
    upstream({
      clawhub: jsonResponse(409, AMBIGUOUS),
      store: jsonResponse(200, { slug: "weather", name: "Weather", developer: "THCJP" }),
      icon: jsonResponse(200, null),
    });
    const res = await POST(install({ appId: "weather" }));
    expect(res.status).toBe(200);
    expect(installedRef()).toBe("@thcjp/weather");
  });

  it("falls back to the bare slug when the ClawHub lookup itself is unreachable", async () => {
    upstream({ store: jsonResponse(200, { slug: "test-app", name: "Test App" }), icon: jsonResponse(200, null) });
    const res = await POST(install({ appId: "test-app" }));
    expect(res.status).toBe(200);
    expect(installedRef()).toBe("test-app");
  });

  it("reports a CLI 'Skill not found' as a non-retryable 404, not 'please try again'", async () => {
    exec.mockRejectedValue(new Error("Command failed: /usr/local/bin/openclaw skills install @someone/test-app --force\nClawHub /api/v1/skills/test-app/install failed (404): Skill not found"));
    const res = await POST(install({ appId: "test-app" }));
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.ok).toBe(false);
    expect(body.clawhub).toMatchObject({ success: false, code: "not_found", retryable: false, rateLimited: false });
    expect(body.clawhub.error).not.toMatch(/try again/i);
    expect(body.clawhub.error).not.toContain("/usr/local/bin");
  });

  it("maps a blocked or review-required release honestly and does not retry it", async () => {
    exec.mockRejectedValue(new Error("Install cancelled; rerun with --acknowledge-clawhub-risk to continue after reviewing the warning."));
    let body = await (await POST(install({ appId: "test-app" }))).json();
    expect(body.clawhub).toMatchObject({ code: "review_required", retryable: false });
    expect(body.clawhub.error).toContain("openclaw skills install @someone/test-app --acknowledge-clawhub-risk");

    exec.mockRejectedValue(new Error("ClawHub blocked this release; install was not started."));
    body = await (await POST(install({ appId: "test-app" }))).json();
    expect(body.clawhub).toMatchObject({ code: "blocked", retryable: false });
  });

  it("maps a ClawHub 5xx and a killed subprocess as retryable", async () => {
    exec.mockRejectedValue(new Error("ClawHub /api/v1/skills/test-app/install failed (503): unavailable"));
    let res = await POST(install({ appId: "test-app" }));
    expect(res.status).toBe(502);
    expect((await res.json()).clawhub).toMatchObject({ code: "upstream", retryable: true });

    exec.mockRejectedValue(Object.assign(new Error("Command failed: openclaw"), { killed: true, signal: "SIGTERM" }));
    res = await POST(install({ appId: "test-app" }));
    expect(res.status).toBe(504);
    expect((await res.json()).clawhub).toMatchObject({ code: "timeout", retryable: true });
  });

  it("downloads the icon only after the install succeeded", async () => {
    exec.mockRejectedValue(new Error("ClawHub /api/v1/skills/test-app/install failed (404): Skill not found"));
    await POST(install({ appId: "test-app" }));
    expect(writeFile).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.some(([url]) => String(url).startsWith(STORE_ICONS))).toBe(false);

    exec.mockResolvedValue({ stdout: "installed", stderr: "" });
    const body = await (await POST(install({ appId: "test-app" }))).json();
    expect(body.iconSaved).toBe(true);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("records the store's developer in the installed meta, as a UI install does", async () => {
    await POST(install({ appId: "test-app" }));
    const { setMany } = await import("@/lib/config-store");
    const written = vi.mocked(setMany).mock.calls[0][0] as Record<string, Record<string, unknown>>;
    expect(written["pref:installed_meta"]["test-app"]).toMatchObject({ name: "Test App", developer: "someone" });
  });

  it("handles icon download failure gracefully", async () => {
    upstream({
      clawhub: jsonResponse(200, { owner: { handle: "someone" } }),
      store: jsonResponse(200, { slug: "test-app", name: "Test App" }),
      icon: jsonResponse(404, null),
    });
    const res = await POST(install({ appId: "test-app" }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.iconSaved).toBe(false);
  });
});
