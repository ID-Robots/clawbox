'use client';

import type { ReactNode } from 'react';
import { type HermesSkill, type InstalledHermesSkill, formatBytes } from '@/lib/hermes-skills';
import { COPY, platformName, relativeDate } from './copy';
import { FOCUS_RING, MetaChip, ScanChip, SkillTile, SourceChip, TagPill, TrustChip } from './primitives';

// One card shape for both tabs. The information order is fixed: what it is
// (tile + name), how far you can trust it, what it does, where it came from,
// then the action. Anything that could stop the skill working on this device
// (a macOS-only skill) outranks all of it.

type AnySkill = HermesSkill | InstalledHermesSkill;

function isInstalledSkill(skill: AnySkill): skill is InstalledHermesSkill {
  return 'origin' in skill;
}

export function SkillCard({
  skill,
  onOpen,
  action,
}: {
  skill: AnySkill;
  onOpen: () => void;
  action: ReactNode;
}) {
  const installedSkill = isInstalledSkill(skill) ? skill : null;
  const installedAgo = relativeDate(installedSkill?.installedAt);
  const tags = skill.tags || [];
  // Only catalog records carry a provenance note (installed skills always have
  // their own description from SKILL.md).
  const provenanceNote = 'provenanceNote' in skill ? skill.provenanceNote : undefined;

  return (
    <li
      className="relative h-full card-surface rounded-2xl p-3 flex gap-3 border border-[var(--border-subtle)]
                 hover:border-[var(--coral-bright)]/40 hover:-translate-y-0.5 hover:shadow-lg transition-all"
      data-testid="skill-card"
    >
      <SkillTile name={skill.name} category={skill.category} tags={tags} />
      <div className="flex-1 min-w-0 flex flex-col">
        <h3 className="font-medium text-sm min-w-0">
          {/* Stretched link: the whole card opens the detail view, but there is
              exactly ONE tab stop for it and the action button stays separate. */}
          <button
            type="button"
            onClick={onOpen}
            // The store finds this button by id to restore focus on Back.
            data-skill-open={skill.id}
            className={`text-left w-full truncate rounded after:absolute after:inset-0 after:rounded-2xl ${FOCUS_RING}`}
          >
            {skill.name}
          </button>
        </h3>

        <div className="flex items-center gap-1 flex-wrap mt-1 min-w-0">
          <TrustChip trust={skill.trust} provider={'provider' in skill ? skill.provider : undefined} />
          <SourceChip source={skill.source} />
          {installedSkill && installedSkill.origin === 'local' && (
            <MetaChip icon="draw" text={COPY.originLocal} title={COPY.originLocalHelp} />
          )}
          {installedSkill && (
            <ScanChip verdict={installedSkill.scanVerdict} findings={installedSkill.scanFindingCount} />
          )}
        </div>

        {skill.description ? (
          <p className="text-xs text-[var(--text-secondary)] mt-1.5 line-clamp-2">{skill.description}</p>
        ) : provenanceNote ? (
          <p className="text-xs text-[var(--text-secondary)]/80 mt-1.5 italic truncate">{provenanceNote}</p>
        ) : null}

        {installedSkill?.incompatible && installedSkill.platforms && (
          <p className="mt-1.5 text-[11px] text-amber-300 flex items-center gap-1">
            <span className="material-symbols-rounded shrink-0" style={{ fontSize: 13 }} aria-hidden="true">
              warning
            </span>
            <span className="truncate">
              {COPY.platformOnly(installedSkill.platforms.map(platformName))}
            </span>
          </p>
        )}

        <div className="flex items-center gap-1 flex-wrap mt-1.5 min-w-0">
          {installedSkill ? (
            <>
              <MetaChip icon="category" text={installedSkill.category} />
              {typeof installedSkill.fileCount === 'number' && (
                <MetaChip icon="description" text={COPY.fileCount(installedSkill.fileCount)} />
              )}
              {installedAgo && <MetaChip icon="schedule" text={COPY.installedAgo(installedAgo)} />}
            </>
          ) : (
            <>
              {'hostname' in skill && skill.hostname && <MetaChip icon="language" text={skill.hostname} />}
              {'installCount' in skill && typeof skill.installCount === 'number' && (
                <MetaChip icon="download" text={skill.installCount.toLocaleString()} />
              )}
              {tags.slice(0, 3).map((t) => (
                <TagPill key={t} tag={t} />
              ))}
            </>
          )}
        </div>

        <div className="mt-auto pt-2 relative z-10">{action}</div>
      </div>
    </li>
  );
}

export function CardSkeleton() {
  return (
    <li
      className="card-surface rounded-2xl p-3 min-h-[8rem] border border-[var(--border-subtle)] animate-pulse"
      aria-hidden="true"
    >
      <div className="flex gap-3">
        <div className="w-11 h-11 rounded-xl bg-[var(--surface-card)]" />
        <div className="flex-1 space-y-2 pt-1">
          <div className="h-3 w-1/2 rounded bg-[var(--surface-card)]" />
          <div className="h-2 w-1/3 rounded bg-[var(--surface-card)]" />
          <div className="h-2 w-full rounded bg-[var(--surface-card)]" />
        </div>
      </div>
    </li>
  );
}

export function SkillGrid({ children, busy }: { children: ReactNode; busy?: boolean }) {
  return (
    <ul
      role="list"
      aria-busy={busy || undefined}
      className="grid grid-cols-1 @sm:grid-cols-2 @3xl:grid-cols-3 @5xl:grid-cols-4 gap-3 list-none p-0 m-0"
    >
      {children}
    </ul>
  );
}

/** Size + file count line used on the detail header. */
export function sizeLabel(fileCount?: number, bytes?: number): string | undefined {
  if (typeof fileCount !== 'number' && typeof bytes !== 'number') return undefined;
  const parts: string[] = [];
  if (typeof fileCount === 'number') parts.push(`${fileCount} ${fileCount === 1 ? 'file' : 'files'}`);
  if (typeof bytes === 'number' && bytes > 0) parts.push(formatBytes(bytes));
  return parts.join(' · ');
}
