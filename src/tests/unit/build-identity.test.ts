import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import {
  computeDrift,
  collectBuildIdentity,
  resolveBuildDir,
  type BuildInfo,
  type CheckoutInfo,
  type DriftInputs,
  type PinInfo,
} from "@/lib/build-identity";

const A = "1b21187aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "d285cfdbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function buildInfo(over: Partial<BuildInfo> = {}): BuildInfo {
  return {
    commit: A,
    shortCommit: A.slice(0, 7),
    branch: "beta",
    dirty: false,
    committedAt: "2026-08-21T20:00:00Z",
    builtAt: "2026-08-21T20:09:03Z",
    buildId: "f2aojibqYGT2Dg7DvAtYb",
    node: "v22.0.0",
    bun: "1.2.10",
    packageVersion: "3.9.0",
    hermesPin: null,
    openclawPin: null,
    ...over,
  };
}

function checkout(over: Partial<CheckoutInfo> = {}): CheckoutInfo {
  return {
    commit: A,
    shortCommit: A.slice(0, 7),
    branch: "beta",
    dirty: false,
    committedAt: "2026-08-21T20:00:00Z",
    ...over,
  };
}

function pin(over: Partial<PinInfo> = {}): PinInfo {
  return { branch: "beta", source: "pin-file", commit: A, pinned: true, ...over };
}

function inputs(over: Partial<DriftInputs> = {}): DriftInputs {
  return {
    build: buildInfo(),
    deployedBuildId: "f2aojibqYGT2Dg7DvAtYb",
    buildTimestampMs: Date.parse("2026-08-21T20:09:03Z"),
    checkout: checkout(),
    pin: pin(),
    stamperInCheckout: true,
    ...over,
  };
}

describe("computeDrift", () => {
  it("reports a match when build, checkout and pin all name the same commit", () => {
    const d = computeDrift(inputs());
    expect(d.buildVsCheckout).toBe("match");
    expect(d.checkoutVsPin).toBe("match");
    expect(d.detected).toBe(false);
    expect(d.reasons).toEqual([]);
    expect(d.codes).toEqual([]);
  });

  // The live fixture: box .71 served a build from 1b21187 against a checkout
  // of d285cfd, which is what made two features 404 while their source sat on
  // disk. This is the case the whole endpoint exists for.
  it("flags a build made from a different commit than the checkout", () => {
    const d = computeDrift(inputs({ checkout: checkout({ commit: B, shortCommit: B.slice(0, 7) }), pin: pin({ commit: B }) }));
    expect(d.buildVsCheckout).toBe("drift");
    expect(d.detected).toBe(true);
    expect(d.codes).toContain("build-from-other-commit");
    expect(d.reasons[0]).toContain("1b21187");
    expect(d.reasons[0]).toContain("d285cfd");
  });

  // A stamp that names the right commit but the wrong assets vouches for
  // nothing: something replaced the build without rewriting the record.
  it("refuses to trust a build record that describes other assets", () => {
    const d = computeDrift(inputs({ deployedBuildId: "someOtherBuildId" }));
    expect(d.buildVsCheckout).toBe("drift");
    expect(d.codes).toContain("build-info-not-for-deployed-assets");
    expect(d.codes).not.toContain("build-from-other-commit");
  });

  // Boxes that upgrade FROM a pre-stamp build have no build-info.json at all.
  // "Unknown" there would let exactly the reported fixture stay silent, so the
  // presence of the stamper in the checkout is treated as proof the build is
  // older than the checkout.
  it("treats an unstamped build as drift once the checkout can produce stamps", () => {
    const d = computeDrift(inputs({ build: null, stamperInCheckout: true }));
    expect(d.buildVsCheckout).toBe("drift");
    expect(d.codes).toContain("build-unstamped");
  });

  it("falls back to timestamps when neither the build nor the checkout can stamp", () => {
    const d = computeDrift(inputs({
      build: null,
      stamperInCheckout: false,
      buildTimestampMs: Date.parse("2026-08-21T20:09:03Z"),
      checkout: checkout({ committedAt: "2026-08-22T03:00:00Z" }),
    }));
    expect(d.buildVsCheckout).toBe("drift");
    expect(d.codes).toContain("build-predates-checkout");
  });

  it("stays 'unknown' when there is genuinely nothing to compare", () => {
    const d = computeDrift(inputs({
      build: null,
      stamperInCheckout: false,
      buildTimestampMs: null,
      checkout: checkout({ commit: null, shortCommit: null, committedAt: null }),
      pin: pin({ commit: null }),
    }));
    expect(d.buildVsCheckout).toBe("unknown");
    expect(d.checkoutVsPin).toBe("unknown");
    expect(d.detected).toBe(false);
  });

  it("counts an uncommitted working tree as drift even when the commit matches", () => {
    const d = computeDrift(inputs({ checkout: checkout({ dirty: true }) }));
    expect(d.buildVsCheckout).toBe("drift");
    expect(d.codes).toContain("checkout-dirty");
  });

  it("flags a checkout that is not on the tested commit", () => {
    const d = computeDrift(inputs({ pin: pin({ commit: B }) }));
    expect(d.checkoutVsPin).toBe("drift");
    expect(d.codes).toContain("checkout-behind-pin");
    expect(d.detected).toBe(true);
  });

  // No pin is a repairable condition, not a failure: the updater writes one.
  // It must therefore be reported without turning the banner red on its own.
  it("reports an unpinned box without calling it drift", () => {
    const d = computeDrift(inputs({ pin: pin({ pinned: false, source: "checkout-branch" }) }));
    expect(d.checkoutVsPin).toBe("unknown");
    expect(d.codes).toContain("no-pin");
    expect(d.detected).toBe(false);
  });

  it("does not double-report the commit mismatch as a stamp problem", () => {
    const d = computeDrift(inputs({ build: buildInfo({ buildId: null }), deployedBuildId: "x" }));
    expect(d.codes).not.toContain("build-info-not-for-deployed-assets");
    expect(d.buildVsCheckout).toBe("match");
  });
});

// ── collectBuildIdentity against a real, throwaway git checkout ─────────────

const HAS_GIT = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const dg = HAS_GIT ? describe : describe.skip;

dg("collectBuildIdentity", () => {
  let repo: string;
  let headSha: string;

  function git(...args: string[]): string {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim();
  }

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-build-identity-"));
    execFileSync("git", ["init", "-q", "-b", "beta", repo]);
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
    // The real .gitignore keeps .next out of the tree; without it every build
    // artefact below would read as "dirty" and the fixtures would be untestable.
    fs.writeFileSync(path.join(repo, ".gitignore"), ".next/\n");
    git("add", "-A");
    git("commit", "-qm", "initial");
    headSha = git("rev-parse", "HEAD");
    fs.mkdirSync(path.join(repo, ".next"), { recursive: true });
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function writeBuild(info: Partial<BuildInfo>, buildId: string) {
    fs.writeFileSync(path.join(repo, ".next", "BUILD_ID"), `${buildId}\n`);
    fs.writeFileSync(
      path.join(repo, ".next", "build-info.json"),
      JSON.stringify(buildInfo({ buildId, ...info }), null, 2),
    );
  }

  it("reads a matching build as clean", async () => {
    writeBuild({ commit: headSha, shortCommit: headSha.slice(0, 7) }, "buildone");
    const id = await collectBuildIdentity(repo);
    expect(id.checkout.commit).toBe(headSha);
    expect(id.checkout.branch).toBe("beta");
    expect(id.build?.commit).toBe(headSha);
    expect(id.deployedBuildId).toBe("buildone");
    expect(id.drift.buildVsCheckout).toBe("match");
    expect(id.drift.detected).toBe(false);
  });

  it("detects the deployed-build-vs-checkout gap end to end", async () => {
    writeBuild({ commit: A, shortCommit: A.slice(0, 7) }, "buildone");
    const id = await collectBuildIdentity(repo);
    expect(id.drift.buildVsCheckout).toBe("drift");
    expect(id.drift.detected).toBe(true);
    expect(id.drift.reasons.join(" ")).toContain(headSha.slice(0, 7));
  });

  it("reports the box as unpinned until .update-branch exists", async () => {
    writeBuild({ commit: headSha }, "buildone");
    let id = await collectBuildIdentity(repo);
    expect(id.pin.pinned).toBe(false);
    expect(id.pin.branch).toBe("beta");
    expect(id.pin.source).toBe("checkout-branch");
    expect(id.drift.codes).toContain("no-pin");

    fs.writeFileSync(path.join(repo, ".update-branch"), "beta\n");
    try {
      id = await collectBuildIdentity(repo);
      expect(id.pin.pinned).toBe(true);
      expect(id.pin.source).toBe("pin-file");
    } finally {
      fs.rmSync(path.join(repo, ".update-branch"), { force: true });
    }
  });

  it("ignores a malformed pin instead of interpolating it into a git ref", async () => {
    writeBuild({ commit: headSha }, "buildone");
    fs.writeFileSync(path.join(repo, ".update-branch"), "--upload-pack=evil\n");
    try {
      const id = await collectBuildIdentity(repo);
      expect(id.pin.pinned).toBe(false);
      expect(id.pin.branch).not.toContain("upload-pack");
    } finally {
      fs.rmSync(path.join(repo, ".update-branch"), { force: true });
    }
  });

  // The upgrade case: a box whose deployed build predates this feature has no
  // build-info.json, and must still say so rather than report "unknown".
  it("flags an unstamped deployed build when the checkout ships the stamper", async () => {
    fs.rmSync(path.join(repo, ".next", "build-info.json"), { force: true });
    fs.writeFileSync(path.join(repo, "scripts", "write-build-info.mjs"), "// stamper\n");
    try {
      const id = await collectBuildIdentity(repo);
      expect(id.build).toBeNull();
      expect(id.drift.buildVsCheckout).toBe("drift");
      expect(id.drift.codes).toContain("build-unstamped");
    } finally {
      fs.rmSync(path.join(repo, "scripts", "write-build-info.mjs"), { force: true });
    }
  });

  it("prefers the standalone tree the server actually runs from", async () => {
    const standalone = path.join(repo, ".next", "standalone", ".next");
    fs.mkdirSync(standalone, { recursive: true });
    fs.writeFileSync(path.join(standalone, "BUILD_ID"), "deployedbuild\n");
    fs.writeFileSync(
      path.join(standalone, "build-info.json"),
      JSON.stringify(buildInfo({ commit: A, buildId: "deployedbuild" }), null, 2),
    );
    // A newer, not-yet-deployed build in .next must NOT be what gets reported.
    writeBuild({ commit: headSha }, "freshbuild");
    try {
      expect(await resolveBuildDir(repo)).toBe(standalone);
      const id = await collectBuildIdentity(repo);
      expect(id.deployedBuildId).toBe("deployedbuild");
      expect(id.build?.commit).toBe(A);
      expect(id.drift.buildVsCheckout).toBe("drift");
    } finally {
      fs.rmSync(path.join(repo, ".next", "standalone"), { recursive: true, force: true });
    }
  });

  it("survives a directory that is not a git checkout", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-no-git-"));
    try {
      const id = await collectBuildIdentity(empty);
      expect(id.checkout.commit).toBeNull();
      expect(id.build).toBeNull();
      expect(id.drift.buildVsCheckout).toBe("unknown");
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
