export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { runHermesCli } from "@/lib/hermes-cli";
import { type HermesSkillDetail, checkInstallIdentifier } from "@/lib/hermes-skills";
import { hermesSkillsGuard, readInstalledSkillMarkdown } from "@/lib/hermes-skills-server";

// Deep detail for a single skill, backing the store's detail view.
//
// `hermes skills inspect <id>` has NO --json — it prints Rich TUI panels
// (box-drawing). We run it with COLUMNS=200 for stable wrapping and parse the
// panels. For skills the user already installed we skip the CLI entirely and
// read the full SKILL.md off disk (the inspect preview is truncated).
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
const FIELD_KEYS = ["Name", "Description", "Source", "Trust", "Identifier", "Tags", "Repo", "Detail Page"];

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
    preview = previewBucket.lines
      .join("\n")
      .replace(/\n?\.\.\.\s*\(\d+ more lines\)\s*$/, "");
  }

  return {
    fields: skillBucket ? parseFields(skillBucket.lines) : {},
    preview,
    hasSkillPanel: !!skillBucket,
  };
}

// ── Frontmatter parsing (no YAML dependency) ────────────────────────────────
interface Frontmatter {
  body: string;
  version?: string;
  author?: string;
  license?: string;
  category?: string;
  tags?: string[];
  setupHelpUrl?: string;
  secrets?: { provider?: string; providerUrl?: string }[];
}

function firstUrl(s: string): string | undefined {
  const m = s.match(/https?:\/\/[^\s"'<>)]+/);
  return m ? m[0] : undefined;
}

function httpOrUndefined(s?: string): string | undefined {
  if (!s) return undefined;
  const v = s.trim();
  return /^https?:\/\//i.test(v) ? v : undefined;
}

// Best-effort source URL from source + identifier (§6). Only emits when
// confident; never fabricates for official/skills-sh/clawhub/bare ids.
function deriveSourceUrl(source: string | undefined, identifier: string): string | undefined {
  const seg = identifier.split("/").filter(Boolean);
  // Identifiers carry the source as the first segment: github/<owner>/<repo>.
  if (source === "github" && seg.length >= 3 && seg[0] === "github") {
    return `https://github.com/${seg[1]}/${seg[2]}`;
  }
  if (source === "browse-sh" && seg.length >= 2 && seg[0] === "browse-sh") {
    const host = seg[1];
    if (host === "github.com" && seg.length >= 4) {
      return `https://github.com/${seg[2]}/${seg[3]}`;
    }
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(host)) {
      return `https://${host}`;
    }
  }
  return undefined;
}

function flatScalar(block: string, key: string): string | undefined {
  // Top-level only (no leading indent) — avoids matching nested keys.
  const mm = block.match(new RegExp(`^${key}[ \\t]*:[ \\t]*["']?(.+?)["']?[ \\t]*$`, "m"));
  return mm ? mm[1].trim() : undefined;
}

function parseTags(lines: string[]): string[] {
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^[ \t]*tags[ \t]*:[ \t]*\[(.*)\][ \t]*$/);
    if (inline) {
      return inline[1]
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    }
    const blockStart = lines[i].match(/^([ \t]*)tags[ \t]*:[ \t]*$/);
    if (blockStart) {
      const baseIndent = blockStart[1].length;
      const out: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") continue;
        const item = lines[j].match(/^([ \t]*)-[ \t]*(.+?)[ \t]*$/);
        if (item && item[1].length > baseIndent) {
          out.push(item[2].replace(/^["']|["']$/g, "").trim());
        } else {
          break;
        }
      }
      if (out.length) return out;
    }
  }
  return [];
}

// Apply one `key: value` line onto a secret entry. `provider:` wins as the
// label; `env_var:` is the fallback label; `provider_url:` is the docs link.
function applySecretField(cur: { provider?: string; providerUrl?: string }, text: string): void {
  const provider = text.match(/^provider[ \t]*:[ \t]*["']?(.+?)["']?[ \t]*$/);
  if (provider) {
    cur.provider = provider[1].trim();
    return;
  }
  const envVar = text.match(/^env_var[ \t]*:[ \t]*["']?(.+?)["']?[ \t]*$/);
  if (envVar && !cur.provider) {
    cur.provider = envVar[1].trim();
    return;
  }
  const url = text.match(/^provider_url[ \t]*:[ \t]*(.+)$/);
  if (url) cur.providerUrl = httpOrUndefined(url[1]);
}

function parseSetup(lines: string[]): {
  setupHelpUrl?: string;
  secrets: { provider?: string; providerUrl?: string }[];
} {
  const secrets: { provider?: string; providerUrl?: string }[] = [];
  let setupHelpUrl: string | undefined;

  let i = 0;
  let setupIndent = -1;
  for (; i < lines.length; i++) {
    const m = lines[i].match(/^([ \t]*)setup[ \t]*:[ \t]*$/);
    if (m) {
      setupIndent = m[1].length;
      i++;
      break;
    }
  }
  if (setupIndent < 0) return { secrets };

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = (line.match(/^[ \t]*/) || [""])[0].length;
    if (indent <= setupIndent) break; // left the setup subtree

    const help = line.match(/^[ \t]*help[ \t]*:[ \t]*(.+)$/);
    if (help) {
      setupHelpUrl = firstUrl(help[1]);
      continue;
    }

    const cs = line.match(/^([ \t]*)collect_secrets[ \t]*:[ \t]*$/);
    if (cs) {
      const csIndent = cs[1].length;
      let cur: { provider?: string; providerUrl?: string } | null = null;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === "") continue;
        const ind = (l.match(/^[ \t]*/) || [""])[0].length;
        if (ind <= csIndent) break;

        const itemStart = l.match(/^[ \t]*-[ \t]*(.*)$/);
        // A leading `- <key>: <val>` starts a new secret. Each secret carries a
        // human label (`provider:`, else the `env_var:` name) and a docs link
        // (`provider_url:`).
        if (itemStart) {
          cur = {};
          secrets.push(cur);
          applySecretField(cur, itemStart[1]);
          continue;
        }
        if (cur) applySecretField(cur, l.trim());
      }
      i = j - 1;
      continue;
    }
  }

  return {
    setupHelpUrl,
    secrets: secrets.filter((s) => s.provider || s.providerUrl),
  };
}

function parseFrontmatter(md: string): Frontmatter {
  const m = md.match(/^\s*---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!m) return { body: md.trim() };
  const block = m[1];
  const body = m[2].trim();
  const blockLines = block.split(/\r?\n/);
  const catMatch = block.match(/^[ \t]+category[ \t]*:[ \t]*["']?([^"'\r\n]+?)["']?[ \t]*$/m);
  const { setupHelpUrl, secrets } = parseSetup(blockLines);
  const tags = parseTags(blockLines);
  return {
    body,
    version: flatScalar(block, "version"),
    author: flatScalar(block, "author"),
    license: flatScalar(block, "license"),
    category: catMatch ? catMatch[1].trim() : undefined,
    tags: tags.length ? tags : undefined,
    setupHelpUrl,
    secrets: secrets.length ? secrets : undefined,
  };
}

// ── Route ───────────────────────────────────────────────────────────────────
export async function GET(request: Request) {
  const blocked = await hermesSkillsGuard();
  if (blocked) return blocked;

  const id = (new URL(request.url).searchParams.get("id") || "").trim();
  if (!checkInstallIdentifier(id).ok) {
    return NextResponse.json({ error: "Invalid skill id" }, { status: 400 });
  }

  try {
    // Prefer the full on-disk SKILL.md for installed skills.
    const disk = await readInstalledSkillMarkdown(id);
    if (disk) {
      const fm = parseFrontmatter(disk.markdown);
      const skill: HermesSkillDetail = {
        id,
        name: flatScalar(disk.markdown, "name") || id.split("/").pop() || id,
        description: flatScalar(disk.markdown, "description"),
        source: disk.source,
        trust: disk.trust,
        category: fm.category || disk.category,
        tags: fm.tags,
        version: fm.version,
        author: fm.author,
        license: fm.license,
        body: fm.body,
        sourceUrl: deriveSourceUrl(disk.source, id),
        setupHelpUrl: fm.setupHelpUrl,
        secrets: fm.secrets,
        markdownTruncated: false,
      };
      return NextResponse.json({ skill });
    }

    // Remote / not-installed → inspect CLI (only source of truth).
    const r = await runHermesCli(["skills", "inspect", id], {
      env: { COLUMNS: "200" },
      timeoutMs: 45_000,
    });
    if (r.code !== 0) {
      // Never surface raw stderr (could carry the binary path).
      return NextResponse.json({ error: "Could not load skill details" }, { status: 502 });
    }

    const { fields, preview, hasSkillPanel } = parseInspect(r.stdout);
    // No Skill panel → unknown or ambiguous (disambiguation table) → 404.
    if (!hasSkillPanel) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    const fm: Frontmatter = preview ? parseFrontmatter(preview) : { body: "" };
    const cliTags = fields.Tags
      ? fields.Tags.split(",").map((t) => t.trim()).filter(Boolean)
      : undefined;

    const skill: HermesSkillDetail = {
      id: fields.Identifier || id,
      name: fields.Name || id,
      description: fields.Description || undefined,
      source: fields.Source || undefined,
      trust: fields.Trust || undefined,
      category: fm.category,
      tags: cliTags && cliTags.length ? cliTags : fm.tags,
      version: fm.version,
      author: fm.author,
      license: fm.license,
      body: fm.body || undefined,
      sourceUrl:
        httpOrUndefined(fields.Repo) ||
        deriveSourceUrl(fields.Source, fields.Identifier || id),
      detailUrl: httpOrUndefined(fields["Detail Page"]),
      setupHelpUrl: fm.setupHelpUrl,
      secrets: fm.secrets,
      markdownTruncated: true,
    };
    return NextResponse.json({ skill });
  } catch (err) {
    // runHermesCli rejects with a sanitized message (e.g. "Hermes is not
    // installed on this device") — surface that, never the binary path.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not inspect skill" },
      { status: 502 },
    );
  }
}
