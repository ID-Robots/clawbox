'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  type HermesSkill,
  type HermesSkillDetail,
  type InstalledHermesSkill,
  type ScanFinding,
  formatBytes,
  trustMeta,
} from '@/lib/hermes-skills';
import { renderText } from '@/lib/chat-markdown';
import { platformName, useCopy } from './copy';
import {
  Alert,
  EmptyState,
  ExternalLink,
  ExternalUrl,
  FOCUS_RING,
  GhostButton,
  Section,
  SkillTile,
  SourceChip,
  TagPill,
  TrustChip,
} from './primitives';

type AnySkill = HermesSkill | InstalledHermesSkill;

// ── Documentation body ──────────────────────────────────────────────────────

const COLLAPSE_ABOVE = 1500;

/**
 * Neutralise every link a SKILL.md could carry that isn't a plain https URL.
 *
 * chat-markdown's own href check accepts http/https/mailto AND resolves
 * RELATIVE hrefs against the current origin — so `[refs](references/x.md)` in a
 * skill would render as a link into the ClawBox UI itself. Skill text is
 * third-party content, so anything that isn't https becomes plain text plus the
 * literal target. Done here rather than in chat-markdown because the chat
 * renderer legitimately needs mailto:.
 */
function hardenMarkdownLinks(markdown: string): string {
  return markdown.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (match, text: string, href: string) => {
    const target = href.trim();
    if (/^https:\/\//i.test(target)) return match;
    return `${text} (\`${target.replace(/`/g, '')}\`)`;
  });
}

/** Collapsed by default only for long documents — derived, never synced. */
function docsCollapsible(body: string): boolean {
  return body.length > COLLAPSE_ABOVE;
}

function DocumentBody({
  detail,
  expanded,
  onToggle,
}: {
  detail: HermesSkillDetail;
  expanded: boolean;
  onToggle: () => void;
}) {
  const COPY = useCopy();
  const body = detail.body || '';
  const rendered = useMemo(() => renderText(hardenMarkdownLinks(body)), [body]);
  if (!body) return null;

  return (
    <>
      <div
        className={`text-sm leading-relaxed text-[var(--text-primary)]/85 [&_a]:text-[var(--coral-bright)] [&_a]:underline ${
          expanded ? '' : 'max-h-64 overflow-hidden relative'
        }`}
      >
        {rendered}
        {!expanded && (
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--bg-deep)] to-transparent" />
        )}
      </div>
      <div className="mt-2 flex items-center gap-3 flex-wrap">
        {docsCollapsible(body) && (
          <GhostButton onClick={onToggle}>{expanded ? COPY.showLess : COPY.readMore}</GhostButton>
        )}
        <p className="text-[11px] text-[var(--text-secondary)] italic">
          {detail.bodyTruncated ? COPY.docsPreview : COPY.docsFull}
        </p>
      </div>
    </>
  );
}

// ── Cards ───────────────────────────────────────────────────────────────────

function Field({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">{label}</dt>
      {/* Clamped to two lines, so anything longer (a license expression, a
          multi-author list) is only readable via the tooltip. */}
      <dd className="text-sm break-words line-clamp-2" title={title}>
        {children}
      </dd>
    </div>
  );
}

function RequirementsCard({ detail }: { detail: HermesSkillDetail }) {
  const COPY = useCopy();
  const req = detail.requirements;
  if (!req) return null;
  const anything =
    req.commands.length ||
    req.envVars.length ||
    req.dependencies.length ||
    req.credentialFiles.length ||
    req.compatibility ||
    req.setupHelp ||
    req.secrets.length;
  if (!anything) return null;

  return (
    <Section title={COPY.sectionRequirements}>
      <div className="card-surface rounded-xl border border-[var(--border-subtle)] p-4 space-y-3 text-sm">
        {req.commands.length > 0 && (
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">{COPY.reqCommands}</p>
            <ul className="flex flex-wrap gap-2 list-none p-0 m-0">
              {req.commands.map((c) => (
                <li
                  key={c.name}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono ${
                    c.present === true
                      ? 'bg-emerald-400/10 text-emerald-400'
                      : c.present === false
                        ? 'bg-amber-400/10 text-amber-300'
                        : 'bg-[var(--surface-card)] text-[var(--text-secondary)]'
                  }`}
                  title={
                    c.present === true
                      ? `${c.name} — ${COPY.reqCommandPresent}`
                      : c.present === false
                        ? `${c.name} — ${COPY.reqCommandMissing}`
                        : undefined
                  }
                >
                  {c.present !== null && (
                    <span className="material-symbols-rounded" style={{ fontSize: 13 }} aria-hidden="true">
                      {c.present ? 'check' : 'close'}
                    </span>
                  )}
                  {c.name}
                  <span className="sr-only">
                    {c.present === true ? COPY.reqCommandPresent : c.present === false ? COPY.reqCommandMissing : ''}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {req.dependencies.length > 0 && (
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">{COPY.reqDependencies}</p>
            <p className="font-mono text-xs break-words">{req.dependencies.join(', ')}</p>
          </div>
        )}

        {req.envVars.length > 0 && (
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">{COPY.reqEnvVars}</p>
            <p className="font-mono text-xs break-words">{req.envVars.join(', ')}</p>
          </div>
        )}

        {req.credentialFiles.length > 0 && (
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">{COPY.reqCredentials}</p>
            <ul className="space-y-1 list-none p-0 m-0">
              {req.credentialFiles.map((f) => (
                <li key={f.path} className="text-xs">
                  <span className="font-mono">{f.path}</span>
                  {f.description && <span className="text-[var(--text-secondary)]"> — {f.description}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {req.compatibility && (
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">{COPY.reqCompatibility}</p>
            <p className="text-xs">{req.compatibility}</p>
          </div>
        )}

        {(req.setupHelp || req.secrets.length > 0) && (
          <div>
            <p className="text-xs text-[var(--text-secondary)] mb-1">{COPY.reqSetup}</p>
            {req.setupHelp && <p className="text-xs mb-2">{req.setupHelp}</p>}
            {req.setupHelpUrl && <ExternalLink href={req.setupHelpUrl}>{COPY.reqSetupGuide}</ExternalLink>}
            {req.secrets.length > 0 && (
              <ul className="mt-2 space-y-2 list-none p-0 m-0">
                {req.secrets.map((s) => (
                  <li key={s.label} className="text-xs">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="material-symbols-rounded shrink-0" style={{ fontSize: 15 }} aria-hidden="true">
                        key
                      </span>
                      <span>{s.label}</span>
                      {s.envVar && <span className="font-mono text-[var(--text-secondary)]">{s.envVar}</span>}
                      {s.providerUrl && <ExternalLink href={s.providerUrl}>{COPY.reqGetKey}</ExternalLink>}
                    </div>
                    {/* TASK-452: the store named the key and linked to where to
                        buy it, then offered nowhere to type it. */}
                    {s.envVar && <SecretInput label={s.label} envVar={s.envVar} />}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

/**
 * Write-only input for one API key a skill declares.
 *
 * WRITE-ONLY is the whole design. The route never returns a stored value, only
 * whether the variable is set, so this component asks that question once on
 * mount and otherwise holds the typed value in local state that is cleared the
 * moment it has been sent. There is no reveal affordance because there is
 * nothing to reveal it from.
 *
 * The key lands in ~/.hermes/.env, which is where Hermes reads environment
 * from — the same place `hermes config set TELEGRAM_BOT_TOKEN` puts the
 * Telegram token.
 */
function SecretInput({ label, envVar }: { label: string; envVar: string }) {
  const COPY = useCopy();
  const [value, setValue] = useState('');
  const [stored, setStored] = useState<boolean | null>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  useEffect(() => {
    let cancelled = false;
    fetch(`/setup-api/hermes/skills/secrets?keys=${encodeURIComponent(envVar)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!cancelled) setStored(d?.secrets?.[envVar] === true);
      })
      .catch(() => {
        if (!cancelled) setStored(null);
      });
    return () => {
      cancelled = true;
    };
  }, [envVar]);

  const save = async (next: string) => {
    setState('saving');
    try {
      const res = await fetch('/setup-api/hermes/skills/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: envVar, value: next }),
      });
      if (!res.ok) throw new Error('save failed');
      setStored(next.length > 0);
      setValue('');
      setState(next ? 'saved' : 'idle');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2" data-testid={`skill-secret-${envVar}`}>
      <label className="sr-only" htmlFor={`hs-secret-${envVar}`}>
        {COPY.secretSaveLabel(label)}
      </label>
      <input
        id={`hs-secret-${envVar}`}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (state !== 'idle') setState('idle');
        }}
        placeholder={COPY.secretPlaceholder}
        className={`min-w-0 flex-1 h-8 px-2 rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] text-xs
                    text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none
                    focus:border-[var(--coral-bright)] ${FOCUS_RING}`}
      />
      <GhostButton onClick={() => save(value)} disabled={!value || state === 'saving'}>
        {state === 'saving' ? COPY.secretSaving : COPY.secretSave}
      </GhostButton>
      {stored && (
        <GhostButton tone="danger" onClick={() => save('')} disabled={state === 'saving'}>
          {COPY.secretClear}
        </GhostButton>
      )}
      <span className="text-[10px] text-[var(--text-secondary)] basis-full">
        {state === 'error'
          ? COPY.secretFailed
          : state === 'saved'
            ? COPY.secretSaved
            : stored
              ? COPY.secretStored
              : COPY.secretHelp}
      </span>
    </div>
  );
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

function severityRank(f: ScanFinding): number {
  const i = SEVERITY_ORDER.indexOf((f.severity || 'info').toLowerCase());
  return i === -1 ? SEVERITY_ORDER.length : i;
}

function SecurityCard({ detail }: { detail: HermesSkillDetail }) {
  const COPY = useCopy();
  const [showAll, setShowAll] = useState(false);
  const security = detail.security;
  const prov = detail.provenance;
  const meta = trustMeta(detail.trust);
  const hasProvenance =
    prov &&
    (prov.sourceUrl || prov.repoUrl || prov.detailUrl || prov.homepage || prov.installCommand || prov.revision);
  if (!security && !hasProvenance && !detail.trust) return null;

  const findings = (security?.findings || []).slice().sort((a, b) => severityRank(a) - severityRank(b));
  const visible = showAll ? findings : findings.slice(0, 5);

  return (
    <Section title={COPY.sectionSecurity}>
      <div className="card-surface rounded-xl border border-[var(--border-subtle)] p-4 space-y-3 text-sm">
        <div className="flex items-start gap-2">
          <TrustChip trust={detail.trust} provider={detail.provider} />
          <p className="text-xs text-[var(--text-secondary)] flex-1 min-w-0">{meta.help}</p>
        </div>

        {security?.verdict && (
          <div className="text-xs text-[var(--text-secondary)] space-y-0.5">
            <p>
              <span className="text-[var(--text-primary)] font-medium">
                {security.verdict.toLowerCase() === 'safe' && findings.length === 0
                  ? COPY.scanPassed
                  : COPY.scanFlagged(findings.length)}
              </span>
              {security.scannerVersion && <> · {security.scannerVersion}</>}
              {COPY.relativeDate(security.scannedAt) && <> · {COPY.relativeDate(security.scannedAt)}</>}
            </p>
            {security.summary && <p>{security.summary}</p>}
          </div>
        )}

        {visible.length > 0 && (
          <ul className="space-y-1.5 list-none p-0 m-0">
            {visible.map((f, i) => (
              <li key={`${f.patternId}-${f.file}-${f.line}-${i}`} className="text-xs flex gap-2">
                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                    severityRank(f) <= 1 ? 'bg-red-500/15 text-red-300' : 'bg-amber-400/10 text-amber-300'
                  }`}
                >
                  {f.severity || 'info'}
                </span>
                <span className="min-w-0">
                  <span className="font-mono">{f.patternId}</span>
                  {f.file && (
                    <span className="text-[var(--text-secondary)]">
                      {' '}
                      · {f.file}
                      {typeof f.line === 'number' ? `:${f.line}` : ''}
                    </span>
                  )}
                  {f.description && <span className="block text-[var(--text-secondary)]">{f.description}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {findings.length > visible.length && (
          <GhostButton onClick={() => setShowAll(true)}>{COPY.showAllFindings(findings.length)}</GhostButton>
        )}

        {(hasProvenance || security?.contentHashShort) && (
          <dl className="grid grid-cols-1 @sm:grid-cols-2 gap-3 pt-1">
            {prov?.sourceUrl && (
              <div className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
                  {prov.sourceUrlVerified ? COPY.provSource : COPY.provSourceUnverified}
                </dt>
                <dd className="min-w-0">
                  <ExternalUrl href={prov.sourceUrl} />
                </dd>
              </div>
            )}
            {prov?.repoUrl && prov.repoUrl !== prov.sourceUrl && (
              <div className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">{COPY.provRepo}</dt>
                <dd className="min-w-0">
                  <ExternalUrl href={prov.repoUrl} />
                </dd>
              </div>
            )}
            {prov?.detailUrl && (
              <div className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
                  {COPY.provDetailPage}
                </dt>
                <dd className="min-w-0">
                  <ExternalUrl href={prov.detailUrl} />
                </dd>
              </div>
            )}
            {prov?.homepage && (
              <div className="min-w-0">
                <dt className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)]">
                  {COPY.provHomepage}
                </dt>
                <dd className="min-w-0">
                  <ExternalUrl href={prov.homepage} />
                </dd>
              </div>
            )}
            {typeof prov?.installCount === 'number' && (
              <Field label={COPY.provWeeklyInstalls}>{prov.installCount.toLocaleString()}</Field>
            )}
            {prov?.installCommand && (
              <Field label={COPY.provInstallCommand}>
                <span className="font-mono text-xs">{prov.installCommand}</span>
              </Field>
            )}
            {security?.contentHashShort && (
              <Field label={COPY.provContentHash}>
                <span className="font-mono text-xs">{security.contentHashShort}</span>
              </Field>
            )}
          </dl>
        )}
      </div>
    </Section>
  );
}

function IdentityGrid({ detail }: { detail: HermesSkillDetail }) {
  const COPY = useCopy();
  const install = detail.install;
  const fields: { label: string; value: string }[] = [];
  if (detail.version) fields.push({ label: COPY.fieldVersion, value: detail.version });
  if (detail.author) fields.push({ label: COPY.fieldAuthor, value: detail.author });
  if (detail.license) fields.push({ label: COPY.fieldLicense, value: detail.license });
  if (detail.category) fields.push({ label: COPY.fieldCategory, value: detail.category });
  if (detail.platforms?.length) {
    fields.push({ label: COPY.fieldPlatforms, value: detail.platforms.map(platformName).join(', ') });
  }
  if (install?.fileCount) {
    fields.push({
      label: COPY.fieldSize,
      value: `${COPY.fileCount(install.fileCount)}${install.bytes ? ` · ${formatBytes(install.bytes)}` : ''}`,
    });
  }
  if (install?.supportDirs.length) {
    fields.push({ label: COPY.fieldIncludes, value: install.supportDirs.join(', ') });
  }
  const installedAgo = COPY.relativeDate(install?.installedAt);
  if (installedAgo) fields.push({ label: COPY.fieldInstalled, value: installedAgo });
  const updatedAgo =
    install?.updatedAt && install.updatedAt !== install.installedAt
      ? COPY.relativeDate(install.updatedAt)
      : undefined;
  if (updatedAgo) fields.push({ label: COPY.fieldUpdated, value: updatedAgo });
  if (!fields.length) return null;

  return (
    <Section title={COPY.sectionGlance}>
      {/* Four columns need real width: at the container's @sm (384 px) each
          cell was ~85 px and every value was clipped to two clamped lines. */}
      <dl className="grid grid-cols-2 @2xl:grid-cols-4 gap-2">
        {fields.map((f) => (
          <div key={f.label} className="card-surface rounded-xl px-3 py-2 border border-[var(--border-subtle)]">
            <Field label={f.label} title={f.value}>
              {f.value}
            </Field>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function RelatedSkills({
  names,
  installedNames,
  onOpen,
}: {
  names: string[];
  installedNames: Set<string>;
  onOpen: (name: string) => void;
}) {
  const COPY = useCopy();
  if (!names.length) return null;
  return (
    <Section title={COPY.sectionRelated}>
      <ul className="flex flex-wrap gap-2 list-none p-0 m-0">
        {names.map((n) => (
          <li key={n}>
            <button
              type="button"
              onClick={() => onOpen(n)}
              className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs bg-[var(--surface-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors ${FOCUS_RING}`}
            >
              <span className="material-symbols-rounded" style={{ fontSize: 13 }} aria-hidden="true">
                {installedNames.has(n) ? 'check_circle' : 'extension'}
              </span>
              {n}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function AmbiguityChooser({
  query,
  candidates,
  onPick,
}: {
  query: string;
  candidates: HermesSkill[];
  onPick: (skill: HermesSkill) => void;
}) {
  const COPY = useCopy();
  return (
    <Section title={COPY.ambiguousTitle(candidates.length, query)}>
      <ul className="space-y-2 list-none p-0 m-0">
        {candidates.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => onPick(c)}
              className={`w-full text-left card-surface rounded-xl border border-[var(--border-subtle)] px-3 py-2 hover:border-[var(--coral-bright)]/40 transition-colors ${FOCUS_RING}`}
            >
              <span className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{c.name}</span>
                <TrustChip trust={c.trust} />
                <SourceChip source={c.source} />
              </span>
              <span className="block font-mono text-[11px] text-[var(--text-secondary)] break-all mt-1">{c.id}</span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ── The view ────────────────────────────────────────────────────────────────

export function SkillDetail({
  skill,
  detail,
  phase,
  error,
  ambiguous,
  action,
  breadcrumb,
  installedNames,
  onBack,
  onOpenSkill,
}: {
  skill: AnySkill;
  detail: HermesSkillDetail | null;
  phase: 'idle' | 'meta' | 'docs' | 'done';
  error: string | null;
  ambiguous: { query: string; candidates: HermesSkill[] } | null;
  action: ReactNode;
  breadcrumb: string;
  installedNames: Set<string>;
  onBack: () => void;
  onOpenSkill: (skill: HermesSkill) => void;
}) {
  const COPY = useCopy();
  const [copied, setCopied] = useState(false);
  // Doc expansion is DERIVED from the body (long docs start collapsed) with an
  // explicit user override keyed to that body — so switching skills resets it
  // without an effect that re-renders the view a second time.
  const [docsOverride, setDocsOverride] = useState<{ key: string; value: boolean } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Opening a card unmounts the grid, so focus falls back to <body>: a keyboard
  // user would have to tab from the top of the document and a screen reader
  // would announce nothing. Move it to this view's heading instead. (The store
  // restores focus to the originating card on Back.)
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const identifier = ('identifier' in skill && skill.identifier) || skill.id;
  const description = detail?.description || skill.description;
  const provenanceNote =
    detail?.provenanceNote || ('provenanceNote' in skill ? skill.provenanceNote : undefined);

  const docsKey = `${detail?.id ?? ''}:${detail?.body?.length ?? 0}`;
  const docsExpanded =
    docsOverride && docsOverride.key === docsKey
      ? docsOverride.value
      : !docsCollapsible(detail?.body || '');
  const expandDocs = () => setDocsOverride({ key: docsKey, value: true });
  const tags = detail?.tags || skill.tags || [];
  const platforms = detail?.platforms || ('platforms' in skill ? skill.platforms : undefined);
  const incompatible = detail?.incompatible ?? ('incompatible' in skill ? skill.incompatible : false);

  const copyId = async () => {
    try {
      await navigator.clipboard.writeText(identifier);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the identifier is selectable on screen anyway */
    }
  };

  return (
    <div className="h-full flex flex-col bg-[var(--bg-deep)] text-[var(--text-primary)]" data-testid="skill-detail">
      <div className="shrink-0 px-4 py-3 border-b border-[var(--border-subtle)] flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className={`w-8 h-8 flex items-center justify-center rounded-lg hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
          aria-label={COPY.back}
        >
          <span className="material-symbols-rounded text-[var(--text-secondary)]" style={{ fontSize: 20 }}>
            arrow_back
          </span>
        </button>
        <nav aria-label={COPY.breadcrumbLabel} className="text-sm text-[var(--text-secondary)] min-w-0 truncate">
          {breadcrumb} <span aria-hidden="true">›</span>{' '}
          <span className="text-[var(--text-primary)]">{detail?.name || skill.name}</span>
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto @container">
        <div className="p-6 max-w-3xl w-full mx-auto">
          {/* Header */}
          <div className="flex gap-4 mb-5 flex-col @sm:flex-row">
            <SkillTile name={skill.name} category={detail?.category || skill.category} tags={tags} large />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h2 ref={headingRef} tabIndex={-1} className="text-xl font-bold break-words focus:outline-none">
                  {detail?.name || skill.name}
                </h2>
                <TrustChip trust={detail?.trust || skill.trust} provider={detail?.provider} />
                <SourceChip source={detail?.source || skill.source} />
              </div>
              <div className="flex items-center gap-2 mt-2 min-w-0">
                <p className="text-xs text-[var(--text-secondary)] break-all font-mono min-w-0">{identifier}</p>
                <button
                  type="button"
                  onClick={copyId}
                  className={`shrink-0 w-7 h-7 flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
                  aria-label={COPY.copyIdentifier}
                  title={copied ? COPY.copied : COPY.copyIdentifier}
                >
                  <span className="material-symbols-rounded" style={{ fontSize: 15 }} aria-hidden="true">
                    {copied ? 'check' : 'content_copy'}
                  </span>
                </button>
              </div>
              {tags.length > 0 && (
                <div className="flex items-center gap-1.5 flex-wrap mt-2">
                  {tags.slice(0, 8).map((t) => (
                    <TagPill key={t} tag={t} />
                  ))}
                </div>
              )}
              <div className="mt-3 flex items-center gap-3 flex-wrap">{action}</div>
            </div>
          </div>

          {/* Alerts — anything that changes whether the user should install */}
          {incompatible && platforms?.length ? (
            <Alert tone="warn" icon="warning">
              {COPY.platformWarning(platforms)}
            </Alert>
          ) : null}
          {(detail?.trust || skill.trust) === 'community' && (
            <Alert tone="warn" icon="groups">
              {trustMeta('community').help}
            </Alert>
          )}
          {error && (
            <Alert tone="info" icon="info">
              {error}
            </Alert>
          )}

          {ambiguous ? (
            <AmbiguityChooser query={ambiguous.query} candidates={ambiguous.candidates} onPick={onOpenSkill} />
          ) : (
            <>
              {detail && <RequirementsCard detail={detail} />}
              {detail && <IdentityGrid detail={detail} />}

              {description && (
                <Section title={COPY.sectionAbout}>
                  <p className="text-sm leading-relaxed text-[var(--text-primary)]/85 whitespace-pre-line break-words">
                    {description}
                  </p>
                </Section>
              )}
              {!description && provenanceNote && (
                <Section title={COPY.sectionAbout}>
                  <p className="text-sm text-[var(--text-secondary)] italic">{provenanceNote}</p>
                </Section>
              )}

              {detail && <SecurityCard detail={detail} />}

              {detail?.relatedSkills?.length ? (
                <RelatedSkills
                  names={detail.relatedSkills}
                  installedNames={installedNames}
                  onOpen={(name) => onOpenSkill({ id: name, name })}
                />
              ) : null}

              {phase !== 'done' && !detail?.body && (
                <Section title={COPY.sectionDocs}>
                  <div className="space-y-2 animate-pulse" aria-hidden="true">
                    {[...Array(5)].map((_, i) => (
                      <div
                        key={i}
                        className="h-3 rounded bg-[var(--surface-card)]"
                        style={{ width: `${90 - i * 8}%` }}
                      />
                    ))}
                  </div>
                  <p className="sr-only">{COPY.docsLoading}</p>
                </Section>
              )}

              {detail?.body && (
                <Section
                  title={COPY.sectionDocs}
                  action={
                    detail.headings && detail.headings.length > 2 ? (
                      <span className="text-[10px] text-[var(--text-secondary)]">
                        {COPY.docsSections(detail.headings.length)}
                      </span>
                    ) : undefined
                  }
                >
                  {/* An outline of what the doc covers. It is a summary, not a
                      jump list: the markdown renderer emits no heading ids, so
                      offering anchors that don't work would be worse than this. */}
                  {detail.headings && detail.headings.length > 2 && (
                    <div className="mb-3">
                      <p className="text-[10px] uppercase tracking-wider text-[var(--text-secondary)] mb-1">
                        {COPY.docsOutline}
                      </p>
                      <ul className="flex flex-wrap gap-1.5 list-none p-0 m-0">
                        {detail.headings.slice(0, 12).map((h) => (
                          <li key={h.slug}>
                            <button
                              type="button"
                              onClick={expandDocs}
                              className={`px-2 py-0.5 rounded-full text-[11px] bg-[var(--surface-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors ${FOCUS_RING}`}
                            >
                              {h.text}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <DocumentBody
                    detail={detail}
                    expanded={docsExpanded}
                    onToggle={() => setDocsOverride({ key: docsKey, value: !docsExpanded })}
                  />
                </Section>
              )}

              {phase === 'done' && detail && !detail.body && !ambiguous && (
                <EmptyState icon="description" title={COPY.docsUnavailable} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
