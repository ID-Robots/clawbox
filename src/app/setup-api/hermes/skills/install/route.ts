export const dynamic = "force-dynamic";

import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { type HermesCliResult, runHermesCli } from "@/lib/hermes-cli";
import { checkInstallIdentifier, cliInstallIdentifier, isValidMeta, cliFailureCode } from "@/lib/hermes-skills";
import {
  type InstallOutcome,
  type InstallOutcomeKind,
  parseInstallOutcome,
} from "@/lib/hermes-skill-cli-outcome";
import {
  type HubLockEntry,
  type SkillRemovalVerdict,
  hermesSkillsGuard,
  hubLockEntry,
  invalidateInstalledCache,
  isInHubLock,
  lockInstallDir,
  officialSkillDir,
  pathState,
  readHubLock,
  readScanReport,
  readShadowableSkillNames,
  resolveLockKey,
  scanReportFromLock,
  updateLockFiles,
  verifySkillRemoval,
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
// Every refusal cleans up after ITSELF: the CLI's uninstall drops the lock
// entry, and the install directory is removed directly in case it did not — but
// only for an install this request actually made. A skill the device already
// had is left exactly as it was found, because a request to install something
// is never a licence to delete it.

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
  // quarters of the catalogue that is ClawHub. See hermes-skill-cli-outcome.
  //
  // A bare ClawHub slug has to be sent as `clawhub/<slug>` or the CLI resolves
  // nothing — see cliInstallIdentifier(). `id` itself stays as the customer
  // typed/clicked it for the catalog lookup, the lock check and the audit log.
  //
  // The lock is read FIRST, as it was before this request. `rollback()` may only
  // undo what this request did, and once the CLI has run nothing is left to say
  // which entries it found and which it wrote — the installer will not overwrite
  // its own entry, it prints "is already installed" and exits 0.
  const preLock = await readHubLock();
  const cliId = cliInstallIdentifier(id, record?.source);
  const args = ["skills", "install", cliId, "--yes"];
  if (confirmDangerous) args.push("--force");
  if (category) args.push("--category", category);
  if (name) args.push("--name", name);

  // A skill fetched from GitHub (every browse.sh row, and the github source)
  // goes over the unauthenticated GitHub API — 60 requests/hour, slow on a
  // loaded Jetson — so `hermes skills install` genuinely runs tens of seconds
  // and can pass INSTALL_TIMEOUT_MS. When it does, runHermesCli SIGKILLs the
  // child and throws "hermes timed out", discarding stdout/stderr. The old
  // catch answered with that bare phrase and stopped — but the kill races the
  // install: the files and the lock entry may already be on disk. That is the
  // same trap PR #504/#510 closed for the exit-0 refusal path, one layer up:
  // the CLI's report (here, its ABSENCE) is not the truth about what landed,
  // the lock is. So on a timeout we do not answer yet — we fall through to the
  // same `isInHubLock` check the exit-0 path uses and report what is actually
  // on the device. `timedOut` only steers the ONE branch that still needs the
  // CLI's stdout it no longer has: a genuine no-landing.
  let cli: HermesCliResult;
  let timedOut = false;
  try {
    cli = await runHermesCli(args, { timeoutMs: INSTALL_TIMEOUT_MS });
  } catch (err) {
    if (!(err instanceof Error && /timed out/i.test(err.message))) {
      // Sanitised, but still the CLI's own sentence: the code is the part the
      // store can say in the owner's language (HERMES-04).
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Hermes install failed", code: cliFailureCode(err) },
        { status: 502 },
      );
    }
    timedOut = true;
    // A neutral placeholder: from here the outcome is decided by the lock, not
    // by this object. The only consumer that reads its streams is the
    // no-landing branch, and that branch is guarded by `timedOut` below.
    cli = { code: 0, stdout: "", stderr: "" };
  }
  // The tree changed (or may have) — drop the cached installed list before we
  // answer, so the client's immediate re-fetch can't be served a stale walk.
  invalidateInstalledCache();
  if (!timedOut && cli.code !== 0) {
    // Hermes is a Python CLI: an unhandled exception prints a traceback with
    // site-packages paths and local install dirs. That never reaches the
    // browser — it is logged here and the user gets a fixed message, the same
    // rule browse/inspect follow.
    console.error("[hermes skills install] exit", cli.code, cli.stderr);
    return NextResponse.json({ error: "Install failed", code: "install_failed" }, { status: 502 });
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
    if (timedOut) {
      // Nothing landed AND the CLI was killed before it said why: we have no
      // outcome to parse, so we do not invent one. The one thing that is true
      // is that it ran out of time, and the remedy is to try again — some
      // community skills are fetched from a rate-limited GitHub and are simply
      // slow on this device. 504, because the failure is a deadline, not a bad
      // request. No raw "hermes timed out": that is the CLI's word for its own
      // SIGKILL, not a sentence a customer can act on.
      return NextResponse.json(
        {
          error:
            `Installing "${fallbackName}" took too long and was stopped, so nothing was installed. `
            + `Some community skills download from a rate-limited source and can be slow — try again in a moment.`,
          code: "install_timeout",
        },
        { status: 504 },
      );
    }
    return await refusalResponse(parseInstallOutcome(cli.stdout, cli.stderr), {
      id,
      name: fallbackName,
      source: record?.source,
      trust: record?.trust,
      confirmDangerous,
    });
  }
  const lockName = (await resolveLockKey(id)) || (cliId !== id ? await resolveLockKey(cliId) : null) || fallbackName;
  const entry = hubLockEntry(await readHubLock(), lockName);

  // Was this install already on the device before the request? Then it is not
  // this route's to remove. Asked about the KEY the install landed under,
  // against the PRE-request lock, so a second copy of the same id under another
  // key cannot be mistaken for it.
  //
  // The one pre-existing entry that IS still this route's to clear up is a
  // phantom a previous failed rollback left behind: an entry whose directory is
  // PROVABLY gone — an ENOENT, and nothing else. Everything else is left alone:
  // an entry that names no `install_path`, and a stat that failed for any other
  // reason (EACCES on the root-owned subtree this device family produces, EIO,
  // a stalled mount). "Could not check" has never been a licence to delete.
  const preEntry = hubLockEntry(preLock, lockName);
  const preDir = lockInstallDir(preEntry);
  const preInstalled =
    preEntry !== undefined && (preDir === null || (await pathState(preDir)) !== "absent");

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
    // The skill was already here, and the installer exited 0 without touching
    // it. There is nothing to refuse and nothing to undo — and undoing it would
    // uninstall a skill the customer already had, possibly one they had
    // confirmed through this very dialog. `caution` is outside CLEAN_VERDICTS,
    // so on ClawHub that is most of the catalogue.
    if (preInstalled) {
      return await alreadyInstalled(warning, {
        id,
        name: lockName,
        findingCount: findings.length,
      });
    }
    const undo = await rollback(lockName, entry);
    // A refusal we could not carry out is not the refusal the caller expects:
    // answering `dangerous_skill` here would invite a confirmation that walks
    // straight into the completeness check below, on a skill whose files this
    // rollback has already removed.
    if (!undo.clean) {
      return await rollbackIncomplete(undo, {
        id,
        name: lockName,
        cause: "This skill did not pass the device's security scan.",
        source: entry?.source,
        trust: entry?.trust_level,
        scanVerdict: verdict,
        findingCount: findings.length,
        warning,
      });
    }
    return await askTheOwner(warning, { id, findingCount: findings.length });
  }

  // ── 4. Did every file actually land? ─────────────────────────────────────
  const completeness = await verifyAndRepair(entry, record);
  if (completeness && completeness.missing.length > 0) {
    const missingFiles = completeness.missing.slice(0, 20);
    // Same rule at the second gate: an installation this request did not make is
    // not this request's to delete. A short file list is a reason to tell the
    // customer, not a licence to remove what they had — and the repair above has
    // already had its go at completing it.
    if (!preInstalled) {
      const undo = await rollback(lockName, entry);
      if (!undo.clean) {
        return await rollbackIncomplete(undo, {
          id,
          name: lockName,
          // Deliberately not "the download was incomplete": the same branch is
          // reached when the installer met a lock entry a previous rollback could
          // not remove, exited 0 without fetching anything, and there was no
          // download to blame. What is true in both cases is that the files are
          // not there.
          cause: `Some of "${lockName}"'s files are missing from the device, so it was not installed.`,
          source: entry?.source,
          trust: entry?.trust_level,
          scanVerdict: verdict,
          missingFiles,
          warning,
        });
      }
    }
    await auditSkillInstall({
      action: "install-incomplete",
      id,
      name: lockName,
      source: entry?.source,
      trust: entry?.trust_level,
      verdict,
      missingFiles,
    });
    return NextResponse.json(
      {
        // Two different true sentences, because the device is in two different
        // states: nothing of this request's survives the rollback above, but a
        // pre-existing install is still there and still the customer's.
        error: preInstalled
          ? `Some of "${lockName}"'s files are missing from the device. It was already `
            + `installed before this request, so it was left in place — remove it from the `
            + `Skills store and install it again.`
          : "The download was incomplete — the skill was not installed.",
        code: "incomplete_install",
        ...(preInstalled ? { preexisting: true } : {}),
        missingFiles,
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
 * The 409 that asks the owner, and the audit line that records the question.
 *
 * Both scan gates end here — the one that reads the lock AFTER an install and
 * the one that reads the installer's refusal BEFORE anything landed — so there
 * is a single producer of the `dangerous_skill` contract that the store's
 * confirmation dialog and the MCP decoder both consume.
 */
async function askTheOwner(
  warning: SkillDangerWarning,
  ctx: { id: string; findingCount: number },
): Promise<NextResponse> {
  await auditSkillInstall({
    action: "install-refused",
    id: ctx.id,
    name: warning.name,
    source: warning.source,
    trust: warning.trust,
    verdict: warning.verdict,
    findingCount: ctx.findingCount,
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

/**
 * How each non-scan refusal is answered.
 *
 * A table rather than a chain of branches: the kind-to-code mapping is the
 * thing a reader wants, `Record<Exclude<…>>` makes a new outcome kind a compile
 * error rather than a silent fall-through, and every entry is data.
 *
 * `blocked-other` and `unknown` share the last row on purpose — both carry free
 * text from a Python exception, which on this CLI can hold on-device paths, so
 * neither is echoed. Same rule the non-zero-exit branch already follows: log it
 * here, answer with fixed words.
 */
const REFUSALS: Record<
  Exclude<InstallOutcomeKind, "scan-refused">,
  { status: number; code: string; error: string }
> = {
  ambiguous: {
    status: 409,
    code: "ambiguous_id",
    error: "More than one skill goes by that name — install it by its full identifier.",
  },
  "already-installed": {
    status: 409,
    code: "already_installed",
    error: "That skill is already installed on this device.",
  },
  "rate-limited": {
    status: 502,
    code: "rate_limited",
    error: "The skill could not be downloaded: this device has used up its hourly GitHub API allowance.",
  },
  unfetchable: {
    status: 502,
    code: "download_failed",
    error: "The skill was found in the store but none of its sources would serve it.",
  },
  // The one case the old message was right about, and now the only one it is
  // used for — so "did not resolve" stays a meaningful diagnosis.
  unresolved: {
    status: 502,
    code: "unresolved",
    error: "Skill could not be resolved — try the full identifier",
  },
  "blocked-other": {
    status: 502,
    code: "install_failed",
    error: "The device's installer stopped without installing the skill.",
  },
  unknown: {
    status: 502,
    code: "install_failed",
    error: "The device's installer stopped without installing the skill.",
  },
};

/**
 * Answer a `hermes skills install` that exited 0 without installing anything.
 *
 * WHY this exists: the CLI exits 0 on every one of its refusals, so this route
 * inferred failure from the missing lock entry and said the only thing a
 * missing lock entry can mean on its own — "Skill could not be resolved — try
 * the full identifier". Live on a Hermes box that sentence was returned for
 * skills whose id resolved perfectly and whose INSTALL had been refused by the
 * device's own security scanner, and the MCP tool turned it into "call
 * skill_search and pass the exact id it returned" — the step the agent had just
 * taken. A tool that cannot do the thing has to say so, say why, and give a
 * next step that is not the step that just failed.
 *
 * The scanner's refusal reuses the existing `dangerous_skill` contract for the
 * case the owner can act on, so the store's dialog and the MCP decoder need no
 * new vocabulary for it.
 */
async function refusalResponse(
  outcome: InstallOutcome,
  ctx: { id: string; name: string; source?: string; trust?: string; confirmDangerous: boolean },
): Promise<NextResponse> {
  if (outcome.kind !== "scan-refused") {
    if (outcome.kind === "blocked-other" || outcome.kind === "unknown") {
      console.error("[hermes skills install] installer exited 0 without installing", outcome.kind);
    }
    const refusal = REFUSALS[outcome.kind];
    return NextResponse.json(
      {
        ...refusal,
        ...(outcome.suggestions.length ? { candidates: outcome.suggestions } : {}),
      },
      { status: refusal.status },
    );
  }

  // The installer writes its structured report to the scan cache BEFORE the
  // policy gate runs, and prints that report's digest. Reading it back gets the
  // findings with their `pattern_id` — which the rendered table does not carry
  // and which the capability buckets are keyed on — and makes both scan gates
  // describe a skill from the same source. The scraped table is the fallback
  // for a device whose cache entry has been swept.
  const cached = await readScanReport(outcome.contentHash);
  const findings = cached?.findings.length ? cached.findings : outcome.findings;
  const warning = buildDangerWarning({
    id: ctx.id,
    name: ctx.name,
    source: ctx.source,
    trust: outcome.trust ?? ctx.trust,
    verdict: outcome.verdict,
    scannerVersion: cached?.scannerVersion ?? outcome.scannerVersion,
    summary: cached?.summary ?? outcome.reason,
    findings,
  });
  const findingCount = outcome.findingCount ?? findings.length;

  // The owner CAN get past this one, and `confirmDangerous` already sends
  // `--force`, so reaching here with it set means the installer refused a
  // confirmation it had advertised as sufficient.
  if (outcome.confirmable && !ctx.confirmDangerous) {
    return await askTheOwner(warning, { id: ctx.id, findingCount });
  }

  // Nothing the owner does will get this installed: the device's installer
  // refuses a `dangerous` verdict from a community or trusted source outright
  // and says so itself. Say that, rather than blaming the id.
  await auditSkillInstall({
    action: "install-blocked-by-device",
    id: ctx.id,
    name: ctx.name,
    source: ctx.source,
    trust: warning.trust,
    verdict: outcome.verdict,
    findingCount,
    capabilities: warning.capabilities.map((c) => c.id),
    severities: warning.severityCounts,
  });
  return NextResponse.json(
    {
      error:
        `The device's installer refused to install "${ctx.name}": `
        + `its security scan returned a ${outcome.verdict ?? "failing"} verdict for a `
        + `${warning.trust ?? "third-party"} source, which it will not install even when confirmed.`,
      code: "dangerous_skill_blocked",
      requiresConfirmation: false,
      warning,
    },
    { status: 409 },
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
 * The 409 for a flagged skill the device ALREADY had.
 *
 * Not `dangerous_skill`: that answer says an install was refused, invites a
 * confirmation, and — before this — was returned after a rollback had removed
 * the customer's existing installation. Nothing was installed here and nothing
 * was removed, so the honest answer is the one the CLI itself gave, with the
 * scan verdict attached so the store can still say why the device is unhappy
 * about a skill the customer is keeping.
 */
async function alreadyInstalled(
  warning: SkillDangerWarning,
  ctx: { id: string; name: string; findingCount: number },
): Promise<NextResponse> {
  await auditSkillInstall({
    action: "install-already-installed",
    id: ctx.id,
    name: ctx.name,
    source: warning.source,
    trust: warning.trust,
    verdict: warning.verdict,
    findingCount: ctx.findingCount,
    capabilities: warning.capabilities.map((c) => c.id),
    severities: warning.severityCounts,
  });
  return NextResponse.json(
    {
      error:
        `"${ctx.name}" is already installed on this device, so nothing was installed or `
        + `removed. Its security scan returned a ${warning.verdict ?? "failing"} verdict — `
        + `remove it from the Skills store if you no longer want it.`,
      code: "already_installed",
      requiresConfirmation: false,
      removed: false,
      name: ctx.name,
      warning,
    },
    { status: 409 },
  );
}

/**
 * Undo an install this route has decided not to keep, and report what is left.
 *
 * `hermes skills uninstall` is what removes the LOCK entry, so it runs first
 * and its result is deliberately not trusted: the CLI prints its refusals and
 * still exits 0. The directory removal is the belt to that braces — a skill
 * directory left behind would be loaded by the agent even with no lock entry,
 * which is the exact failure this whole route exists to prevent.
 *
 * TASK-547 / PR #510 gave the uninstall ROUTE the post-condition that follows
 * from that distrust — a removal is only real when the lock entry is gone
 * afterwards — and this rollback, which drives the same command, kept inferring
 * success from having called it. It could not: `runHermesCli` throws on the
 * 30 s timeout a loaded Jetson hits mid-install and the throw was swallowed with
 * a console line, `removeSkillDir` returns false for a path the validator
 * refuses and its answer was discarded, and nothing re-read the lock. A refused
 * skill then stayed in the lock, `enumerateInstalledSkills` listed it as
 * installed from the hub, and the route said it had refused the install.
 *
 * So: read the outcome, both halves of it, and let the caller answer honestly.
 *
 * ONLY for an install THIS request made. Both call sites check the pre-request
 * lock first: `hermes skills install` on a skill the device already has exits 0
 * printing "is already installed" and writes nothing, which used to make the
 * scan gate uninstall the customer's existing copy and then report that it had
 * refused an install.
 */
async function rollback(
  lockName: string,
  entry: HubLockEntry | undefined,
): Promise<SkillRemovalVerdict> {
  try {
    await runHermesCli(["skills", "uninstall", lockName], {
      timeoutMs: UNINSTALL_TIMEOUT_MS,
      input: "y\n",
    });
  } catch (err) {
    console.error("[hermes skills install] rollback uninstall failed", err);
  }
  // The directory half and the post-condition, shared with the uninstall route
  // so the two surfaces cannot answer differently about one device state.
  return await verifySkillRemoval(lockName, entry);
}

/**
 * The answer for an install this route refused and could not undo.
 *
 * Distinct from both refusals it replaces, because the device is in a state
 * neither of them describes and the next step is neither of theirs: there is
 * nothing to confirm (`requiresConfirmation` is false — confirming re-enters the
 * completeness check on a skill whose files are gone) and nothing to retry until
 * the leftover is removed. The scan warning and the missing-file list are still
 * carried, so no surface loses what it already showed.
 */
async function rollbackIncomplete(
  left: SkillRemovalVerdict,
  ctx: {
    id: string;
    name: string;
    /** Why the install was being undone, as a finished sentence. */
    cause: string;
    source?: string;
    trust?: string;
    scanVerdict?: string;
    findingCount?: number;
    missingFiles?: string[];
    warning?: SkillDangerWarning | null;
  },
): Promise<NextResponse> {
  // Say only what was actually established, and no more: each unanswered state
  // gets its own sentence because the alternative — calling it removed — is the
  // false-success this change is here to stop telling, and because naming a
  // CAUSE the verdict did not establish is the same failure wearing a different
  // sentence. `unchecked` is the only state in which "the entry names no
  // location" is a fact; under `unknown` the entry named one, the check ran on
  // it, and only the answer is missing.
  const leftover = left.lockEntry
    ? left.dir === "present"
      ? `"${ctx.name}" is still listed in the Skills store and its files are still on the device`
      : left.dir === "absent"
        ? `"${ctx.name}" is still listed in the Skills store although its files were removed`
        : left.dir === "unchecked"
          ? `"${ctx.name}" is still listed in the Skills store, and the entry names no location, so whether its files are still on the device could not be checked`
          : `"${ctx.name}" is still listed in the Skills store, and whether its files were removed could not be checked`
    : `"${ctx.name}" is no longer listed in the Skills store, but its files are still on the device`;
  // A leftover the store cannot see is a leftover the store cannot remove, so
  // the two states get the two different next steps they actually have.
  const nextStep = left.lockEntry
    ? `Remove "${ctx.name}" from the Skills store, then try again.`
    : `It is not in the Skills store to remove — the leftover folder has to be deleted on the device `
      + `before this skill can be installed again.`;
  // JSON.stringify, not the bare name: this is caller-derived and a log line is
  // parsed by whoever reads the journal. Escaped, it cannot forge a second line.
  console.error(
    "[hermes skills install] rollback incomplete",
    JSON.stringify(ctx.name),
    "lockEntry:",
    left.lockEntry,
    "dir:",
    left.dir,
  );
  await auditSkillInstall({
    action: "install-rollback-incomplete",
    id: ctx.id,
    name: ctx.name,
    source: ctx.source,
    trust: ctx.warning?.trust ?? ctx.trust,
    verdict: ctx.scanVerdict,
    findingCount: ctx.findingCount,
    missingFiles: ctx.missingFiles,
    capabilities: ctx.warning?.capabilities.map((c) => c.id),
    severities: ctx.warning?.severityCounts,
  });
  return NextResponse.json(
    {
      error: `${ctx.cause} The device could not fully undo the install: ${leftover}. ${nextStep}`,
      code: "rollback_incomplete",
      requiresConfirmation: false,
      name: ctx.name,
      leftover: { lockEntry: left.lockEntry, directory: left.dir },
      ...(ctx.missingFiles?.length ? { missingFiles: ctx.missingFiles } : {}),
      ...(ctx.warning ? { warning: ctx.warning } : {}),
    },
    { status: 409 },
  );
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
