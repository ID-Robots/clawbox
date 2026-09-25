/**
 * TASK-1205: the server half of the /updating screen's "What's new" panel.
 *
 * What is pinned here:
 *  - the version is the package.json of the ref the updater syncs to
 *    (`origin/main`, `origin/beta`), and its notes are read from that ref, then
 *    the checkout, and only then from GitHub — local first, network last;
 *  - the checkout's own package.json names the target only once THIS update
 *    has synced it; before that it is the version being replaced;
 *  - GitHub is asked at most once a minute per version after a miss;
 *  - an answer read from notes is cached in `data/`, keyed by its version, so
 *    the server that comes back after the rebuild still has it — and a cache
 *    from another version, or an old one, is never shown for this update;
 *  - nothing here throws, the prefetch never rejects, and every read is
 *    bounded (git and GitHub are given a timeout).
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// The gitShow case runs real git (init, commit, show) — and so does the
// shared-read case, against a root that is not a repository.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

vi.mock("@/lib/updater", () => ({
  getUpdateState: vi.fn(),
  resolveUpdateBranch: vi.fn(),
}));

import { getUpdateState, resolveUpdateBranch } from "@/lib/updater";
import {
  CACHE_FALLBACK_MAX_AGE_MS,
  DEFAULT_SOURCES,
  GITHUB_MISS_RETRY_MS,
  prefetchUpdateWhatsNew,
  readUpdateWhatsNew,
  resetUpdateWhatsNewMemo,
  updateWhatsNewCachePath,
  type UpdateWhatsNewSources,
} from "@/lib/update-whats-new-server";
import { CLAWBOX_RELEASES_URL, releasePageUrl } from "@/lib/update-whats-new";

const NOTES_42 = [
  "# ClawBox 4.2.0",
  "",
  "## Highlights",
  "",
  "- **Faster updates.** The box downloads less and restarts once.",
  "- **Calmer chat.** Replies stream without jumping.",
  "",
  "## What's new by area",
].join("\n");
const HIGHLIGHTS_42 = [
  { title: "Faster updates", body: "The box downloads less and restarts once." },
  { title: "Calmer chat", body: "Replies stream without jumping." },
];

let root: string;
const savedRoot = process.env.CLAWBOX_ROOT;

interface Fakes {
  upstream: string | null;
  refs: Record<string, string>;
  checkout: Record<string, string>;
  synced: boolean;
  release: Record<string, string>;
  now: number;
}

let fakes: Fakes;
let releaseBody: Mock<(tag: string) => Promise<string | null>>;
let gitShow: Mock<(ref: string, file: string) => Promise<string | null>>;

function sources(overrides: Partial<UpdateWhatsNewSources> = {}): UpdateWhatsNewSources {
  return {
    upstream: async () => fakes.upstream,
    gitShow,
    readCheckout: async (file) => fakes.checkout[file] ?? null,
    checkoutSynced: () => fakes.synced,
    releaseBody,
    now: () => fakes.now,
    ...overrides,
  };
}

const pkg = (version: string) => JSON.stringify({ name: "clawbox", version });

function readCacheFile(): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(updateWhatsNewCachePath(), "utf-8"));
  } catch {
    return null;
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "update-whats-new-"));
  process.env.CLAWBOX_ROOT = root;
  resetUpdateWhatsNewMemo();
  fakes = { upstream: "origin/main", refs: {}, checkout: {}, synced: false, release: {}, now: 1_000_000 };
  gitShow = vi.fn(async (ref: string, file: string) => fakes.refs[`${ref}:${file}`] ?? null);
  releaseBody = vi.fn(async (tag: string) => fakes.release[tag] ?? null);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (savedRoot === undefined) delete process.env.CLAWBOX_ROOT;
  else process.env.CLAWBOX_ROOT = savedRoot;
  vi.unstubAllGlobals();
});

describe("readUpdateWhatsNew — where the answer comes from", () => {
  it("reads the version and its highlights from the ref the updater syncs to, with no network", async () => {
    fakes.refs["origin/main:package.json"] = pkg("4.2.0");
    fakes.refs["origin/main:RELEASE-NOTES-4.2.0.md"] = NOTES_42;

    expect(await readUpdateWhatsNew(sources())).toEqual({
      version: "4.2.0",
      channel: "main",
      source: "notes",
      highlights: HIGHLIGHTS_42,
      releaseUrl: releasePageUrl("4.2.0"),
    });
    expect(releaseBody).not.toHaveBeenCalled();
  });

  it("follows the channel the box is on", async () => {
    fakes.upstream = "origin/beta";
    fakes.refs["origin/beta:package.json"] = pkg("4.2.0-beta.1");
    fakes.refs["origin/beta:RELEASE-NOTES-4.2.0-beta.1.md"] = NOTES_42;

    const answer = await readUpdateWhatsNew(sources());
    expect(answer).toMatchObject({ version: "4.2.0-beta.1", channel: "beta", source: "notes" });
    expect(gitShow).not.toHaveBeenCalledWith("origin/main", expect.anything());
  });

  it("falls back to the checkout's notes file when the ref has none", async () => {
    fakes.refs["origin/main:package.json"] = pkg("4.2.0");
    fakes.checkout["RELEASE-NOTES-4.2.0.md"] = NOTES_42;

    expect(await readUpdateWhatsNew(sources())).toMatchObject({ source: "notes", highlights: HIGHLIGHTS_42 });
    expect(releaseBody).not.toHaveBeenCalled();
  });

  it("asks GitHub for the tag's release body only when nothing local has highlights", async () => {
    fakes.refs["origin/main:package.json"] = pkg("4.2.0");
    fakes.refs["origin/main:RELEASE-NOTES-4.2.0.md"] = "# 4.2.0\n\nNo highlights section here.";
    fakes.release["v4.2.0"] = NOTES_42;

    expect(await readUpdateWhatsNew(sources())).toMatchObject({ source: "notes", highlights: HIGHLIGHTS_42 });
    expect(releaseBody).toHaveBeenCalledWith("v4.2.0");
  });

  it("answers `none` with the version and its release page when no notes have highlights", async () => {
    fakes.refs["origin/main:package.json"] = pkg("4.2.0");
    fakes.release["v4.2.0"] = "## What's Changed\n* a PR by @someone";

    expect(await readUpdateWhatsNew(sources())).toEqual({
      version: "4.2.0",
      channel: "main",
      source: "none",
      highlights: [],
      releaseUrl: releasePageUrl("4.2.0"),
    });
    expect(readCacheFile()).toBeNull();
  });

  it("does not ask GitHub again for a minute after it had nothing", async () => {
    fakes.refs["origin/main:package.json"] = pkg("4.2.0");

    await readUpdateWhatsNew(sources());
    fakes.now += GITHUB_MISS_RETRY_MS - 1;
    await readUpdateWhatsNew(sources());
    expect(releaseBody).toHaveBeenCalledTimes(1);

    fakes.now += 2;
    fakes.release["v4.2.0"] = NOTES_42;
    expect(await readUpdateWhatsNew(sources())).toMatchObject({ source: "notes" });
    expect(releaseBody).toHaveBeenCalledTimes(2);
  });
});

describe("readUpdateWhatsNew — which version", () => {
  it("does not take the checkout's package.json for the target before this update synced it", async () => {
    fakes.upstream = null;
    fakes.checkout["package.json"] = pkg("4.1.0");
    fakes.checkout["RELEASE-NOTES-4.1.0.md"] = NOTES_42;

    expect(await readUpdateWhatsNew(sources())).toEqual({
      version: null, channel: null, source: "none", highlights: [], releaseUrl: CLAWBOX_RELEASES_URL,
    });
    expect(releaseBody).not.toHaveBeenCalled();
  });

  it("takes it once the update's own sync step has run", async () => {
    fakes.upstream = null;
    fakes.synced = true;
    fakes.checkout["package.json"] = pkg("4.2.0");
    fakes.checkout["RELEASE-NOTES-4.2.0.md"] = NOTES_42;

    expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: "4.2.0", source: "notes" });
  });

  it("reads nothing from a ref that is not one of origin's safe branches", async () => {
    for (const ref of ["upstream/main", "origin/-rf", "origin/a..b", "origin/"]) {
      fakes.upstream = ref;
      expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: null, channel: null, source: "none" });
    }
    expect(gitShow).not.toHaveBeenCalled();
  });

  it("ignores a package.json version that is not a version", async () => {
    fakes.refs["origin/main:package.json"] = JSON.stringify({ version: "../../etc/passwd" });
    expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: null, source: "none" });
    fakes.refs["origin/main:package.json"] = "{not json";
    expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: null, source: "none" });
    expect(releaseBody).not.toHaveBeenCalled();
  });
});

describe("readUpdateWhatsNew — the cache across the restart", () => {
  beforeEach(() => {
    fakes.refs["origin/main:package.json"] = pkg("4.2.0");
    fakes.refs["origin/main:RELEASE-NOTES-4.2.0.md"] = NOTES_42;
  });

  it("writes what it read to data/, keyed by the version", async () => {
    await readUpdateWhatsNew(sources());
    expect(readCacheFile()).toEqual({ version: "4.2.0", channel: "main", highlights: HIGHLIGHTS_42, savedAt: fakes.now });
  });

  it("answers the same version from the cache without reading notes or the network again", async () => {
    await readUpdateWhatsNew(sources());
    gitShow.mockClear();
    releaseBody.mockClear();

    expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: "4.2.0", source: "notes", highlights: HIGHLIGHTS_42 });
    expect(gitShow).toHaveBeenCalledTimes(1);
    expect(gitShow).toHaveBeenCalledWith("origin/main", "package.json");
    expect(releaseBody).not.toHaveBeenCalled();
  });

  it("stands in for a target git cannot name right now — within the update's own span", async () => {
    await readUpdateWhatsNew(sources());
    resetUpdateWhatsNewMemo();
    fakes.upstream = null; // mid-restart: git unreadable

    fakes.now += CACHE_FALLBACK_MAX_AGE_MS - 1;
    expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: "4.2.0", source: "notes" });

    fakes.now += 2;
    expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: null, source: "none" });
  });

  it("never shows another version's cached highlights", async () => {
    await readUpdateWhatsNew(sources());
    fakes.refs["origin/main:package.json"] = pkg("4.3.0");

    expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: "4.3.0", source: "none", highlights: [] });
  });

  it("ignores a cache file it cannot read in full", async () => {
    fs.mkdirSync(path.dirname(updateWhatsNewCachePath()), { recursive: true });
    for (const junk of ["{", JSON.stringify({ version: "4.2.0", highlights: [], savedAt: 1, channel: null })]) {
      fs.writeFileSync(updateWhatsNewCachePath(), junk);
      fakes.upstream = null;
      expect(await readUpdateWhatsNew(sources())).toMatchObject({ version: null, source: "none" });
    }
  });

  it("still answers when the cache cannot be written", async () => {
    // data/ is a FILE, so neither mkdir nor the write can succeed.
    fs.writeFileSync(path.join(root, "data"), "not a directory");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await readUpdateWhatsNew(sources())).toMatchObject({ source: "notes", highlights: HIGHLIGHTS_42 });
    expect(warn).toHaveBeenCalled();
  });
});

describe("never in the update's way", () => {
  it("answers `none` when every source throws", async () => {
    const boom = () => Promise.reject(new Error("boom"));
    const answer = await readUpdateWhatsNew(sources({
      upstream: boom,
      gitShow: boom,
      readCheckout: boom,
      releaseBody: boom,
    }));
    expect(answer).toEqual({ version: null, channel: null, source: "none", highlights: [], releaseUrl: CLAWBOX_RELEASES_URL });
  });

  it("answers `none` when a source throws synchronously", async () => {
    const answer = await readUpdateWhatsNew(sources({
      upstream: async () => null,
      checkoutSynced: () => { throw new Error("state unreadable"); },
    }));
    expect(answer).toMatchObject({ source: "none", version: null });
  });

  it("the prefetch resolves, never rejects, and leaves the answer cached", async () => {
    fakes.refs["origin/main:package.json"] = pkg("4.2.0");
    fakes.refs["origin/main:RELEASE-NOTES-4.2.0.md"] = NOTES_42;
    await expect(prefetchUpdateWhatsNew(sources())).resolves.toBeUndefined();
    expect(readCacheFile()).toMatchObject({ version: "4.2.0" });

    const boom = () => Promise.reject(new Error("boom"));
    await expect(prefetchUpdateWhatsNew(sources({ upstream: boom, checkoutSynced: () => { throw new Error("x"); } })))
      .resolves.toBeUndefined();
  });
});

describe("the real sources", () => {
  it("upstream is the updater's own branch resolution, and null when it refuses", async () => {
    vi.mocked(resolveUpdateBranch).mockResolvedValueOnce({ local: "beta", upstream: "origin/beta", source: "pin-file" });
    expect(await DEFAULT_SOURCES.upstream()).toBe("origin/beta");
    expect(resolveUpdateBranch).toHaveBeenCalledWith(root);

    vi.mocked(resolveUpdateBranch).mockRejectedValueOnce(new Error("detached, no evidence"));
    expect(await DEFAULT_SOURCES.upstream()).toBeNull();
  });

  it("checkoutSynced is true only while a run has completed its sync step", () => {
    const steps = (status: string) => [{ id: "bootstrap_updater", label: "x", status }, { id: "apt_update", label: "y", status: "pending" }];
    vi.mocked(getUpdateState).mockReturnValue({ phase: "running", steps: steps("completed"), currentStepIndex: 1 } as never);
    expect(DEFAULT_SOURCES.checkoutSynced()).toBe(true);
    vi.mocked(getUpdateState).mockReturnValue({ phase: "running", steps: steps("running"), currentStepIndex: 0 } as never);
    expect(DEFAULT_SOURCES.checkoutSynced()).toBe(false);
    vi.mocked(getUpdateState).mockReturnValue({ phase: "completed", steps: steps("completed"), currentStepIndex: -1 } as never);
    expect(DEFAULT_SOURCES.checkoutSynced()).toBe(false);
  });

  it("readCheckout reads a file under the root, and refuses a missing or oversized one", async () => {
    fs.writeFileSync(path.join(root, "RELEASE-NOTES-4.2.0.md"), NOTES_42);
    expect(await DEFAULT_SOURCES.readCheckout("RELEASE-NOTES-4.2.0.md")).toBe(NOTES_42);
    expect(await DEFAULT_SOURCES.readCheckout("RELEASE-NOTES-9.9.9.md")).toBeNull();
    fs.writeFileSync(path.join(root, "huge.md"), "x".repeat(600 * 1024));
    expect(await DEFAULT_SOURCES.readCheckout("huge.md")).toBeNull();
  });

  it("gitShow reads a file at a ref with git, and answers null for what is not there", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "-q");
    fs.writeFileSync(path.join(root, "package.json"), pkg("4.2.0"));
    git("add", "package.json");
    git("-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "init");

    expect(await DEFAULT_SOURCES.gitShow("HEAD", "package.json")).toBe(pkg("4.2.0"));
    expect(await DEFAULT_SOURCES.gitShow("HEAD", "RELEASE-NOTES-4.2.0.md")).toBeNull();
    expect(await DEFAULT_SOURCES.gitShow("origin/nowhere", "package.json")).toBeNull();
  });

  describe("releaseBody", () => {
    it("asks GitHub's API for the tag, with a timeout, and answers the body", async () => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v4.2.0", body: NOTES_42 }), { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      expect(await DEFAULT_SOURCES.releaseBody("v4.2.0")).toBe(NOTES_42);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.github.com/repos/ID-Robots/clawbox/releases/tags/v4.2.0");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect((init.headers as Record<string, string>).Accept).toBe("application/vnd.github+json");
    });

    it("answers null for a refusal, a timeout, junk or an oversized answer", async () => {
      const answers: Array<() => Promise<Response>> = [
        async () => new Response("Not Found", { status: 404 }),
        async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); },
        async () => new Response("{not json", { status: 200 }),
        async () => new Response(JSON.stringify({ body: 42 }), { status: 200 }),
        async () => new Response("{}", { status: 200, headers: { "content-length": String(5 * 1024 * 1024) } }),
        async () => new Response(JSON.stringify({ body: "x".repeat(1024 * 1024 + 10) }), { status: 200 }),
      ];
      for (const answer of answers) {
        vi.stubGlobal("fetch", vi.fn(answer));
        expect(await DEFAULT_SOURCES.releaseBody("v4.2.0")).toBeNull();
      }
    });
  });

  it("shares one read between the prefetch and the screen's first ask", async () => {
    vi.mocked(resolveUpdateBranch).mockResolvedValue({ local: "main", upstream: "origin/main", source: "checkout-branch" });
    vi.mocked(getUpdateState).mockReturnValue({ phase: "idle", steps: [], currentStepIndex: -1 } as never);
    const first = readUpdateWhatsNew();
    const second = readUpdateWhatsNew();
    expect(second).toBe(first);
    // Not a git checkout, so there is no version to read: a plain `none`.
    expect(await first).toMatchObject({ source: "none", version: null });
    expect(readUpdateWhatsNew()).not.toBe(first);
  });
});
