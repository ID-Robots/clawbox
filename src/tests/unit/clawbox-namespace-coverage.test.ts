import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  CLAWBOX_API_ROOTS,
  CLAWBOX_PAGE_ROOTS,
  UNCLAIMED_ROOTS,
} from "@/lib/clawbox-namespaces";

/**
 * The guard that keeps src/lib/clawbox-namespaces.ts honest as the route tree
 * grows.
 *
 * WHY IT EXISTS. That module answers "is this top-level path ClawBox's or the
 * gateway's", and the catch-all serves a NAVIGATION it does not claim with the
 * Control UI shell — into which `serveGatewayHTML` injects the gateway auth
 * token for an owner session. A namespace missing from the list is therefore
 * not a cosmetic gap: an unmatched path under it is answered with somebody
 * else's application and a credential in it.
 *
 * `/app` was missed exactly this way (#675 review H-1,
 * `src/app/app/[id]/page.tsx`): a dynamic `[id]` segment is REQUIRED, so the
 * namespace root itself matches no route and falls through to the catch-all,
 * and the list had been written by reading `src/app/` once while `src/app/`
 * kept growing.
 *
 * So the list stops being derived by hand. `src/app/` IS the route table —
 * that is Next's file-system routing convention, and it is the only
 * enumeration of top-level segments that cannot drift from the router. This
 * test reads it and fails when a directory is in neither the ClawBox lists nor
 * `UNCLAIMED_ROOTS`, which turns "nobody noticed" into a failing build and
 * forces a decision. Being forced to make that decision is what established
 * that `/apps` must NOT be claimed and that the two favicon directories are
 * the gateway's — neither was in any list before.
 *
 * It is a TEST rather than a runtime lookup for two reasons, and NOT because
 * middleware cannot read a file (it declares `runtime: "nodejs"` and reads
 * `data/config.json` on every request): `output: "standalone"` does not ship
 * `src/` to the box, and Next's own route manifest
 * (`.next/app-path-routes-manifest.json`) exists only after a production
 * build, which a unit run has not done.
 */

const REPO = path.resolve(__dirname, "../../..");
const APP_DIR = path.join(REPO, "src", "app");

/**
 * Directories in `src/app/` that never become a URL segment of their own:
 *
 *   `[...]` / `[[...]]`  dynamic and catch-all segments — `[...gateway]` IS the
 *                        fall-through this whole module exists to fence off
 *   `_...`               Next's private folders, never routed
 */
function isRouted(name: string): boolean {
  return !/^[[_]/.test(name);
}

/**
 * Next STRIPS a route group `(x)` and a parallel slot `@y` from the URL, so
 * `src/app/(desktop)/studio/page.tsx` serves `/studio` — the child is the
 * top-level segment, not the wrapper. Skipping these directories rather than
 * descending through them would leave the guard blind to exactly the namespace
 * it exists to catch: `src/app/page.tsx` is large enough that splitting the
 * desktop into `src/app/(desktop)/…` is the obvious next move, and a namespace
 * added under it would reach the catch-all with the guard still green.
 */
function isTransparentWrapper(name: string): boolean {
  return /^[(@]/.test(name);
}

/** Every literal top-level URL segment, seen through Next's routing rules. */
function topLevelRouteSegments(dir: string = APP_DIR): string[] {
  const segments = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && isRouted(entry.name))
    .flatMap((entry) =>
      isTransparentWrapper(entry.name)
        ? topLevelRouteSegments(path.join(dir, entry.name))
        : [entry.name],
    );

  return [...new Set(segments)].sort();
}

const CLAWBOX_ROOTS: readonly string[] = [...CLAWBOX_API_ROOTS, ...CLAWBOX_PAGE_ROOTS];
const ALL_ROOTS: readonly string[] = [...CLAWBOX_ROOTS, ...UNCLAIMED_ROOTS];

describe("clawbox-namespaces covers the app router's top-level route tree", () => {
  it("classifies every top-level route directory as ClawBox's or the gateway's", () => {
    const unclassified = topLevelRouteSegments().filter(
      (segment) => !ALL_ROOTS.includes(`/${segment}`),
    );

    // The message carries the fix, because whoever trips this is adding a
    // feature and not reading this file: an unmatched path under a new
    // ClawBox namespace is answered with the gateway shell and the injected
    // token until its root is listed.
    expect(
      unclassified,
      `src/app/${unclassified.join(", src/app/")} is a top-level route directory that `
        + "src/lib/clawbox-namespaces.ts does not classify. Add its root to "
        + "CLAWBOX_API_ROOTS or CLAWBOX_PAGE_ROOTS if it is ClawBox's, or to "
        + "UNCLAIMED_ROOTS if the catch-all should keep serving it.",
    ).toEqual([]);
  });

  it("sees a namespace nested under a route group", () => {
    // The guard's own blind spot, pinned: a wrapper Next strips from the URL
    // must not hide its children. Asserted on the shape of the walk rather
    // than on a fixture directory, so it stays true with no `(group)` in the
    // tree today.
    expect(isTransparentWrapper("(desktop)")).toBe(true);
    expect(isTransparentWrapper("@modal")).toBe(true);
    expect(isTransparentWrapper("apps")).toBe(false);
    expect(isRouted("[...gateway]")).toBe(false);
    expect(isRouted("_private")).toBe(false);
  });

  it("claims no namespace that has no route directory", () => {
    // The other direction: a root left behind after its directory was renamed
    // or deleted 404s a path the gateway may legitimately own.
    const segments = topLevelRouteSegments();
    const stale = CLAWBOX_ROOTS.filter(
      (root) => !segments.includes(root.replace(/^\//, "")),
    );

    expect(
      stale,
      `${stale.join(", ")} is claimed by src/lib/clawbox-namespaces.ts but has no `
        + "matching src/app/ directory, so the catch-all now 404s it for nothing.",
    ).toEqual([]);
  });

  it("gives each root exactly one owner", () => {
    const duplicated = ALL_ROOTS.filter(
      (root, i) => ALL_ROOTS.indexOf(root) !== i,
    );

    expect(duplicated, `${duplicated.join(", ")} is listed twice`).toEqual([]);
  });
});
