import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { backupSourceFor } from "@/lib/harness/backup-source";

/**
 * The UI's description of a backup and the archiver that makes it live in two
 * languages and two directories, and nothing but a comment keeps them in step.
 * These tests are that "nothing but a comment" replaced with a check: if
 * `clawkeep/hermes.py` starts archiving the 1.5 GB agent checkout, or stops
 * carrying credentials, the Settings card that tells the customer otherwise
 * fails here rather than in front of them.
 */

const ARCHIVER = path.join(process.cwd(), "clawkeep", "clawkeep", "hermes.py");
const source = fs.readFileSync(ARCHIVER, "utf-8");

/** The `ASSETS: tuple[...] = ( ... )` literal, which is the allowlist. */
function assetsBlock(): string {
  const start = source.indexOf("ASSETS: tuple[HermesAsset, ...] = (");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n)", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function archivedRelativePaths(): string[] {
  // HermesAsset("<kind>", "<relative>", ...)
  return [...assetsBlock().matchAll(/HermesAsset\("[^"]+",\s*"([^"]+)"/g)].map((m) => m[1]);
}

describe("what the Hermes archiver actually collects", () => {
  it.each(["hermes-agent", "bin", "cache", "image_cache", "audio_cache", "logs"])(
    "never has %s on the allowlist",
    (excluded) => {
      // The Settings card promises these are left out, and the customer's
      // storage quota depends on it being true.
      expect(archivedRelativePaths()).not.toContain(excluded);
    },
  );

  it("collects the paths the Hermes card names", () => {
    const collected = archivedRelativePaths();
    for (const expected of ["config.yaml", ".env", "state.db", "memories", "skills"]) {
      expect(collected).toContain(expected);
    }
  });

  it("agrees with the card that a Hermes snapshot carries credentials", () => {
    expect(assetsBlock()).toContain("credential_bearing=True");
    expect(backupSourceFor("hermes").containsCredentials).toBe(true);
  });
});

describe("backupSourceFor", () => {
  it("says Hermes needs no second binary installed", () => {
    // The whole reason ClawKeep was dead on Hermes: the UI gated the backup
    // button on an `openclaw` CLI that edition will never have.
    const hermes = backupSourceFor("hermes");
    expect(hermes.requiresExternalCli).toBe(false);
    expect(hermes.cliName).toBe("");
    expect(hermes.stateDir).toBe("~/.hermes");
  });

  it("says OpenClaw does", () => {
    const openclaw = backupSourceFor("openclaw");
    expect(openclaw.requiresExternalCli).toBe(true);
    expect(openclaw.cliName).toBe("openclaw");
  });

  it("gives every edition a non-empty contents list to render", () => {
    for (const id of ["hermes", "openclaw"] as const) {
      expect(backupSourceFor(id).includesKeys.length).toBeGreaterThan(0);
    }
  });
});
