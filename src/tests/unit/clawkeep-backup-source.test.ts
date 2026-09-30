import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

import { backupSourceFor } from "@/lib/harness/backup-source";
import { clawkeepTranslations } from "@/lib/clawkeep-translations";

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

describe("what an OpenClaw snapshot leaves out", () => {
  // TASK-1301. The core carries the whole state directory; ClawKeep's own rule
  // (`clawkeep/own_backups.py`) is what leaves the box's backups out, and the
  // "Not included" line is that rule in the customer's words.
  const rule = fs.readFileSync(path.join(process.cwd(), "clawkeep", "clawkeep", "own_backups.py"), "utf-8");

  it("names the folder the rule actually leaves out", () => {
    expect(rule).toContain('BACKUPS_DIRNAME = "backups"');
    expect(backupSourceFor("openclaw").excludesKeys).toEqual(["clawkeep.contents.openclaw.excludeBackups"]);
    const en = clawkeepTranslations.en["clawkeep.contents.openclaw.excludeBackups"];
    expect(en).toContain(`${backupSourceFor("openclaw").stateDir}/backups`);
    expect(en).toMatch(/OpenClaw's own backup files/);
  });

  it("is said in every locale the catalogue carries, naming the same folder", () => {
    for (const [locale, table] of Object.entries(clawkeepTranslations)) {
      for (const key of [
        "clawkeep.contents.openclaw.excludeBackups",
        "clawkeep.contents.leftOutLast",
        "clawkeep.leftOut.summary",
        "clawkeep.largeArchives.title",
        "clawkeep.largeArchives.body",
        "clawkeep.largeArchives.more",
        "clawkeep.largeArchives.hint",
      ]) {
        expect(table[key], `${locale} ${key}`).toBeTruthy();
        for (const param of clawkeepTranslations.en[key].match(/\{\w+\}/g) ?? []) {
          expect(table[key], `${locale} ${key} keeps ${param}`).toContain(param);
        }
      }
      expect(table["clawkeep.contents.openclaw.excludeBackups"], locale).toContain("~/.openclaw/backups");
      expect(table["clawkeep.largeArchives.hint"], locale).toContain("~/.openclaw/backups");
    }
  });
});

describe("backupSourceFor", () => {
  it("says Hermes needs no second binary installed", () => {
    // The whole reason ClawKeep was dead on Hermes: the UI gated the backup
    // button on an `openclaw` CLI that edition will never have.
    expect(backupSourceFor("hermes").requiresExternalCli).toBe(false);
  });

  it("names each edition's own state directory", () => {
    // The restore modal prints this as "where your previous contents went".
    // It said `~/.openclaw` on every box, which on Hermes is a directory the
    // agent does not use — and it is the one line a customer reads when a
    // restore has gone wrong.
    expect(backupSourceFor("hermes").stateDir).toBe("~/.hermes");
    expect(backupSourceFor("openclaw").stateDir).toBe("~/.openclaw");
  });

  it("says OpenClaw does", () => {
    expect(backupSourceFor("openclaw").requiresExternalCli).toBe(true);
  });

  it("gives every edition a non-empty contents list to render", () => {
    for (const id of ["hermes", "openclaw"] as const) {
      expect(backupSourceFor(id).includesKeys.length).toBeGreaterThan(0);
    }
  });
});
