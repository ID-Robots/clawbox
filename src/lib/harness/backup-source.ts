import type { HarnessId } from "./transport";

/**
 * What ClawKeep archives on THIS box, per harness.
 *
 * The sibling of `capabilitiesFor` in `capabilities.ts`, and deliberately a
 * separate table rather than more fields on `HarnessCapabilities`: that one
 * answers "what may the CHAT surface offer", is served to the browser by
 * `/setup-api/chat/capabilities`, and is recomputed from probed facts on every
 * chat open. Cloud backup is none of those things — it is a property of the
 * harness's on-disk shape, it does not change while the box is running, and it
 * is read by a Python daemon as often as by React. Folding it into the chat
 * table would have made every chat open answer a question about backups.
 *
 * The AUTHORITY for what a Hermes archive contains is `clawkeep/hermes.py`
 * (`ASSETS`); this is the same answer said in the UI's language, so a customer
 * reading Settings and an engineer reading the archiver see one story. The test
 * `clawkeep-backup-source.test.ts` pins the two together.
 */
export interface BackupSource {
  /**
   * Whether the archiver needs a separate CLI on PATH.
   *
   * OpenClaw's does: ClawKeep shells out to `openclaw backup create`, so a box
   * without that binary can be paired, scheduled and encrypted and still not
   * back anything up — which is why the UI has an "install openclaw" remedy at
   * all. Hermes' archiver is inside the daemon (`clawkeep/hermes.py`), so
   * there is no second thing to install and no remedy to print.
   */
  readonly requiresExternalCli: boolean;
  /**
   * Where this edition's state lives, for display.
   *
   * Used by the restore modal to name where the PREVIOUS contents are moved
   * aside to. That footer used to say `~/.openclaw.bak-restore-*` on every
   * box, which on Hermes points at a directory the agent does not use — the
   * one line a customer would reach for if a restore went wrong.
   */
  readonly stateDir: string;
  /**
   * True when the archive carries provider keys or platform tokens.
   *
   * Both editions do, and both must SAY so: the UI turns this into the warning
   * that a snapshot is a credential. It is a field rather than a constant
   * because "of course it does" is exactly the assumption that stops getting
   * checked, and a future config-only mode would flip it.
   */
  readonly containsCredentials: boolean;
  /** i18n keys for the "what's in a backup" list, in display order. */
  readonly includesKeys: readonly string[];
  /** i18n keys for the notable exclusions, in display order. */
  readonly excludesKeys: readonly string[];
}

const HERMES: BackupSource = {
  requiresExternalCli: false,
  stateDir: "~/.hermes",
  containsCredentials: true,
  includesKeys: [
    "clawkeep.contents.hermes.config",
    "clawkeep.contents.hermes.credentials",
    "clawkeep.contents.hermes.sessions",
    "clawkeep.contents.hermes.memories",
    "clawkeep.contents.hermes.skills",
    "clawkeep.contents.hermes.automation",
    "clawkeep.contents.hermes.identity",
  ],
  excludesKeys: [
    "clawkeep.contents.hermes.excludeAgent",
    "clawkeep.contents.hermes.excludeCaches",
  ],
};

const OPENCLAW: BackupSource = {
  requiresExternalCli: true,
  stateDir: "~/.openclaw",
  containsCredentials: true,
  includesKeys: [
    "clawkeep.contents.openclaw.state",
    "clawkeep.contents.openclaw.config",
    "clawkeep.contents.openclaw.credentials",
    "clawkeep.contents.openclaw.sessions",
    "clawkeep.contents.openclaw.workspace",
  ],
  excludesKeys: [],
};

export function backupSourceFor(id: HarnessId): BackupSource {
  return id === "hermes" ? HERMES : OPENCLAW;
}
