export const dynamic = "force-dynamic";

import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { checkInstallIdentifier, cliInstallIdentifier, isValidMeta } from "@/lib/hermes-skills";
import { type InstallOutcome, parseInstallOutcome } from "@/lib/hermes-skill-install-outcome";
import {
  type HubLockEntry,
  SKILLS_DIR,
  hermesSkillsGuard,
  invalidateInstalledCache,
  isInHubLock,
  lockInstallDir,
  officialSkillDir,
  readHubLock,
  readShadowableSkillNames,
  resolveLockKey,
  scanReportFromLock,
  updateLockFiles,
} from "@/lib/hermes-skills-server";
import { getCatalogRecord } from "@/lib/hermes-skill-index";
import {
  type SkillDangerWarning,
  buildDangerWarning,
  isFlaggedVerdict,
} from "@/lib/hermes-skill-capabilities";
import {
  type CompletenessReport,
  type SkillManifest,
  diffManifest,
  githubTreeManifest,
  listSkillFiles,
  referencedSupportPaths,
  removeSkillDir,
  repairFromGithub,
} from "@/lib/hermes-skill-manifest";
import { auditSkillInstall } from "@/lib/hermes-skill-audit";

// Install a Hermes skill through Hermes' own CLI. Unlike the OpenClaw store,
// this does NOT touch config-store / pref:installed_apps and does NOT reload the
// gateway — Hermes skills are agent skills on disk (~/.hermes/skills), not
// desktop apps, so there's no desktop-icon coupling. The client re-fetches the
// installed list after a success.
//
// ── TASK-452: what this route now refuses to do ─────────────────────────────
//
// Three ways a store install used to land badly on a real device, all of them
// reproduced on the QA box, none of them visible to the customer afterwards:
//
//  1. INCOMPLETE. Hermes' fetcher does not download a skill directory — it
//     downloads SKILL.md and regex-guesses the support files out of the prose
//     (tools/skills_hub.py:155-158). `anthropics/skills/skills/algorithmic-art`
//     landed 2 of 4 files, `…/skills/pdf` would land 1 of 12, and both answered
//     `{"ok":true}` with a lock entry describing the truncation as complete.
//     Now: the file list is resolved from the source, the gaps are fetched and
//     hash-verified here, and an install that still cannot be completed is
//     rolled back with the missing paths named.
//
//  2. DANGEROUS. `official/creative/simple-english` installed in 1.4 s with
//     scan_verdict `dangerous` and two CRITICAL findings, because the
//     installer's policy table allows anything at `builtin` trust
//     (tools/skills_guard.py:55-65) — while the device's own `hermes skills
//     audit` calls the same skill BLOCKED. Now: a flagged verdict at ANY trust
//     tier, `official` included, is rolled back and answered 409 with a
//     plain-language capability warning; only an explicit
//     `confirmDangerous: true` from the owner installs it, and that decision is
//     audit-logged. (Krasi's ruling, 2026-08-24: warn + confirm, never a hard
//     block.)
//
//  3. SHADOWING. A store skill whose name collides with a bundled one displaces
//     it: flat installs sort before `productivity/<name>` in the agent's dedup
//     walk, so a one-file `pdf` stub wins over the 17-file bundled `pdf`. The
//     installer's collision guard only reads the hub lock, which never contains
//     bundled skills. Now: refused up front, with the option of a distinct name.
//
// Every refusal cleans up after itself: the CLI's uninstall drops the lock
// entry, and the install directory is removed directly in case it did not.

/** How long the Hermes CLI gets for one install (scan + fetch on a Jetson). */
const INSTALL_TIMEOUT_MS = 120_000;
const UNINSTALL_TIMEOUT_MS = 30_000;

interface InstallBody {
  id?: unknown;
  category?: unknown;
  name?: unknown;
  confirmDangerous?: unknown;
}

export async function POST(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  let body: InstallBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  const category = typeof body.category === "string" ? body.category.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  // Only the literal `true` confirms. A truthy string from a hand-rolled client
  // must not be able to wave a dangerous skill through.
  const confirmDangerous = body.confirmDangerous === true;

  const idCheck = checkInstallIdentifier(id);
  if (!idCheck.ok) {
    return NextResponse.json({ error: "Invalid skill id" }, { status: 400 });
  }
  if (category && !isValidMeta(category)) {
    return NextResponse.json({ error: "Invalid category" }, { status: 400 });
  }
  if (name && !isValidMeta(name)) {
    return NextResponse.json({ error: "Invalid name" }, { status: 400 });
  }

  // ── 1. Would this shadow a bundled skill? ────────────────────────────────
  // Checked BEFORE the CLI runs: a refused install should never have touched
  // the disk, and the bundled skill it would displace must never be at risk.
  const record = await getCatalogRecord(id).catch(() => undefined);
  const conflict = await findShadowConflict(id, name, record?.name);
  if (conflict) {
    await auditSkillInstall({ action: "install-name-conflict", id, conflictsWith: conflict });
    return NextResponse.json(
      {
        error: `"${conflict}" is already a skill that came with this device.`,
        code: "bundled_conflict",
        conflictsWith: conflict,
        requiresDistinctName: true,
      },
      { status: 409 },
    );
  }

  // ── 2. Install ───────────────────────────────────────────────────────────
  // `--yes` runs non-interactively.
  //
  // `--force` is passed ONLY once the owner has confirmed. On a first attempt
  // it is deliberately withheld so the scan gate below runs on the RESULT,
  // where the verdict and its findings can be shown to the owner. But the CLI's
  // own policy table refuses some combinations BEFORE anything lands
  // (community + caution, agent-created + dangerous), and a confirmation that
  // never reaches the CLI cannot override those — which is how "warn + confirm,
  // never a hard block, every trust tier" ended up unreachable for the three
  // quarters of the catalogue that is ClawHub. See hermes-skill-install-outcome.
  //
  // A bare ClawHub slug has to be sent as `clawhub/<slug>` or the CLI resolves
  // nothing — see cliInstallIdentifier(). `id` itself stays as the customer
  // typed/clicked it for the catalog lookup, the lock check and the audit log.
  const cliId = cliInstallIdentifier(id, record?.source);
  const args = ["skills", "install", cliId, "--yes"];
  if (confirmDangerous) args.push("--force");
  if (category) args.push("--category", category);
  if (name) args.push("--name", name);

  let cli;
  try {
    cli = await runHermesCli(args, {
      timeoutMs: INSTALL_TIMEOUT_MS,
      // The installer prints its refusals through `rich`, which hard-wraps at
      // 80 columns when stdout is a pipe — splitting both the reason sentence
      // and the scan-report rows this route has to read. COLUMNS is the one
      // knob rich honours off a TTY.
      env: { COLUMNS: "400" },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Hermes install failed" },
      { status: 502 },
    );
  }
  // The tree changed (or may have) — drop the cached installed list before we
  // answer, so the client's immediate re-fetch can't be served a stale walk.
  invalidateInstalledCache();
  if (cli.code !== 0) {
    // Hermes is a Python CLI: an unhandled exception prints a traceback with
    // site-packages paths and local install dirs. That never reaches the
    // browser — it is logged here and the user gets a fixed message, the same
    // rule browse/inspect follow.
    console.error("[hermes skills install] exit", cli.code, cli.stderr);
    return NextResponse.json({ error: "Install failed" }, { status: 502 });
  }

  // Hermes' resolver can exit 0 while installing nothing (a bare id with no
  // exact match prints a "did you mean…" / disambiguation table instead).
  // Confirm the skill actually landed in the hub lock before reporting
  // success — every accepted id is a registry identifier, so it always keys
  // on a name we can check.
  const fallbackName = name || id.split("/").pop() || id;
  // Either spelling can end up in the lock's `identifier`: the CLI records what
  // the adapter returned, and ClawHub's adapter normalises `clawhub/<slug>`
  // back to the bare slug.
  const landed = (await isInHubLock(fallbackName, id))
    || (cliId !== id && (await isInHubLock(fallbackName, cliId)));
  if (!landed) {
    return await refusalResponse(parseInstallOutcome(cli.stdout, cli.stderr), {
      id,
      name: fallbackName,
      source: record?.source,
      trust: record?.trust,
      confirmDangerous,
    });
  }
  const lockName = (await resolveLockKey(id)) || (cliId !== id ? await resolveLockKey(cliId) : null) || fallbackName;
  const entry = (await readHubLock())[lockName];

  // ── 3. Did the scanner flag it? ──────────────────────────────────────────
  const report = scanReportFromLock(entry);
  const findings = report?.findings ?? [];
  const verdict = entry?.scan_verdict ?? report?.verdict;
  const flagged = isFlaggedVerdict(verdict, findings);
  const warning: SkillDangerWarning | null = flagged
    ? buildDangerWarning({
        id,
        name: lockName,
        source: entry?.source ?? record?.source,
        trust: entry?.trust_level ?? record?.trust,
        verdict,
        scannerVersion: report?.scannerVersion,
        summary: report?.summary,
        findings,
      })
    : null;

  if (warning && !confirmDangerous) {
    await rollback(lockName, entry);
    await auditSkillInstall({
      action: "install-refused",
      id,
      name: lockName,
      source: warning.source,
      trust: warning.trust,
      verdict,
      findingCount: findings.length,
      capabilities: warning.capabilities.map((c) => c.id),
      severities: warning.severityCounts,
    });
    return NextResponse.json(
      {
        error: "This skill did not pass the device's security scan.",
        code: "dangerous_skill",
        requiresConfirmation: true,
        warning,
      },
      { status: 409 },
    );
  }

  // ── 4. Did every file actually land? ─────────────────────────────────────
  const completeness = await verifyAndRepair(entry, record);
  if (completeness && completeness.missing.length > 0) {
    await rollback(lockName, entry);
    await auditSkillInstall({
      action: "install-incomplete",
      id,
      name: lockName,
      source: entry?.source,
      trust: entry?.trust_level,
      verdict,
      missingFiles: completeness.missing.slice(0, 20),
    });
    return NextResponse.json(
      {
        error: "The download was incomplete — the skill was not installed.",
        code: "incomplete_install",
        missingFiles: completeness.missing.slice(0, 20),
        expectedCount: completeness.expectedCount,
        presentCount: completeness.presentCount,
        manifestOrigin: completeness.origin,
      },
      { status: 502 },
    );
  }

  if (warning) {
    // The owner read the warning and said yes. Record who, when and to what.
    await auditSkillInstall({
      action: "install-confirmed",
      id,
      name: lockName,
      source: warning.source,
      trust: warning.trust,
      verdict,
      findingCount: findings.length,
      capabilities: warning.capabilities.map((c) => c.id),
      severities: warning.severityCounts,
    });
  }

  // A repair wrote files the lock's `files[]` does not list, and every surface
  // downstream repeats that array as the skill's contents. Correct it, then
  // drop the cache so the client's refresh sees the repaired tree.
  if (completeness && completeness.repaired.length > 0) {
    await updateLockFiles(lockName, completeness.manifestFiles);
  }
  invalidateInstalledCache();

  // Return the resolved lock key: it's the argument `uninstall` needs, and
  // returning it lets the client update its state without re-deriving a name.
  return NextResponse.json({
    ok: true,
    id,
    name: lockName,
    verdict,
    confirmedDangerous: warning ? true : undefined,
    warning: warning ?? undefined,
    files: completeness
      ? {
          origin: completeness.origin,
          expected: completeness.expectedCount,
          present: completeness.presentCount,
          repaired: completeness.repaired,
        }
      : undefined,
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Answer a `hermes skills install` that exited 0 without installing anything.
 *
 * WHY this exists: the CLI exits 0 on every one of its refusals, so for years
 * this route inferred failure from the missing lock entry and said the only
 * thing a missing lock entry can mean on its own — "Skill could not be resolved
 * — try the full identifier". Live on a Hermes box that sentence was returned
 * for skills whose id resolved perfectly and whose INSTALL had been refused by
 * the device's own security scanner, and the MCP tool turned it into "call
 * skill_search and pass the exact id it returned" — the step the agent had just
 * taken. A tool that cannot do the thing has to say so, say why, and give a
 * next step that is not the step that just failed.
 *
 * Every branch below therefore reports the installer's OWN outcome. The
 * scanner's refusal reuses the existing `dangerous_skill` contract so the
 * store's confirmation dialog and the MCP decoder need no new vocabulary for
 * the case the owner can act on.
 */
async function refusalResponse(
  outcome: InstallOutcome,
  ctx: { id: string; name: string; source?: string; trust?: string; confirmDangerous: boolean },
): Promise<NextResponse> {
  if (outcome.kind === "scan-refused") {
    const warning = buildDangerWarning({
      id: ctx.id,
      name: ctx.name,
      source: ctx.source,
      trust: outcome.trust ?? ctx.trust,
      verdict: outcome.verdict,
      scannerVersion: outcome.scannerVersion,
      summary: outcome.reason,
      findings: outcome.findings,
    });
    await auditSkillInstall({
      action: outcome.confirmable ? "install-refused" : "install-blocked-by-device",
      id: ctx.id,
      name: ctx.name,
      source: ctx.source,
      trust: outcome.trust ?? ctx.trust,
      verdict: outcome.verdict,
      findingCount: outcome.findingCount ?? outcome.findings.length,
      capabilities: warning.capabilities.map((c) => c.id),
      severities: warning.severityCounts,
    });

    // The owner CAN get past this one — same 409 the post-install gate returns,
    // so one dialog and one MCP branch cover both. `confirmDangerous` already
    // sends `--force`, so reaching here with it set means the installer refused
    // a confirmation it had advertised as sufficient.
    if (outcome.confirmable && !ctx.confirmDangerous) {
      return NextResponse.json(
        {
          error: "This skill did not pass the device's security scan.",
          code: "dangerous_skill",
          requiresConfirmation: true,
          warning,
        },
        { status: 409 },
      );
    }

    // Nothing the owner does will get this installed: the device's installer
    // refuses a `dangerous` verdict from a community or trusted source outright
    // and says so itself. Say that, rather than blaming the id.
    return NextResponse.json(
      {
        error:
          `The device's installer refused to install "${ctx.name}": `
          + `its security scan returned a ${outcome.verdict ?? "failing"} verdict for a `
          + `${outcome.trust ?? ctx.trust ?? "third-party"} source, which it will not install even when confirmed.`,
        code: "dangerous_skill_blocked",
        requiresConfirmation: false,
        overridable: false,
        reason: outcome.reason,
        warning,
      },
      { status: 409 },
    );
  }

  if (outcome.kind === "ambiguous") {
    return NextResponse.json(
      {
        error: "More than one skill goes by that name — install it by its full identifier.",
        code: "ambiguous_id",
      },
      { status: 409 },
    );
  }

  if (outcome.kind === "already-installed") {
    return NextResponse.json(
      {
        error: `"${ctx.name}" is already installed on this device.`,
        code: "already_installed",
      },
      { status: 409 },
    );
  }

  if (outcome.kind === "rate-limited") {
    return NextResponse.json(
      {
        error:
          "The skill could not be downloaded: this device has used up its hourly GitHub API allowance.",
        code: "rate_limited",
      },
      { status: 502 },
    );
  }

  if (outcome.kind === "unfetchable") {
    return NextResponse.json(
      {
        error: "The skill was found in the store but none of its sources would serve it.",
        code: "download_failed",
      },
      { status: 502 },
    );
  }

  if (outcome.kind === "unresolved") {
    // The one case the old message was right about, and now the only one it is
    // used for — so "did not resolve" stays a meaningful diagnosis.
    return NextResponse.json(
      {
        error: "Skill could not be resolved — try the full identifier",
        code: "unresolved",
        ...(outcome.suggestions.length ? { candidates: outcome.suggestions } : {}),
      },
      { status: 502 },
    );
  }

  // `blocked-other` and `unknown` carry free text from an exception, which on a
  // Python CLI can hold on-device paths. Same rule the non-zero-exit branch
  // follows: log it here, answer with fixed words.
  console.error("[hermes skills install] installer exited 0 without installing", outcome.kind);
  return NextResponse.json(
    {
      error: "The device's installer stopped without installing the skill.",
      code: "install_failed",
    },
    { status: 502 },
  );
}

/**
 * The bundled/local skill name an install would displace, or null.
 *
 * Both candidate names are checked: the one the id implies (the installer's
 * default) and any explicit `--name` override, because the override is exactly
 * the escape hatch a customer is offered after a first refusal and it must not
 * be able to walk straight back into the collision.
 */
async function findShadowConflict(
  id: string,
  overrideName: string,
  catalogName?: string,
): Promise<string | null> {
  const taken = await readShadowableSkillNames();
  if (overrideName) return taken.has(overrideName) ? overrideName : null;
  for (const candidate of [id.split("/").pop() || id, catalogName]) {
    if (candidate && taken.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Undo an install this route has decided not to keep.
 *
 * `hermes skills uninstall` is what removes the LOCK entry, so it runs first
 * and its result is deliberately not trusted: the CLI prints its refusals and
 * still exits 0. The directory removal is the belt to that braces — a skill
 * directory left behind would be loaded by the agent even with no lock entry,
 * which is the exact failure this whole route exists to prevent.
 */
async function rollback(lockName: string, entry: HubLockEntry | undefined): Promise<void> {
  try {
    await runHermesCli(["skills", "uninstall", lockName], {
      timeoutMs: UNINSTALL_TIMEOUT_MS,
      input: "y\n",
    });
  } catch (err) {
    console.error("[hermes skills install] rollback uninstall failed", err);
  }
  const installPath = entry?.install_path;
  if (installPath) await removeSkillDir(SKILLS_DIR, installPath);
  invalidateInstalledCache();
}

interface VerifiedCompleteness extends CompletenessReport {
  repaired: string[];
  /** Every path the resolved manifest expects — the corrected lock `files[]`. */
  manifestFiles: string[];
}

/**
 * Resolve what the skill SHOULD contain, compare it with what is on disk, fetch
 * whatever the installer skipped, and report anything still absent.
 *
 * Returns null when no manifest could be resolved at all (an offline device
 * with a non-GitHub, non-official skill and a SKILL.md that names no support
 * files). That is not a failure: it means there is nothing to contradict, and
 * a device with no network must still be able to install.
 */
async function verifyAndRepair(
  entry: HubLockEntry | undefined,
  record: { source?: string; repo?: string; repoPath?: string; localPath?: string } | undefined,
): Promise<VerifiedCompleteness | null> {
  const installDir = lockInstallDir(entry);
  if (!installDir) return null;

  const onDisk = await listSkillFiles(installDir);
  // An install with no SKILL.md is not an install.
  if (!onDisk.has("SKILL.md")) {
    return {
      origin: "skill-md",
      missing: ["SKILL.md"],
      mismatched: [],
      expectedCount: 1,
      presentCount: 0,
      repaired: [],
      manifestFiles: ["SKILL.md"],
    };
  }

  const manifest = await resolveManifest(installDir, record);
  if (!manifest) return null;

  let diff = diffManifest(manifest, onDisk);
  let repaired: string[] = [];

  // Only the GitHub tree publishes a per-file object id, and a file we cannot
  // verify is a file we will not write into a directory the agent reads.
  if (diff.missing.length > 0 && manifest.origin === "github-tree" && record?.repo) {
    const result = await repairFromGithub(record.repo, installDir, manifest, diff.missing);
    repaired = result.repaired;
    if (repaired.length > 0) diff = diffManifest(manifest, await listSkillFiles(installDir));
  }
  return { ...diff, repaired, manifestFiles: manifest.files.map((f) => f.path) };
}

async function resolveManifest(
  installDir: string,
  record: { source?: string; repo?: string; repoPath?: string; localPath?: string } | undefined,
): Promise<SkillManifest | null> {
  // (a) The repo's own git tree — the only COMPLETE answer, and the only one
  //     that can repair. One API call, `recursive=1`, HEAD resolves whichever
  //     default branch the repo uses.
  if (record?.repo && record.repoPath) {
    const files = await githubTreeManifest(record.repo, record.repoPath);
    if (files) return { origin: "github-tree", files, complete: true };
  }

  // (b) `official/*` skills ship inside the agent checkout, so this device
  //     already holds the authoritative list — offline, no API call.
  if (record?.localPath) {
    const sourceDir = officialSkillDir(record.localPath);
    if (sourceDir) {
      const source = await listSkillFiles(sourceDir);
      if (source.size > 0) {
        return {
          origin: "official-disk",
          files: Array.from(source, ([path, size]) => ({ path, size })).sort((a, b) =>
            a.path.localeCompare(b.path),
          ),
          complete: true,
        };
      }
    }
  }

  // (c) Last resort: every relative path the installed SKILL.md itself names.
  //     Incomplete by construction, but it catches the case that actually hurt
  //     a customer — a SKILL.md telling the agent to read REFERENCE.md when
  //     REFERENCE.md was never fetched.
  const skillMd = await readInstalledSkillMd(installDir);
  if (!skillMd) return null;
  const referenced = referencedSupportPaths(skillMd);
  if (!referenced.length) return null;
  return { origin: "skill-md", files: referenced.map((path) => ({ path })), complete: false };
}

async function readInstalledSkillMd(installDir: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(installDir, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}
