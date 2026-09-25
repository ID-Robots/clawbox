import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { translations } from "@/lib/translations";
import { displayVersion, releaseLineOf, WHATS_NEW_RELEASE } from "@/lib/whats-new";

/**
 * TASK-1195: every surface that names the running release names the SAME one,
 * read off the shipped files rather than fixtures that can agree with a stale
 * number for ever.
 *
 * The release build still called itself 4.0.0 on real boxes, and its What's new
 * card was keyed "4.0", so an owner who had closed the 4.0 card would never
 * have been shown 4.1's. The surfaces are:
 *
 *   package.json ─┬─ readClawboxVersion() → /setup-api/update/versions → System Update, About
 *                 ├─ next.config.ts NEXT_PUBLIC_APP_VERSION → About until that route answers
 *                 └─ /setup-api/whats-new version, and WHATS_NEW_RELEASE → the card
 *
 * A minor bump (`npm version 4.2.0`) without a new card fails here, on purpose:
 * the card would otherwise go on announcing 4.1, or show nothing at all.
 */

// Imports next.config and the updater: longer than vitest's 5 s default on a
// loaded CI runner. See src/tests/unit/test-timeout-hygiene.test.ts.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PACKAGE_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf-8")) as { version: string }).version;
const PREVIOUS_RELEASE = "4.0";

vi.mock("@/lib/edition-source", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/edition-source")>()),
  readEditionSource: vi.fn(() => ({ edition: "openclaw", defaulted: false })),
}));

describe("the release the box ships", () => {
  it("is 4.1.0", () => {
    expect(PACKAGE_VERSION).toBe("4.1.0");
  });

  it("is the release line the What's new card announces", () => {
    const [major, minor] = releaseLineOf(PACKAGE_VERSION) ?? [];
    expect(WHATS_NEW_RELEASE).toBe(`${major}.${minor}`);
    expect(WHATS_NEW_RELEASE).not.toBe(PREVIOUS_RELEASE);
  });
});

describe("About, System Update, the update status API and the card agree", () => {
  let root: string;
  const savedRoot = process.env.CLAWBOX_ROOT;
  const savedAppVersion = process.env.NEXT_PUBLIC_APP_VERSION;

  beforeEach(() => {
    // A box whose checkout is this one: the shipped package.json, and an owner
    // who closed the 4.0 card on the previous build.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "clawbox-release-identity-"));
    fs.copyFileSync(path.join(REPO_ROOT, "package.json"), path.join(root, "package.json"));
    fs.mkdirSync(path.join(root, "data"));
    fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ whats_new_dismissed: PREVIOUS_RELEASE }));
    process.env.CLAWBOX_ROOT = root;
    vi.resetModules();
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.CLAWBOX_ROOT;
    else process.env.CLAWBOX_ROOT = savedRoot;
    if (savedAppVersion === undefined) delete process.env.NEXT_PUBLIC_APP_VERSION;
    else process.env.NEXT_PUBLIC_APP_VERSION = savedAppVersion;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("all name package.json's version", async () => {
    const { default: nextConfig } = await import("../../../next.config");
    const buildTime = nextConfig.env?.NEXT_PUBLIC_APP_VERSION;
    const { readClawboxVersion } = await import("@/lib/updater");
    const statusCurrent = await readClawboxVersion();
    const { GET } = await import("@/app/setup-api/whats-new/route");
    const card = await (await GET()).json();

    // The update status API's `clawbox.current`: what System Update and About print.
    expect(statusCurrent).toBe(`v${PACKAGE_VERSION}`);
    // About's fallback, the same string, so the row cannot change as the route answers.
    expect(buildTime).toBe(statusCurrent);
    // The card's subtitle.
    expect(card.version).toBe(PACKAGE_VERSION);
    expect(new Set([statusCurrent, buildTime, card.version].map((v) => displayVersion(v)))).toEqual(new Set([PACKAGE_VERSION]));
  });

  it("the card is shown on this release to a box that dismissed the previous one", async () => {
    const { GET } = await import("@/app/setup-api/whats-new/route");
    const card = await (await GET()).json();
    expect(card).toMatchObject({ show: true, release: WHATS_NEW_RELEASE, version: PACKAGE_VERSION });
  });

  it("About's fallback agrees when package.json cannot be read at run time", async () => {
    const { default: nextConfig } = await import("../../../next.config");
    process.env.NEXT_PUBLIC_APP_VERSION = nextConfig.env?.NEXT_PUBLIC_APP_VERSION;
    fs.rmSync(path.join(root, "package.json"));
    const { readClawboxVersion } = await import("@/lib/updater");
    const { GET } = await import("@/app/setup-api/whats-new/route");
    const card = await (await GET()).json();

    expect(await readClawboxVersion()).toBe(`v${PACKAGE_VERSION}`);
    expect(displayVersion(card.version)).toBe(PACKAGE_VERSION);
    expect(card.show).toBe(true);
  });
});

describe("every catalogue names the release the card announces", () => {
  // The card's own chrome. A highlight may still say "before 4.0" — that is
  // history, not the card's identity — so only these four are held to it.
  const CHROME = ["whatsNew.title", "whatsNew.highlightsLabel", "whatsNew.readMore", "whatsNew.dismiss"];
  const previous = new RegExp(`(^|[^\\d.])${PREVIOUS_RELEASE.replace(".", "\\.")}(?![\\d])`);

  it.each(Object.keys(translations))("%s", (locale) => {
    const table = translations[locale as keyof typeof translations];
    for (const key of CHROME) {
      expect(table[key], `${locale} ${key}`).toContain(WHATS_NEW_RELEASE);
      expect(table[key], `${locale} ${key} still names ${PREVIOUS_RELEASE}`).not.toMatch(previous);
    }
  });
});

describe("the release-facing documents follow the release", () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");

  it("has release notes for this version, headed with it", () => {
    expect(read(`RELEASE-NOTES-${PACKAGE_VERSION}.md`).split("\n")[0]).toBe(`# ClawBox ${PACKAGE_VERSION}`);
  });

  it("the README points at this version's release notes", () => {
    expect(read("README.md")).toContain(`](RELEASE-NOTES-${PACKAGE_VERSION}.md)`);
  });

  it("the docs page the card links to leads with this release", () => {
    const firstRelease = /^## (ClawBox .+)$/m.exec(read("docs-site/whats-new.mdx"))?.[1];
    expect(firstRelease).toBe(`ClawBox ${WHATS_NEW_RELEASE}`);
  });

  it("the previous release's notes still describe the previous release", () => {
    const notes = read("RELEASE-NOTES-4.0.0.md");
    expect(notes.split("\n")[0]).toBe("# ClawBox 4.0.0");
    expect(notes).toContain("OpenClaw is pinned to 2026.9.3.");
  });
});
