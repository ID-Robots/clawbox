// SKILL.md frontmatter parsing for the Hermes Skills store.
//
// WHY a hand-rolled YAML subset instead of a dependency: ClawBox ships offline
// onto a Jetson and we refuse to add a parser (and its transitive tree) for one
// screen. The shapes that actually occur in Hermes skills were surveyed on a
// real device (77 bundled + hub skills) and are all covered here:
//
//   name/description/version/author/license   top-level scalars
//   platforms: [linux, macos]                 flow sequence
//   tags: [a, b]  |  tags:\n  - a             flow OR block sequence
//   metadata:\n  hermes:\n    tags/category/related_skills/homepage
//   metadata:\n  author: x                    scalars nested under `metadata`
//   prerequisites:\n  commands: [memo]\n  env_vars: [...]
//   dependencies: [vllm, torch]
//   required_credential_files:\n  - path: x\n    description: y
//   compatibility: "…"
//   setup:\n  help: "…"\n  collect_secrets:\n    - env_var/prompt/provider_url/secret
//
// This module is PURE (no fs, no node builtins) so it can be unit-tested and
// imported from a route handler without pulling anything into the client bundle.

// ── Minimal YAML-subset parser ──────────────────────────────────────────────

export type YamlNode = string | YamlNode[] | { [key: string]: YamlNode };

interface Line {
  /** Column of the first non-space char; -1 marks a blank line. */
  indent: number;
  text: string;
}

// Hard caps so a hostile frontmatter can't make us allocate unbounded work.
const MAX_LINES = 800;
const MAX_SCALAR = 2000;
const MAX_LIST_ITEMS = 64;

function toLines(block: string): Line[] {
  const out: Line[] = [];
  const raw = block.split(/\r?\n/).slice(0, MAX_LINES);
  for (const original of raw) {
    // Tabs are invalid YAML indentation but appear in hand-written skills;
    // normalise so indent comparisons stay meaningful.
    const expanded = original.replace(/\t/g, '  ');
    const trimmed = expanded.trimStart();
    if (!trimmed) {
      out.push({ indent: -1, text: '' });
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    out.push({ indent: expanded.length - trimmed.length, text: trimmed.replace(/\s+$/, '') });
  }
  return out;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'");
    }
  }
  return v;
}

// Split a flow sequence body on top-level commas (quoted items may contain one).
function splitFlow(body: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of body) {
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => unquote(s)).filter((s) => s.length > 0);
}

function parseScalar(raw: string): YamlNode {
  const v = raw.trim();
  if (v.startsWith('[') && v.endsWith(']')) return splitFlow(v.slice(1, -1)).slice(0, MAX_LIST_ITEMS);
  return unquote(v).slice(0, MAX_SCALAR);
}

function nextContent(lines: Line[], from: number): number {
  let i = from;
  while (i < lines.length && lines[i].indent === -1) i++;
  return i;
}

interface ParseResult {
  value: YamlNode;
  next: number;
}

function parseValue(lines: Line[], start: number, indent: number): ParseResult {
  const i = nextContent(lines, start);
  if (i >= lines.length) return { value: '', next: i };
  return lines[i].text.startsWith('-')
    ? parseSequence(lines, i, indent)
    : parseMapping(lines, i, indent);
}

function parseMapping(lines: Line[], start: number, indent: number): ParseResult {
  const map: Record<string, YamlNode> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent === -1) {
      i++;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent > indent) {
      i++; // stray deeper line with no owning key — skip
      continue;
    }
    const m = line.text.match(/^([^:]+):[ \t]*(.*)$/);
    if (!m) {
      i++;
      continue;
    }
    const key = unquote(m[1]).trim();
    const rest = m[2];
    if (rest === '') {
      const j = nextContent(lines, i + 1);
      if (j < lines.length && lines[j].indent > line.indent) {
        const child = parseValue(lines, j, lines[j].indent);
        map[key] = child.value;
        i = child.next;
        continue;
      }
      map[key] = '';
      i++;
      continue;
    }
    if (rest === '|' || rest === '>' || /^[|>][-+]?$/.test(rest)) {
      // Block scalar: everything indented deeper belongs to the value.
      const folded = rest.startsWith('>');
      const parts: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j].indent === -1 || lines[j].indent > line.indent)) {
        parts.push(lines[j].indent === -1 ? '' : lines[j].text);
        j++;
      }
      const joined = folded ? parts.join(' ').replace(/\s+/g, ' ') : parts.join('\n');
      map[key] = joined.trim().slice(0, MAX_SCALAR);
      i = j;
      continue;
    }
    map[key] = parseScalar(rest);
    i++;
  }
  return { value: map, next: i };
}

function parseSequence(lines: Line[], start: number, indent: number): ParseResult {
  const items: YamlNode[] = [];
  let i = start;
  while (i < lines.length && items.length < MAX_LIST_ITEMS) {
    const line = lines[i];
    if (line.indent === -1) {
      i++;
      continue;
    }
    if (line.indent < indent) break;
    if (line.indent > indent || !line.text.startsWith('-')) {
      i++;
      continue;
    }
    const afterDash = line.text.slice(1);
    const rest = afterDash.trimStart();
    const restCol = line.indent + 1 + (afterDash.length - rest.length);
    if (rest === '') {
      const j = nextContent(lines, i + 1);
      if (j < lines.length && lines[j].indent > line.indent) {
        const child = parseValue(lines, j, lines[j].indent);
        items.push(child.value);
        i = child.next;
        continue;
      }
      i++;
      continue;
    }
    if (/^[^:]+:([ \t]|$)/.test(rest)) {
      // `- key: value` starts an inline mapping; sibling keys are indented to
      // the same column as `key`. Re-parse them as one virtual block.
      const virtual: Line[] = [{ indent: restCol, text: rest }];
      let j = i + 1;
      while (j < lines.length && (lines[j].indent === -1 || lines[j].indent > line.indent)) {
        virtual.push(lines[j]);
        j++;
      }
      items.push(parseMapping(virtual, 0, restCol).value);
      i = j;
      continue;
    }
    items.push(parseScalar(rest));
    i++;
  }
  return { value: items, next: i };
}

/** Parse a YAML frontmatter block into a plain object (subset — see header). */
export function parseYamlSubset(block: string): Record<string, YamlNode> {
  const lines = toLines(block);
  const i = nextContent(lines, 0);
  if (i >= lines.length) return {};
  const parsed = parseMapping(lines, i, lines[i].indent).value;
  return typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

// ── Typed accessors ─────────────────────────────────────────────────────────

function asMap(node: YamlNode | undefined): Record<string, YamlNode> | undefined {
  return node && typeof node === 'object' && !Array.isArray(node) ? node : undefined;
}

function asString(node: YamlNode | undefined): string | undefined {
  if (typeof node !== 'string') return undefined;
  const v = node.trim();
  return v ? v : undefined;
}

function asList(node: YamlNode | undefined): string[] {
  if (Array.isArray(node)) {
    return node
      .map((n) => (typeof n === 'string' ? n.trim() : ''))
      .filter((s) => s.length > 0 && s.length <= 120)
      .slice(0, MAX_LIST_ITEMS);
  }
  const s = asString(node);
  if (!s) return [];
  // A single scalar that reads as a list (`tags: a, b`) still yields items.
  return s
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.length <= 120)
    .slice(0, MAX_LIST_ITEMS);
}

function asBool(node: YamlNode | undefined): boolean {
  return typeof node === 'string' && /^(true|yes|on)$/i.test(node.trim());
}

function httpsOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const v = value.trim();
  return /^https:\/\/[^\s<>"']+$/i.test(v) ? v : undefined;
}

function firstHttpsUrl(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const m = text.match(/https:\/\/[^\s"'<>)]+/);
  return m ? m[0].replace(/[.,;:]+$/, '') : undefined;
}

export interface SkillSecret {
  /** Human label — the prompt, else the provider, else the env var name. */
  label: string;
  envVar?: string;
  providerUrl?: string;
  secret: boolean;
}

export interface SkillSetup {
  help?: string;
  helpUrl?: string;
  secrets: SkillSecret[];
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  license?: string;
  platforms: string[];
  tags: string[];
  relatedSkills: string[];
  homepage?: string;
  /** metadata.hermes.category — a FALLBACK only; the install dir is truth. */
  category?: string;
  prerequisiteCommands: string[];
  prerequisiteEnvVars: string[];
  dependencies: string[];
  credentialFiles: { path: string; description?: string }[];
  compatibility?: string;
  setup?: SkillSetup;
  /** Everything below the closing `---`. */
  body: string;
  /** True when a frontmatter block was actually present. */
  hasFrontmatter: boolean;
}

const EMPTY: SkillFrontmatter = {
  platforms: [],
  tags: [],
  relatedSkills: [],
  prerequisiteCommands: [],
  prerequisiteEnvVars: [],
  dependencies: [],
  credentialFiles: [],
  body: '',
  hasFrontmatter: false,
};

function parseSecrets(node: YamlNode | undefined): SkillSecret[] {
  if (!Array.isArray(node)) return [];
  const out: SkillSecret[] = [];
  for (const raw of node.slice(0, 12)) {
    const m = asMap(raw);
    if (!m) continue;
    const envVar = asString(m.env_var);
    const label = asString(m.prompt) || asString(m.provider) || envVar;
    if (!label) continue;
    out.push({
      label: label.slice(0, 120),
      envVar,
      providerUrl: httpsOnly(asString(m.provider_url)),
      secret: asBool(m.secret),
    });
  }
  return out;
}

function parseCredentialFiles(node: YamlNode | undefined): { path: string; description?: string }[] {
  if (!Array.isArray(node)) return [];
  const out: { path: string; description?: string }[] = [];
  for (const raw of node.slice(0, 12)) {
    const m = asMap(raw);
    const p = m ? asString(m.path) : asString(raw);
    if (!p) continue;
    out.push({ path: p.slice(0, 200), description: m ? asString(m.description)?.slice(0, 300) : undefined });
  }
  return out;
}

/**
 * Parse a SKILL.md into frontmatter fields + body. Never throws: a malformed
 * document degrades to `{ ...EMPTY, body: <whole doc> }`.
 */
export function parseSkillFrontmatter(md: string): SkillFrontmatter {
  const text = typeof md === 'string' ? md : '';
  const m = text.match(/^﻿?\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!m) return { ...EMPTY, body: text.trim() };

  const doc = parseYamlSubset(m[1]);
  const body = (m[2] || '').trim();
  const metadata = asMap(doc.metadata);
  const hermes = metadata ? asMap(metadata.hermes) : undefined;
  const prerequisites = asMap(doc.prerequisites);
  const setupMap = asMap(doc.setup);

  // Scalars may sit at the top level OR under `metadata:` (skills.sh nests
  // author/version there) — check both before giving up.
  //
  // A flow sequence is a legitimate value for these keys
  // (`author: [kshitijk4poor, alt-glitch, purzbeats]` ships on this device);
  // asString drops arrays, which showed the skill as having no author at all.
  const scalar = (key: string): string | undefined => {
    const direct = asString(doc[key]) || (metadata ? asString(metadata[key]) : undefined);
    if (direct) return direct;
    const list = Array.isArray(doc[key])
      ? asList(doc[key])
      : metadata && Array.isArray(metadata[key])
        ? asList(metadata[key])
        : [];
    return list.length ? list.join(', ').slice(0, 200) : undefined;
  };

  let setup: SkillSetup | undefined;
  if (setupMap) {
    const help = asString(setupMap.help);
    const secrets = parseSecrets(setupMap.collect_secrets);
    if (help || secrets.length) {
      setup = { help: help?.slice(0, 600), helpUrl: firstHttpsUrl(help), secrets };
    }
  }

  return {
    name: scalar('name'),
    description: scalar('description'),
    version: scalar('version'),
    author: scalar('author'),
    license: scalar('license'),
    platforms: asList(doc.platforms).map((p) => p.toLowerCase()),
    tags: (hermes ? asList(hermes.tags) : []).concat(asList(doc.tags)).slice(0, 24),
    relatedSkills: hermes ? asList(hermes.related_skills) : [],
    homepage: httpsOnly(hermes ? asString(hermes.homepage) : undefined),
    category: hermes ? asString(hermes.category) : undefined,
    prerequisiteCommands: prerequisites ? asList(prerequisites.commands) : [],
    prerequisiteEnvVars: prerequisites ? asList(prerequisites.env_vars) : [],
    dependencies: asList(doc.dependencies),
    credentialFiles: parseCredentialFiles(doc.required_credential_files),
    compatibility: asString(doc.compatibility)?.slice(0, 600),
    setup,
    body,
    hasFrontmatter: true,
  };
}

export interface SkillHeading {
  level: 2 | 3;
  text: string;
  slug: string;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Collect `##` / `###` headings from a markdown body for the jump chips.
 * Fenced code blocks are skipped so a `# comment` inside bash isn't a heading.
 */
export function extractHeadings(body: string): SkillHeading[] {
  const out: SkillHeading[] = [];
  let inFence = false;
  const seen = new Set<string>();
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)\s*#*$/);
    if (!m) continue;
    const text = m[2].replace(/[*_`]/g, '').trim();
    if (!text) continue;
    const slug = slugify(text);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({ level: m[1].length === 2 ? 2 : 3, text: text.slice(0, 80), slug });
    if (out.length >= 24) break;
  }
  return out;
}
