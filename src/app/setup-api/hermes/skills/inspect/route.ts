export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runSkillsCli } from "@/lib/hermes-skills-cli";
import {
  type HermesSkill,
  type HermesSkillDetail,
  type SkillProvenance,
  type SkillRequirements,
  CLI_FAILURE_SENTENCES,
  checkInstallIdentifier,
  cliFailureCode,
  cliInstallIdentifier,
  REQUEST_REFUSAL,
  SKILL_DOCS_CLI_TIMEOUT_MS,
} from "@/lib/hermes-skills";
import { parseAmbiguousSkills } from "@/lib/hermes-skill-cli-outcome";
import {
  type HubLockEntry,
  findInstalledSkill,
  hermesSkillsGuard,
  probeCommands,
  readOfficialSkillMarkdown,
  readScanReport,
  scanReportFromLock,
  statSkillDir,
  invalidArgument,
} from "@/lib/hermes-skills-server";
import { getCatalogRecord } from "@/lib/hermes-skill-index";
import { extractHeadings, parseSkillFrontmatter, type SkillFrontmatter } from "@/lib/hermes-skill-frontmatter";

// Deep detail for a single skill, backing the store's detail view — in TWO
// phases, because the CLI is the slow, lossy part:
//
//   phase 1 (?id=…)          NEVER spawns the CLI. Installed skill → its full
//                            SKILL.md off disk + the lock overlay (scan report,
//                            timestamps, size). Not installed but `official` →
//                            the same file from hermes-agent/optional-skills.
//                            Otherwise → the catalog record's metadata alone.
//   phase 2 (?id=…&docs=1)   runs `hermes skills inspect <id>` and returns ONLY
//                            the documentation delta, for the remote skills
//                            where phase 1 has no body (needsRemoteDocs).
//
// `hermes skills inspect` has no --json: it prints Rich TUI panels, wraps at the
// terminal width and DELETES unquoted flow sequences (`platforms: [linux]`
// renders as `platforms:`). So the preview contributes prose only — every list
// field comes from a file we read ourselves or from the catalog.
//
// Safety: guard first (404 unless the active harness is Hermes); the id is
// validated with the shared install-identifier check and passed POSITIONALLY
// via runHermesCli (argv-only, no shell). Errors never leak the binary path.

// ── Rich-panel parsing ─────────────────────────────────────────────────────
const BOX_RE = /[│┃╭╮╰╯─═━┌┐└┘┏┓┗┛├┤┬┴┼]/;
// Content rows are wrapped in vertical bars; capture the interior.
const CONTENT_RE = /^[│┃](.*)[│┃][ \t]*$/;
// A panel title is embedded in the top border: `──── Skill: name ────`.
const TITLE_RE = /[─═━]\s+([^─═━]+?)\s+[─═━]/;

// Only these keys start a new field in the Skill panel; every other line is a
// continuation of the previous value (Rich wraps long descriptions).
//
// REGRESSION GUARD: a key that is MISSING from this list does not merely go
// unread — its whole line is appended to the previous field, which is how
// `Repo:` used to end up holding "https://… Detail Page: https://…" and render
// as a broken link. Add any new panel key here, not just the ones we display.
const FIELD_KEYS = [
  "Name",
  "Description",
  "Source",
  "Trust",
  "Identifier",
  "Tags",
  "Category",
  "Repo",
  "Detail Page",
  "Index",
  "Endpoint",
  "Install Command",
  "Installs",
  "Weekly Installs",
  "Security",
  "Security Audits",
  "Revision",
];

interface ParsedInspect {
  fields: Record<string, string>;
  preview: string | null;
  hasSkillPanel: boolean;
}

function parseFields(lines: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let matched = false;
    for (const key of FIELD_KEYS) {
      if (t.startsWith(`${key}:`)) {
        out[key] = t.slice(key.length + 1).trim();
        currentKey = key;
        matched = true;
        break;
      }
    }
    if (!matched && currentKey) {
      out[currentKey] = `${out[currentKey]} ${t}`.trim();
    }
  }
  return out;
}

function parseInspect(stdout: string): ParsedInspect {
  const buckets: { title: string; lines: string[] }[] = [];
  let current: { title: string; lines: string[] } | null = null;

  for (const raw of stdout.split(/\r?\n/)) {
    const content = raw.match(CONTENT_RE);
    if (!content) {
      // Not a content row. A border line may carry a panel title.
      if (BOX_RE.test(raw)) {
        const t = raw.match(TITLE_RE);
        if (t) {
          current = { title: t[1].trim(), lines: [] };
          buckets.push(current);
        }
      }
      continue;
    }
    let inner = content[1];
    if (inner.startsWith(" ")) inner = inner.slice(1); // one Rich pad space
    inner = inner.replace(/[ \t]+$/, "");
    if (!current) {
      current = { title: "", lines: [] };
      buckets.push(current);
    }
    current.lines.push(inner);
  }

  const skillBucket = buckets.find((b) => /^Skill:/.test(b.title));
  const previewBucket = buckets.find((b) => /SKILL\.md Preview/i.test(b.title));

  let preview: string | null = null;
  if (previewBucket) {
    preview = previewBucket.lines.join("\n").replace(/\n?\.\.\.\s*\(\d+ more lines\)\s*$/, "");
  }

  return {
    fields: skillBucket ? parseFields(skillBucket.lines) : {},
    preview,
    hasSkillPanel: !!skillBucket,
  };
}

/**
 * `inspect <bare name>` can print a disambiguation table instead of a panel
 * ("Multiple skills named 'notion' found" → 11 rows), so the store can offer
 * the choice rather than dead-ending on "not found". `install` prints the same
 * table for the same reason, so the row parsing is shared.
 */
function parseAmbiguity(stdout: string): HermesSkill[] {
  return parseAmbiguousSkills(stdout).map(({ identifier, source, trust }) => ({
    id: identifier,
    name: identifier.split("/").pop() || identifier,
    source,
    trust,
  }));
}

// ── Small helpers ───────────────────────────────────────────────────────────

function httpsOnly(value?: string): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  return /^https:\/\/[^\s<>"']+$/i.test(v) ? v : undefined;
}

/**
 * Best-effort source URL from source + identifier. Only emitted when confident
 * and always flagged UNVERIFIED, so the UI can label it as a guess. Never used
 * when the lock metadata or the catalog carries a published URL.
 */
function deriveSourceUrl(source: string | undefined, identifier: string): string | undefined {
  const seg = identifier.split("/").filter(Boolean);
  if (source === "github" && seg.length >= 2) {
    // github ids are `<owner>/<repo>/<path…>`.
    return `https://github.com/${seg[0]}/${seg[1]}`;
  }
  if (source === "browse-sh" && seg.length >= 2 && seg[0] === "browse-sh") {
    const host = seg[1];
    if (host === "github.com" && seg.length >= 4) return `https://github.com/${seg[2]}/${seg[3]}`;
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) return `https://${host}`;
  }
  return undefined;
}

function lockMetaUrl(lock: HubLockEntry | undefined, key: string): string | undefined {
  const raw = lock?.metadata?.[key];
  return typeof raw === "string" ? httpsOnly(raw) : undefined;
}

async function requirementsFrom(fm: SkillFrontmatter, probe: boolean): Promise<SkillRequirements | undefined> {
  const hasAny =
    fm.prerequisiteCommands.length ||
    fm.prerequisiteEnvVars.length ||
    fm.dependencies.length ||
    fm.credentialFiles.length ||
    fm.compatibility ||
    fm.setup;
  if (!hasAny) return undefined;

  // We probe PATH whenever the skill's own file is on disk — including an
  // `official` skill the user hasn't installed yet. Knowing that `memo` is
  // missing BEFORE installing is exactly the point of the requirements card,
  // and the probe is a handful of fs.access calls against this same device.
  const found = probe && fm.prerequisiteCommands.length ? await probeCommands(fm.prerequisiteCommands) : null;

  return {
    commands: fm.prerequisiteCommands.map((name) => ({
      name,
      present: found ? (found[name] ?? null) : null,
    })),
    envVars: fm.prerequisiteEnvVars,
    dependencies: fm.dependencies,
    credentialFiles: fm.credentialFiles,
    compatibility: fm.compatibility,
    setupHelp: fm.setup?.help,
    setupHelpUrl: fm.setup?.helpUrl,
    secrets: (fm.setup?.secrets || []).map((s) => ({
      label: s.label,
      envVar: s.envVar,
      providerUrl: s.providerUrl,
    })),
  };
}

const MAX_BODY_CHARS = 120_000;

function clampBody(body: string): string {
  return body.length > MAX_BODY_CHARS ? `${body.slice(0, MAX_BODY_CHARS)}\n\n…` : body;
}

// ── Route ───────────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  const params = new URL(request.url).searchParams;
  const id = (params.get("id") || "").trim();
  const wantDocs = params.get("docs") === "1";
  // The store says WHERE the id came from. A bare registry identifier and an
  // installed skill's directory name look identical (40 clawhub ids collide
  // with a bundled skill on this device), so only a request that came from the
  // Installed tab may resolve a bare name against the disk.
  const fromInstalled = params.get("scope") === "installed";
  if (!checkInstallIdentifier(id).ok) {
    return invalidArgument("id", "Invalid skill id");
  }

  try {
    return wantDocs ? await remoteDocs(id, request.signal) : await localDetail(id, fromInstalled);
  } catch (err) {
    // runHermesCli's message is sanitised of the binary path but it is still
    // ENGLISH, and the detail panel painted it verbatim under a localised
    // header (HERMES-04). The code is the part the panel can say in the
    // owner's language; the message goes to the log.
    const code = cliFailureCode(err);
    console.error("[hermes skills inspect] CLI failed", code, err instanceof Error ? err.message : err);
    return NextResponse.json({ error: CLI_FAILURE_SENTENCES[code], code }, { status: 502 });
  }
}

/** Phase 1 — everything we can prove from disk + the catalog, no CLI. */
async function localDetail(id: string, fromInstalled: boolean): Promise<NextResponse> {
  const installed = await findInstalledSkill(id, { allowNameFallback: fromInstalled });

  if (installed) {
    // The catalog is a 41 MB parse: consult it only when it can actually add
    // something. A bundled or agent-written skill has no registry entry, so its
    // detail is complete from disk alone.
    const record = installed.origin === "hub" ? await getCatalogRecord(id) : undefined;
    const fm = parseSkillFrontmatter(installed.markdown);
    const lock = installed.lock;
    const scan = scanReportFromLock(lock) || (await readScanReport(lock?.content_hash));
    const dirStats = await statSkillDir(installed.dir);
    const body = clampBody(fm.body);

    const sourceUrl =
      lockMetaUrl(lock, "source_url") ||
      lockMetaUrl(lock, "url") ||
      record?.sourceUrl ||
      record?.repoUrl;
    const derived = sourceUrl ? undefined : deriveSourceUrl(lock?.source || record?.source, id);

    const provenance: SkillProvenance = {
      sourceUrl: sourceUrl || derived,
      sourceUrlVerified: !!sourceUrl,
      repoUrl: record?.repoUrl,
      detailUrl: record?.detailUrl,
      homepage: fm.homepage,
      installCount: record?.installCount,
      hostname: record?.hostname,
    };

    const detail: HermesSkillDetail = {
      id,
      name: fm.name || installed.name,
      description: fm.description || record?.description,
      provenanceNote: record?.provenanceNote,
      source: lock?.source || record?.source || (installed.origin === "builtin" ? "builtin" : "local"),
      trust: lock?.trust_level || record?.trust || (installed.origin === "builtin" ? "builtin" : undefined),
      provider: record?.provider,
      category: installed.category || fm.category,
      tags: fm.tags.length ? fm.tags : record?.tags,
      version: fm.version,
      author: fm.author,
      license: fm.license,
      platforms: fm.platforms.length ? fm.platforms : undefined,
      relatedSkills: fm.relatedSkills.length ? fm.relatedSkills : undefined,
      incompatible: fm.platforms.length > 0 && !fm.platforms.includes("linux"),
      requirements: await requirementsFrom(fm, true),
      provenance,
      security: scan
        ? {
            verdict: scan.verdict || lock?.scan_verdict,
            scannerVersion: scan.scannerVersion,
            scannedAt: scan.scannedAt,
            summary: scan.summary,
            contentHashShort: lock?.content_hash,
            findings: scan.findings,
          }
        : lock?.scan_verdict
          ? { verdict: lock.scan_verdict, contentHashShort: lock.content_hash, findings: [] }
          : undefined,
      install: {
        origin: installed.origin,
        installedAt: lock?.installed_at,
        updatedAt: lock?.updated_at,
        fileCount: dirStats.files,
        bytes: dirStats.bytes,
        supportDirs: dirStats.supportDirs,
        // Shown so the user knows what "Remove" deletes. Always relative to the
        // skills dir — an absolute filesystem path is never sent to the client.
        installPath: lock?.install_path || `${installed.category}/${installed.name}`,
      },
      body: body || undefined,
      bodySource: "disk",
      bodyTruncated: false,
      needsRemoteDocs: false,
      headings: body ? extractHeadings(body) : undefined,
    };
    return NextResponse.json({ skill: detail });
  }

  // Not installed — now the catalog IS the source of the metadata.
  const record = await getCatalogRecord(id);

  // An `official` skill still has its real file on this device.
  if (record?.source === "official" && record.localPath) {
    const markdown = await readOfficialSkillMarkdown(record.localPath);
    if (markdown) {
      const fm = parseSkillFrontmatter(markdown);
      const body = clampBody(fm.body);
      const detail: HermesSkillDetail = {
        id,
        name: fm.name || record.name,
        description: fm.description || record.description,
        source: record.source,
        trust: record.trust,
        category: fm.category || record.category,
        tags: fm.tags.length ? fm.tags : record.tags,
        version: fm.version,
        author: fm.author,
        license: fm.license,
        platforms: fm.platforms.length ? fm.platforms : undefined,
        relatedSkills: fm.relatedSkills.length ? fm.relatedSkills : undefined,
        incompatible: fm.platforms.length > 0 && !fm.platforms.includes("linux"),
        requirements: await requirementsFrom(fm, true),
        provenance: {
          sourceUrl: record.sourceUrl,
          sourceUrlVerified: !!record.sourceUrl,
          repoUrl: record.repoUrl,
          detailUrl: record.detailUrl,
          homepage: fm.homepage,
        },
        body: body || undefined,
        bodySource: "official-disk",
        bodyTruncated: false,
        needsRemoteDocs: false,
        headings: body ? extractHeadings(body) : undefined,
      };
      return NextResponse.json({ skill: detail });
    }
  }

  // Catalog metadata only — the body needs the CLI (phase 2).
  const sourceUrl = record?.sourceUrl;
  const detail: HermesSkillDetail = {
    id,
    name: record?.name || id.split("/").pop() || id,
    description: record?.description,
    provenanceNote: record?.provenanceNote,
    source: record?.source,
    trust: record?.trust,
    provider: record?.provider,
    category: record?.category,
    tags: record?.tags,
    provenance: {
      sourceUrl: sourceUrl || deriveSourceUrl(record?.source, id),
      sourceUrlVerified: !!sourceUrl,
      repoUrl: record?.repoUrl,
      detailUrl: record?.detailUrl,
      installCount: record?.installCount,
      hostname: record?.hostname,
    },
    bodySource: "none",
    bodyTruncated: false,
    needsRemoteDocs: true,
  };
  return NextResponse.json({ skill: detail });
}

/** Phase 2 — the CLI preview, fetched only while the detail view is open. */
async function remoteDocs(id: string, signal: AbortSignal): Promise<NextResponse> {
  // A bare ClawHub slug has to be spelled `clawhub/<slug>` for the CLI, for the
  // same reason the install route does it — `hermes skills inspect <bare name>`
  // resolves on the catalog NAME and a ClawHub row's name is its display name,
  // so every clawhub card dead-ended on "Skill not found" here.
  const record = await getCatalogRecord(id).catch(() => undefined);
  const cliId = cliInstallIdentifier(id, record?.source);
  // Queued (max 2 children) and cancelled with the request: clicking through a
  // dozen cards must not leave a dozen Python processes resident on a Jetson.
  //
  // `hermes skills inspect` on a browse.sh/github row goes over the
  // unauthenticated GitHub API, which is why this has a cap at all; the cap
  // itself is SKILL_DOCS_CLI_TIMEOUT_MS, which carries the measurements. Below
  // it, runHermesCli SIGKILLs a fetch that was about to land and throws
  // "hermes timed out". That is the same jargon Report B
  // flagged on the install surface; here it is only the docs BODY that failed
  // (the metadata is already painted from the catalog), so a timeout is not an
  // error page, it is the identical non-alarming note a non-zero exit already
  // yields. A real cancellation (SkillsCliAborted, the client navigated away)
  // still propagates untouched.
  let r: Awaited<ReturnType<typeof runSkillsCli>>;
  try {
    r = await runSkillsCli(["skills", "inspect", cliId], {
      timeoutMs: SKILL_DOCS_CLI_TIMEOUT_MS,
      signal,
    });
  } catch (err) {
    if (err instanceof Error && /timed out/i.test(err.message)) {
      return NextResponse.json(
        { error: "Could not load the full documentation", code: "cli_timeout" },
        { status: 504 },
      );
    }
    throw err;
  }
  if (r.code !== 0) {
    // Never surface raw stderr (it can carry the binary path).
    return NextResponse.json({ error: "Could not load skill details", code: "cli_failed" }, { status: 502 });
  }

  const { fields, preview, hasSkillPanel } = parseInspect(r.stdout);
  if (!hasSkillPanel) {
    const candidates = parseAmbiguity(r.stdout);
    if (candidates.length) {
      return NextResponse.json({ ambiguous: true, query: id, candidates });
    }
    return NextResponse.json({ error: "Skill not found", code: REQUEST_REFUSAL.notFound }, { status: 404 });
  }

  // ONLY prose survives the Rich panel — list fields (platforms/tags) are
  // deleted by the renderer, so we never parse them out of the preview.
  const fm = preview ? parseSkillFrontmatter(preview) : null;
  const body = fm ? clampBody(fm.body) : "";

  const repo = httpsOnly(fields.Repo);
  const detailUrl = httpsOnly(fields["Detail Page"]);
  const installsRaw = fields["Weekly Installs"] || fields.Installs;
  const installs = installsRaw ? Number(installsRaw.replace(/[^0-9]/g, "")) : NaN;

  return NextResponse.json({
    delta: {
      description: fields.Description || undefined,
      version: fm?.version,
      author: fm?.author,
      license: fm?.license,
      body: body || undefined,
      bodySource: "cli-preview",
      bodyTruncated: true,
      needsRemoteDocs: false,
      headings: body ? extractHeadings(body) : undefined,
      provenance: {
        sourceUrl: repo,
        sourceUrlVerified: !!repo,
        repoUrl: repo,
        detailUrl,
        installCommand: fields["Install Command"]?.slice(0, 200),
        installCount: Number.isFinite(installs) && installs > 0 ? installs : undefined,
        revision: fields.Revision?.slice(0, 60),
      },
    },
  });
}
