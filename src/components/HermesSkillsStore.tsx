'use client';

import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type HermesSkill,
  type InstalledHermesSkill,
  type SortOption,
  MAX_FACET_VALUES,
  SORT_OPTIONS,
  isRemovableOrigin,
  sourceLabel,
  trustMeta,
} from '@/lib/hermes-skills';
import type { SkillDangerWarning } from '@/lib/hermes-skill-capabilities';
import {
  type InstalledFacetGroup,
  type InstalledSelection,
  EMPTY_INSTALLED_SELECTION,
  INSTALLED_FACET_GROUPS,
  SAFETY_BUCKETS,
  TRUST_BUCKETS,
  categoryLabelFromKey,
  facetInstalled,
  fixedFacets,
  rankFacets,
} from '@/lib/hermes-skill-facets';
import { type SkillsCopy, useCopy } from './hermes-skills/copy';
import {
  Alert,
  EmptyState,
  FOCUS_RING,
  GhostButton,
  PrimaryButton,
} from './hermes-skills/primitives';
import {
  type FacetGroupSpec,
  ActiveFilterChips,
  FacetDrawerButton,
  FacetRail,
  chipsFromGroups,
} from './hermes-skills/FacetRail';
import { CardSkeleton, SkillCard, SkillGrid } from './hermes-skills/SkillCard';
import { ConfirmDialog } from './hermes-skills/ConfirmDialog';
import { DangerConfirmDialog } from './hermes-skills/DangerConfirmDialog';
import { SkillDetail } from './hermes-skills/SkillDetail';
import { type BrowseFacetGroup, useSkillCatalog } from './hermes-skills/useSkillCatalog';
import { useInstalledSkills } from './hermes-skills/useInstalledSkills';
import { useSkillDetail } from './hermes-skills/useSkillDetail';

// Hermes-flavoured skills store — the Hermes edition's equivalent of the
// OpenClaw App Store. Fully self-contained: it manages its own installed list,
// creates no desktop icons, and drives Hermes' own CLI (~/.hermes/skills)
// through /setup-api/hermes/skills/*. No parent props required.
//
// This file is the SHELL: tab state, the toolbar, the two grids, the mutations
// and the routing between grid and detail. The data lives in the three hooks and
// the presentation in ./hermes-skills/*.

type AnySkill = HermesSkill | InstalledHermesSkill;
type ProgressState = { status: 'working' | 'success' | 'error'; message?: string };

/**
 * What a Remove button needs: the lock.json key the CLI takes, the key this
 * component tracks progress under, and the detail-cache key(s) the answer is
 * stored beneath. The last one is why `identifier` is carried separately — the
 * detail cache is keyed by registry identifier, so invalidating only the lock
 * name left a removed skill still reading as installed on its Browse card.
 */
type UninstallTarget = { name: string; key: string; identifier?: string };

/** The fields of an install/uninstall refusal the card reads. */
type RefusalBody = {
  code?: string;
  name?: string;
  warning?: { verdict?: string; trust?: string };
  /** `ambiguous_name`: the lock ids the argument could not be told apart from. */
  candidates?: string[];
};

/**
 * The card's line for a refusal the route named by code, or null for a code
 * this build does not know. Every code below answers with a FIXED sentence on
 * the server — English, composed there, and painted verbatim on the card until
 * this map existed. The codes whose sentence is composed from device state
 * (`rollback_incomplete`, `removal_incomplete`, a pre-existing
 * `incomplete_install`) are deliberately not here: their branches above keep
 * the route's words until the store can describe that state itself.
 */
function installRefusalCopy(COPY: SkillsCopy, data: RefusalBody, name: string): string | null {
  switch (data.code) {
    case 'install_timeout':
      return COPY.installTimeout(name);
    case 'ambiguous_id':
      return COPY.ambiguousId;
    case 'rate_limited':
      return COPY.rateLimited;
    case 'download_failed':
      return COPY.downloadFailed;
    case 'unresolved':
      return COPY.unresolved;
    case 'install_failed':
      return COPY.installFailed;
    case 'dangerous_skill_blocked':
      return COPY.blockedByDevice(name, data.warning?.verdict, data.warning?.trust);
    case 'already_installed':
      // Two route branches share the code: the plain refusal, and the one that
      // found the installed copy's own scan verdict flagged — that one carries
      // the `warning` and the lock name.
      return data.warning
        ? COPY.alreadyInstalledFlagged(data.name || name, data.warning.verdict)
        : COPY.alreadyInstalled;
    // The CLI itself could not be run to completion. A deadline is the one
    // case with its own line; the rest are one failure to the owner.
    case 'cli_timeout':
      return COPY.installTimeout(name);
    // ...except `too_large`, which is not a failure: the installer's output
    // overran the read cap AFTER it ran, so whether the skill landed is not
    // known. The MCP tool has always told the agent exactly that ("call
    // skill_list and look for it before deciding anything"); the store said
    // "Install failed", so one device state had two contradictory stories.
    case 'too_large':
      return COPY.installUnknownOutcome(name);
    case 'cli_missing':
    case 'cli_failed':
    case 'cancelled':
      return COPY.installFailed;
    default:
      return null;
  }
}

function uninstallRefusalCopy(COPY: SkillsCopy, data: RefusalBody, name: string): string | null {
  switch (data.code) {
    case 'builtin_skill':
      return COPY.builtinSkill(name);
    case 'not_installed':
      return COPY.notInstalled(name);
    case 'uninstall_refused':
      return COPY.uninstallRefused;
    case 'ambiguous_name': {
      // The candidates ARE the answer here — without them the line says a
      // choice is needed and gives nothing to choose between, so an empty list
      // falls through to the route's own sentence rather than a useless one.
      const candidates = Array.isArray(data.candidates)
        ? data.candidates.filter((c): c is string => typeof c === 'string')
        : [];
      return candidates.length ? COPY.ambiguousName(name, candidates) : null;
    }
    case 'too_large':
      return COPY.uninstallUnknownOutcome(name);
    case 'uninstall_failed':
    case 'cli_timeout':
    case 'cli_missing':
    case 'cli_failed':
    case 'cancelled':
      return COPY.uninstallFailed;
    default:
      return null;
  }
}

/**
 * The line the card gets for a refusal: the copy for its code; else, for a
 * code this build does not know, the route's own sentence — a newer device may
 * name a refusal this build has no copy for, and its words beat "HTTP 502";
 * else, for no code at all (an older build, a transport error), the generic
 * line — the sentence is English composed on the server, and it goes to the
 * console, as the browse tab already does with its own.
 */
function refusalLine(copy: string | null, data: RefusalBody & { error?: unknown }, status: number, generic: string, tag: string): string {
  if (copy) return copy;
  const sentence = typeof data.error === 'string' && data.error ? data.error : `HTTP ${status}`;
  if (data.code) return sentence;
  console.error(tag, sentence);
  return generic;
}

const SELECT_CLS =
  'rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] px-3 py-2 text-sm text-[var(--text-primary)] ' +
  'focus:outline-none focus:border-[var(--coral-bright)]';

export default function HermesSkillsStore({ testId }: { testId?: string }) {
  const COPY = useCopy();
  const [tab, setTab] = useState<'installed' | 'browse'>('installed');
  const [selected, setSelected] = useState<AnySkill | null>(null);
  const [progress, setProgress] = useState<Record<string, ProgressState>>({});
  const [confirmInstall, setConfirmInstall] = useState<HermesSkill | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<UninstallTarget | null>(null);
  // TASK-452: the install route answers 409 for a skill its scanner flagged.
  // The dialog it opens is the ONLY way a `confirmDangerous: true` call is ever
  // made — the flag is never sent on a first attempt.
  const [danger, setDanger] = useState<{ skill: HermesSkill; warning: SkillDangerWarning } | null>(null);
  const [installedQuery, setInstalledQuery] = useState('');
  const [installedSelection, setInstalledSelection] = useState<InstalledSelection>(
    EMPTY_INSTALLED_SELECTION,
  );
  const [live, setLive] = useState('');
  // A SECOND polite region, kept apart from `live`: an install/removal narration
  // and a "42 skills match" are different announcements, and sharing one node
  // meant whichever landed second silently replaced the other.
  const [filterLive, setFilterLive] = useState('');

  const catalog = useSkillCatalog(tab === 'browse');
  const installed = useInstalledSkills();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // One timer per skill key; cleared on replacement AND on unmount so a fast
  // install→uninstall→install sequence can't leave a stale "error" behind.
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of map.values()) clearTimeout(t);
      map.clear();
    };
  }, []);

  const inspectId = useMemo(() => {
    if (!selected) return null;
    return ('identifier' in selected && selected.identifier) || selected.id;
  }, [selected]);
  // A skill picked from the Installed tab is identified by its DIRECTORY name,
  // which the route may only resolve against disk when it knows that's where
  // the id came from (bare registry ids collide with bundled directories).
  const detail = useSkillDetail(inspectId, !!selected && 'origin' in selected);

  // Match a browse row against the installed set on the REGISTRY IDENTIFIER
  // only. clawhub identifiers are bare names (`notion`, `arxiv`, `pdf`) and 40
  // of them are byte-identical to a bundled skill's directory, so matching on
  // the lock/directory name marked skills the user never installed as
  // "Installed" — and offered a Remove that would delete the bundled one.
  // A hub-installed skill's lock key IS a real install target, so it still
  // counts; a builtin/local one never does.
  const installedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of installed.skills) {
      if (s.identifier) ids.add(s.identifier);
      if (s.origin === 'hub') ids.add(s.id);
    }
    return ids;
  }, [installed.skills]);
  const installedNames = useMemo(
    () => new Set(installed.skills.map((s) => s.id)),
    [installed.skills],
  );

  const isInstalled = useCallback((skill: { id: string }) => installedIds.has(skill.id), [installedIds]);

  /** How a browse result would be removed, when the store installed it. */
  const uninstallTargetFor = useCallback(
    (skill: { id: string }): UninstallTarget | null => {
      const match = installed.skills.find(
        (s) => s.identifier === skill.id || (s.origin === 'hub' && s.id === skill.id),
      );
      // Only hub-installed skills are removable: `hermes skills uninstall`
      // works off the lock, so a Remove for anything else can only fail. The
      // rule is shared with the agent's skill_list/skill_uninstall so the page
      // and the assistant cannot answer one device state two ways.
      if (!match || !isRemovableOrigin(match.origin)) return null;
      return { name: match.id, key: skill.id, identifier: match.identifier || skill.id };
    },
    [installed.skills],
  );

  const setProgressAutoClear = useCallback((key: string, state: ProgressState, ms: number) => {
    setProgress((p) => ({ ...p, [key]: state }));
    const existing = timers.current.get(key);
    if (existing) clearTimeout(existing);
    timers.current.set(
      key,
      setTimeout(() => {
        timers.current.delete(key);
        setProgress((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
      }, ms),
    );
  }, []);

  const doInstall = useCallback(
    async (skill: HermesSkill, confirmDangerous = false) => {
      setConfirmInstall(null);
      setDanger(null);
      const key = skill.id;
      setProgress((p) => ({ ...p, [key]: { status: 'working' } }));
      setLive(COPY.liveInstalling(skill.name));
      try {
        const res = await fetch('/setup-api/hermes/skills/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // The confirmation flag is only ever present on the call the danger
          // dialog makes; a plain install never carries it.
          body: JSON.stringify(confirmDangerous ? { id: skill.id, confirmDangerous: true } : { id: skill.id }),
        });
        const data = await res.json().catch(() => ({}));
        // 409 is not a failure to report — it is a question to ask. Clear the
        // in-progress state so the card is not left spinning behind the dialog.
        if (res.status === 409 && data?.code === 'dangerous_skill' && data.warning) {
          setProgress((p) => {
            const next = { ...p };
            delete next[key];
            return next;
          });
          setDanger({ skill, warning: data.warning as SkillDangerWarning });
          setLive(COPY.dangerTitle(skill.name));
          return;
        }
        if (res.status === 409 && data?.code === 'bundled_conflict') {
          throw new Error(COPY.nameConflict(String(data.conflictsWith || skill.name)));
        }
        if (res.status === 502 && data?.code === 'incomplete_install') {
          // Two device states share this code. `preexisting` means the skill was
          // already installed before this request, so the rollback deliberately
          // left the customer's copy alone — and the translated copy for the
          // other state ("Nothing was installed. Check your internet connection
          // and try again.") is false twice over: it IS installed, and the retry
          // it invites re-enters this branch, because the installer meets the
          // surviving lock entry and exits 0 without fetching anything. The
          // route's own sentence is the one that matches the device, the same
          // way `rollback_incomplete` below takes it.
          if (data.preexisting) {
            // The row they are being told to remove is the one on screen: the
            // Installed tab still holds the pre-request list.
            await installed.refresh();
            throw new Error(String(data.error || COPY.installFailed));
          }
          throw new Error(COPY.installIncomplete((data.missingFiles as string[]) || []));
        }
        // A rollback the device could not finish leaves a lock entry THIS
        // request created, and the message tells the customer to remove it from
        // this very store. The Installed tab still holds the pre-request list,
        // so the row they are being sent to is not on screen until the list is
        // re-read — the generic throw below goes straight to the error toast.
        if (res.status === 409 && data?.code === 'rollback_incomplete') {
          await installed.refresh();
          throw new Error(String(data.error || COPY.installFailed));
        }
        // Every other refusal the route names by code is said in the owner's
        // language; the route's sentence is kept only for a code this build
        // has no copy for — still better than "HTTP 502".
        if (!res.ok) {
          const body = data ?? {};
          throw new Error(refusalLine(installRefusalCopy(COPY, body, skill.name), body, res.status, COPY.installFailed, '[skills install]'));
        }
        setProgressAutoClear(key, { status: 'success' }, 2000);
        // The detail answer changes completely once a skill is on disk (full
        // SKILL.md, scan report, size). Dropping the cache is not enough — the
        // open detail view keys its fetch on the id, which did not change, so
        // it has to be told to run again.
        detail.refresh(key);
        setLive(COPY.liveInstalled(skill.name));
        await installed.refresh();
      } catch (err) {
        setProgressAutoClear(
          key,
          { status: 'error', message: err instanceof Error ? err.message : COPY.installFailed },
          6000,
        );
        setLive(COPY.liveInstallFailed(skill.name));
      }
    },
    [COPY, detail, installed, setProgressAutoClear],
  );

  const doUninstall = useCallback(
    async ({ name, key, identifier }: UninstallTarget) => {
      setConfirmUninstall(null);
      setProgress((p) => ({ ...p, [key]: { status: 'working' } }));
      setLive(COPY.liveRemoving(name));
      try {
        const res = await fetch('/setup-api/hermes/skills/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: name }),
        });
        const data = await res.json().catch(() => ({}));
        // The mirror image on the way out: the lock entry went and the files did
        // not, so the skill comes back into the list as a local one the store
        // cannot offer to remove. The customer has to be able to see that.
        if (res.status === 409 && data?.code === 'removal_incomplete') {
          await installed.refresh();
          throw new Error(String(data.error || COPY.uninstallFailed));
        }
        if (!res.ok) {
          const body = data ?? {};
          throw new Error(refusalLine(uninstallRefusalCopy(COPY, body, name), body, res.status, COPY.uninstallFailed, '[skills uninstall]'));
        }
        const timer = timers.current.get(key);
        if (timer) clearTimeout(timer);
        timers.current.delete(key);
        setProgress((p) => {
          const next = { ...p };
          delete next[key];
          return next;
        });
        // Three possible cache keys for one skill: the lock name (Installed
        // tab), the registry identifier (Browse card and the detail view), and
        // whatever the button tracked progress under.
        detail.refresh(key, name, identifier);
        setLive(COPY.liveRemoved(name));
        await installed.refresh();
      } catch (err) {
        setProgressAutoClear(
          key,
          { status: 'error', message: err instanceof Error ? err.message : COPY.uninstallFailed },
          6000,
        );
        setLive(COPY.liveRemoveFailed(name));
      }
    },
    [COPY, detail, installed, setProgressAutoClear],
  );

  // ── Actions ───────────────────────────────────────────────────────────────

  const renderBrowseAction = useCallback(
    (skill: HermesSkill, size: 'card' | 'detail' = 'card'): ReactNode => {
      const state = progress[skill.id];
      const target = uninstallTargetFor(skill);
      if (state?.status === 'working') {
        return (
          <span className="inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span className="w-16 h-1 rounded-full bg-[var(--surface-card)] overflow-hidden" aria-hidden="true">
              <span className="block h-full w-1/2 bg-[var(--coral-bright)] animate-pulse" />
            </span>
            {COPY.installing}
          </span>
        );
      }
      if (state?.status === 'error') {
        return (
          <span className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-red-400 line-clamp-1" title={state.message}>
              {state.message}
            </span>
            {/*
              The button has to be the one the message asks for. A hub row
              exists for this skill, so the install just failed over a copy that
              is ON the device — the two refusals that say so ("remove it from
              the Skills store and install it again", and the leftover a
              rollback could not undo) both name removal as the next step, and
              Retry is the one action that cannot work: the installer meets the
              lock entry and exits 0 without fetching. `target` is null for
              anything the store cannot remove, so a skill that is genuinely not
              installed keeps Retry.
            */}
            {target ? (
              <GhostButton tone="danger" onClick={() => setConfirmUninstall(target)}>
                {COPY.remove}
              </GhostButton>
            ) : (
              <GhostButton tone="danger" onClick={() => setConfirmInstall(skill)}>
                {COPY.retry}
              </GhostButton>
            )}
          </span>
        );
      }
      if (state?.status === 'success' || isInstalled(skill)) {
        return (
          <span className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
              <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
                check_circle
              </span>
              {COPY.installed}
            </span>
            {target && (
              <GhostButton tone="danger" onClick={() => setConfirmUninstall(target)}>
                {COPY.remove}
              </GhostButton>
            )}
          </span>
        );
      }
      return (
        <span data-testid="skill-install-btn">
          <PrimaryButton size={size === 'detail' ? 'lg' : 'sm'} onClick={() => setConfirmInstall(skill)}>
            {COPY.install}
          </PrimaryButton>
        </span>
      );
    },
    [COPY, progress, uninstallTargetFor, isInstalled],
  );

  const renderInstalledAction = useCallback(
    (skill: InstalledHermesSkill): ReactNode => {
      const state = progress[skill.id];
      if (state?.status === 'working') {
        return <span className="text-xs text-[var(--text-secondary)]">{COPY.removing}</span>;
      }
      if (state?.status === 'error') {
        return (
          <span className="text-xs text-red-400 line-clamp-1" title={state.message}>
            {state.message}
          </span>
        );
      }
      // Only skills the STORE installed are removable: `hermes skills uninstall`
      // works off the hub lock, so offering Remove for a bundled skill or one
      // the agent wrote itself would be a button that can only fail.
      if (!isRemovableOrigin(skill.origin)) {
        return (
          <span className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)]">
            <span className="material-symbols-rounded" style={{ fontSize: 14 }} aria-hidden="true">
              {skill.origin === 'builtin' ? 'lock' : 'draw'}
            </span>
            {skill.origin === 'builtin' ? COPY.builtinLocked : COPY.originLocal}
          </span>
        );
      }
      return (
        <GhostButton
          tone="danger"
          onClick={() =>
            setConfirmUninstall({ name: skill.id, key: skill.id, identifier: skill.identifier })
          }
        >
          {COPY.remove}
        </GhostButton>
      );
    },
    [COPY, progress],
  );

  // ── Load-more sentinel (browse) ───────────────────────────────────────────
  useEffect(() => {
    if (tab !== 'browse' || !catalog.hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) catalog.loadMore();
      },
      { root: scrollRef.current, rootMargin: '400px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [tab, catalog.hasMore, catalog.loadMore, catalog]);

  // ── Installed list filtering ──────────────────────────────────────────────
  // The text search runs FIRST so the rail's counts describe what the search
  // left behind — the same relationship Browse has, where the server counts
  // facets over the query-matched rows.
  const installedSearched = useMemo(() => {
    const q = installedQuery.trim().toLowerCase();
    if (!q) return installed.skills;
    return installed.skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q) ||
        (s.description || '').toLowerCase().includes(q),
    );
  }, [installed.skills, installedQuery]);

  const installedFacets = useMemo(
    () => facetInstalled(installedSearched, installedSelection),
    [installedSearched, installedSelection],
  );
  const installedFiltered = installedFacets.rows;
  const installedActiveCount = INSTALLED_FACET_GROUPS.reduce(
    (n, group) => n + installedSelection[group].length,
    0,
  );

  const toggleInstalledFacet = useCallback((group: InstalledFacetGroup, id: string) => {
    setInstalledSelection((prev) => ({
      ...prev,
      [group]: prev[group].includes(id) ? prev[group].filter((v) => v !== id) : [...prev[group], id],
    }));
  }, []);
  const removeInstalledFacet = useCallback((group: InstalledFacetGroup, id: string) => {
    setInstalledSelection((prev) => ({ ...prev, [group]: prev[group].filter((v) => v !== id) }));
  }, []);
  const clearInstalledFilters = useCallback(() => setInstalledSelection(EMPTY_INSTALLED_SELECTION), []);

  // ── Rail labels ───────────────────────────────────────────────────────────
  // Trust and safety are fixed vocabularies, so their labels are COPY; a source
  // id or a category key is registry DATA and is labelled from itself. The two
  // origins the device invents (`builtin`, `local`) do have copy, and reusing
  // the store's own origin words keeps one vocabulary on the card and the rail.
  const trustFacetLabel = useCallback((id: string) => COPY.trustBucket(id), [COPY]);
  const safetyFacetLabel = useCallback((id: string) => COPY.safetyBucket(id), [COPY]);
  const sourceFacetLabel = useCallback(
    (id: string) =>
      id === 'builtin' ? COPY.originBuiltin : id === 'local' ? COPY.originLocal : sourceLabel(id),
    [COPY],
  );

  const { toggleFacet } = catalog;
  const browseGroups = useMemo<FacetGroupSpec[]>(
    () => [
      {
        id: 'trust',
        legend: COPY.facetTrust,
        options: catalog.facets.trust.map((f) => ({ ...f, label: trustFacetLabel(f.id) })),
        selected: catalog.selected.trust,
        onToggle: (id) => toggleFacet('trust', id),
      },
      {
        id: 'source',
        legend: COPY.sourceLabel,
        options: catalog.facets.sources,
        selected: catalog.selected.source,
        onToggle: (id) => toggleFacet('source', id),
      },
      {
        id: 'category',
        legend: COPY.categoryLabel,
        options: catalog.facets.categories,
        selected: catalog.selected.category,
        onToggle: (id) => toggleFacet('category', id),
        // Only 739 of the device's 90 605 catalogue rows declare a category, so
        // the group says how much of the result set it can even speak for,
        // rather than letting its buckets imply they add up to the total.
        note:
          catalog.total > 0
            ? COPY.facetCategoryCoverage(catalog.categoryCoverage, catalog.total)
            : undefined,
      },
      {
        id: 'provider',
        legend: COPY.providerLabel,
        options: catalog.facets.providers,
        selected: catalog.selected.provider,
        onToggle: (id) => toggleFacet('provider', id),
      },
    ],
    [
      COPY,
      catalog.facets,
      catalog.selected,
      catalog.categoryCoverage,
      catalog.total,
      toggleFacet,
      trustFacetLabel,
    ],
  );

  const installedGroups = useMemo<FacetGroupSpec[]>(
    () => [
      {
        id: 'trust',
        legend: COPY.facetTrust,
        options: fixedFacets(
          TRUST_BUCKETS,
          installedFacets.counts.trust,
          installedSelection.trust,
          trustFacetLabel,
        ),
        selected: installedSelection.trust,
        onToggle: (id) => toggleInstalledFacet('trust', id),
      },
      {
        id: 'safety',
        legend: COPY.facetSafety,
        options: fixedFacets(
          SAFETY_BUCKETS,
          installedFacets.counts.safety,
          installedSelection.safety,
          safetyFacetLabel,
        ),
        selected: installedSelection.safety,
        onToggle: (id) => toggleInstalledFacet('safety', id),
      },
      {
        id: 'category',
        legend: COPY.categoryLabel,
        options: rankFacets(
          installedFacets.counts.category,
          installedSelection.category,
          categoryLabelFromKey,
          MAX_FACET_VALUES,
        ),
        selected: installedSelection.category,
        onToggle: (id) => toggleInstalledFacet('category', id),
      },
      {
        id: 'source',
        legend: COPY.sourceLabel,
        options: rankFacets(
          installedFacets.counts.source,
          installedSelection.source,
          sourceFacetLabel,
          MAX_FACET_VALUES,
        ),
        selected: installedSelection.source,
        onToggle: (id) => toggleInstalledFacet('source', id),
      },
    ],
    [
      COPY,
      installedFacets.counts,
      installedSelection,
      safetyFacetLabel,
      sourceFacetLabel,
      toggleInstalledFacet,
      trustFacetLabel,
    ],
  );

  // ── The rail, resolved for the tab in view ────────────────────────────────
  const browsing = tab === 'browse';
  const groups = browsing ? browseGroups : installedGroups;
  const activeCount = browsing ? catalog.activeCount : installedActiveCount;
  const chips = useMemo(() => chipsFromGroups(groups), [groups]);
  const clearAllFilters = browsing ? catalog.clearFilters : clearInstalledFilters;
  const removeChip = useCallback(
    (groupId: string, id: string) => {
      if (browsing) catalog.removeFacet(groupId as BrowseFacetGroup, id);
      else removeInstalledFacet(groupId as InstalledFacetGroup, id);
    },
    [browsing, catalog, removeInstalledFacet],
  );
  const railFootnotes = useMemo(() => {
    if (!browsing) return undefined;
    const lines: string[] = [];
    // TASK-452's other half: a surface that states a number confidently and
    // wrongly. Without the offline index the counts CAN only be measured over
    // the rows that came back, so the rail says which of the two it is doing.
    if (catalog.facetScope === 'loaded') lines.push(COPY.facetCountsLoaded(catalog.results.length));
    lines.push(COPY.facetSafetyBrowseNote);
    return lines;
  }, [browsing, COPY, catalog.facetScope, catalog.results.length]);

  // The result count, announced politely — but only when the FILTERS moved.
  // Announcing on every render would narrate scrolling, and announcing while a
  // request is still in flight would read out the previous answer's total.
  const resultCount = browsing ? catalog.total : installedFiltered.length;
  const filterSignature = groups.map((g) => `${g.id}:${g.selected.join('+')}`).join('|');
  // Keyed by TAB, not just by signature: arriving on a tab — for the first time
  // or from the other one — is not a filter change, and each tab's rail has its
  // own groups. Seeding here rather than in the tab handler also makes a
  // remount silent, which is what a fresh view should be.
  const announced = useRef<{ tab: string; signature: string } | null>(null);
  useEffect(() => {
    if (announced.current?.tab !== tab) {
      announced.current = { tab, signature: filterSignature };
      return;
    }
    if (browsing && (catalog.loading || catalog.stale)) return;
    if (announced.current.signature === filterSignature) return;
    announced.current = { tab, signature: filterSignature };
    setFilterLive(resultCount === 0 ? COPY.liveResultsNone : COPY.liveResults(resultCount));
  }, [tab, browsing, catalog.loading, catalog.stale, filterSignature, resultCount, COPY]);

  // Stable handlers: the confirm dialog installs a focus trap keyed to them, so
  // a new identity on every parent render would yank focus back to Cancel while
  // the user is tabbing (the detail fetch resolves under the open dialog).
  /**
   * Changing tab drops the previous tab's announcement rather than leaving it
   * standing beside the new tab's results. In the handler, not an effect: the
   * tab only ever changes because someone pressed the button.
   */
  const selectTab = useCallback((next: 'installed' | 'browse') => {
    setTab(next);
    setFilterLive('');
  }, []);

  const closeInstallDialog = useCallback(() => setConfirmInstall(null), []);
  const closeUninstallDialog = useCallback(() => setConfirmUninstall(null), []);
  const closeDangerDialog = useCallback(() => setDanger(null), []);

  // Grid ↔ detail navigation. Both the scroll offset and the focused card are
  // restored on Back: the grid unmounts, so without this a user who opened the
  // 70th card came back to card 1 with focus on <body>.
  const browseScroll = useRef(0);
  const returnFocusId = useRef<string | null>(null);
  const openDetail = useCallback((skill: AnySkill) => {
    // Only when we're coming FROM the grid: this same handler moves between two
    // details (the ambiguity chooser, the related-skill chips), and those must
    // not overwrite the grid position we still have to return to.
    if (scrollRef.current) {
      browseScroll.current = scrollRef.current.scrollTop;
      returnFocusId.current = skill.id;
    }
    setSelected(skill);
  }, []);
  const closeDetail = useCallback(() => setSelected(null), []);

  useLayoutEffect(() => {
    if (selected || !scrollRef.current) return;
    scrollRef.current.scrollTop = browseScroll.current;
    const id = returnFocusId.current;
    if (!id) return;
    returnFocusId.current = null;
    // Match on the dataset rather than a built selector: skill ids come from
    // registries and are not guaranteed to be selector-safe.
    for (const node of scrollRef.current.querySelectorAll<HTMLElement>('[data-skill-open]')) {
      if (node.dataset.skillOpen === id) {
        node.focus();
        break;
      }
    }
  }, [selected]);

  // ── Dialogs ───────────────────────────────────────────────────────────────
  const installDialog = confirmInstall && (
    <ConfirmDialog
      title={COPY.installTitle(confirmInstall.name)}
      icon="extension"
      confirmLabel={COPY.install}
      onConfirm={() => doInstall(confirmInstall)}
      onCancel={closeInstallDialog}
    >
      <p className="font-mono text-xs break-all text-[var(--text-primary)]">{confirmInstall.id}</p>
      <p className="text-xs">
        {sourceLabel(confirmInstall.source)} · {trustMeta(confirmInstall.trust).label}
      </p>
      {confirmInstall.trust === 'community' || confirmInstall.trust === 'unknown' || !confirmInstall.trust ? (
        <Alert tone="warn" icon="groups">
          {COPY.installCommunityBody}
        </Alert>
      ) : (
        <p>{COPY.installTrustedBody}</p>
      )}
      {detail.detail?.requirements?.secrets.length ? (
        <p className="text-xs">{COPY.installWillAsk(detail.detail.requirements.secrets.map((s) => s.label))}</p>
      ) : null}
    </ConfirmDialog>
  );

  const dangerDialog = danger && (
    <DangerConfirmDialog
      warning={danger.warning}
      onConfirm={() => doInstall(danger.skill, true)}
      onCancel={closeDangerDialog}
    />
  );

  const uninstallDialog = confirmUninstall && (
    <ConfirmDialog
      title={COPY.uninstallTitle(confirmUninstall.name)}
      icon="delete"
      tone="danger"
      confirmLabel={COPY.remove}
      onConfirm={() => doUninstall(confirmUninstall)}
      onCancel={closeUninstallDialog}
    >
      <p>{COPY.uninstallBody(detail.detail?.install?.installPath)}</p>
    </ConfirmDialog>
  );

  const liveRegion = (
    <>
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {filterLive}
      </p>
    </>
  );

  // ── Detail view ───────────────────────────────────────────────────────────
  if (selected) {
    // Same rule as the installed cards: only hub-installed skills get an action.
    const fixedOrigin =
      'origin' in selected && !isRemovableOrigin(selected.origin) ? selected.origin : null;
    const action = fixedOrigin ? (
      <span className="inline-flex items-center gap-1 text-sm text-[var(--text-secondary)]">
        <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">
          {fixedOrigin === 'builtin' ? 'lock' : 'draw'}
        </span>
        {fixedOrigin === 'builtin' ? COPY.builtinLocked : COPY.originLocal}
      </span>
    ) : detail.ambiguous ? (
      // The id resolved to several skills, so it names none of them: installing
      // it can only fail. The chooser below is the whole action here.
      <span className="text-sm text-[var(--text-secondary)]">{COPY.ambiguousPickFirst}</span>
    ) : (
      renderBrowseAction(selected as HermesSkill, 'detail')
    );

    return (
      <div className="h-full" data-testid={testId || 'hermes-skills-store'}>
        {installDialog}
        {uninstallDialog}
        {dangerDialog}
        {liveRegion}
        <SkillDetail
          skill={selected}
          detail={detail.detail}
          phase={detail.phase}
          error={detail.error && COPY.detailError(detail.error.part, detail.error.code)}
          ambiguous={detail.ambiguous}
          action={action}
          breadcrumb={'origin' in selected ? COPY.breadcrumbInstalled : COPY.breadcrumbBrowse}
          installedNames={installedNames}
          onBack={closeDetail}
          onOpenSkill={openDetail}
        />
      </div>
    );
  }

  // ── Grid view ─────────────────────────────────────────────────────────────
  const q = catalog.query.trim();
  /** The one browse refusal the owner caused, and the only one Retry cannot fix. */
  const badQuery = catalog.error === 'bad_query';
  // A refusal the owner can undo by unticking, not by retrying: the rail's own
  // values, refused by the route. Retry resends exactly what was rejected.
  const badFilter = catalog.error === 'invalid_argument' || catalog.error === 'too_many_facets';
  const rangeFrom = catalog.results.length ? 1 : 0;
  // Two ways to earn the first-run panel: the device says it is still building
  // the index (`preparing` — true even though the request has COMPLETED, which
  // is the whole point), or a request is genuinely taking long enough that a
  // bare spinner stops being an explanation.
  const showFirstRun = browsing && (catalog.preparing || (catalog.loading && catalog.slow));
  // Dated by the DOWNLOAD, not the publisher's build stamp — the latter never
  // moves on a refetch, so it said "21 days ago" about a fresh catalogue.
  const staleWhen = catalog.catalog?.stale ? COPY.relativeDate(catalog.catalog.fetchedAt) : undefined;

  return (
    <div
      className="h-full flex flex-col bg-[var(--bg-deep)] text-[var(--text-primary)]"
      data-testid={testId || 'hermes-skills-store'}
    >
      {installDialog}
      {uninstallDialog}
      {dangerDialog}
      {liveRegion}

      {/* Header */}
      <div className="@container shrink-0 px-4 py-3 border-b border-[var(--border-subtle)]">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center bg-[var(--coral-bright)]">
            <span className="material-symbols-rounded text-white" style={{ fontSize: 20 }} aria-hidden="true">
              extension
            </span>
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">{COPY.title}</h1>
            <p className="text-xs text-[var(--text-secondary)] truncate">
              {catalog.catalog?.skillCount
                ? COPY.subtitleWithCount(catalog.catalog.skillCount)
                : COPY.subtitleFallback}
            </p>
          </div>
        </div>

        <div className="flex gap-1.5 mb-3" role="tablist" aria-label={COPY.tablistLabel}>
          {(['installed', 'browse'] as const).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`hs-tab-${key}`}
              data-testid={`skill-tab-${key}`}
              aria-selected={tab === key}
              aria-controls="hs-tabpanel"
              onClick={() => selectTab(key)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${FOCUS_RING} ${
                tab === key
                  ? 'bg-[var(--coral-bright)] text-white'
                  : 'bg-[var(--surface-card)] text-[var(--text-secondary)] hover:opacity-90'
              }`}
            >
              {key === 'installed' ? COPY.tabInstalled(installed.counts.total) : COPY.tabBrowse}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-2">
          {/* One row only once there is room for it: the container's @sm is
              384 px, where search beside two selects left the input under
              100 px wide with its placeholder, icon and clear button
              overlapping. The rail took both selects out of this row; what is
              left is the search box, the order, and — only while the rail is
              collapsed — the button that opens it. */}
          <div className="flex flex-col @2xl:flex-row gap-2">
            {browsing ? (
              <SearchInput
                value={catalog.query}
                onChange={catalog.setQuery}
                busy={catalog.loading}
                testId="hs-browse-search"
              />
            ) : (
              <SearchInput value={installedQuery} onChange={setInstalledQuery} testId="hs-installed-search" />
            )}
            <div className="flex items-center gap-2 min-w-0">
              <div className="@2xl:hidden">
                <FacetDrawerButton activeCount={activeCount}>
                  <FacetRail
                    groups={groups}
                    activeCount={activeCount}
                    onClearAll={clearAllFilters}
                    footnotes={railFootnotes}
                    showHeading={false}
                  />
                </FacetDrawerButton>
              </div>
              {browsing && (
                <>
                  <label className="sr-only" htmlFor="hs-sort">
                    {COPY.sortLabel}
                  </label>
                  <select
                    id="hs-sort"
                    value={catalog.sort}
                    onChange={(e) => catalog.setSort(e.target.value as SortOption)}
                    className={`${SELECT_CLS} ${FOCUS_RING} min-w-0 flex-1 @2xl:flex-none @2xl:w-36`}
                  >
                    {SORT_OPTIONS.filter(
                      (s) => s !== 'popular' || catalog.selected.source.includes('browse-sh'),
                    ).map((s) => (
                      <option key={s} value={s}>
                        {COPY.sortOptions[s]}
                      </option>
                    ))}
                  </select>
                </>
              )}
            </div>
          </div>

          <ActiveFilterChips chips={chips} onRemove={removeChip} onClearAll={clearAllFilters} />

          {browsing && (
            <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-[var(--text-secondary)]">
              <span>
                {catalog.degraded
                  ? catalog.results.length > 0
                    ? COPY.degradedCount(catalog.results.length)
                    : ''
                  : catalog.total > 0
                    ? COPY.showingRange(rangeFrom, catalog.results.length, catalog.total)
                    : ''}
              </span>
              {staleWhen && <span>{COPY.catalogStale(staleWhen)}</span>}
            </div>
          )}
        </div>
      </div>

      {/* Body: the rail on the left, the results on the right. The rail is a
          sibling of the scroll container rather than inside it, so it stays put
          while the grid scrolls — and below @2xl it is not rendered here at all,
          because a 224 px column beside a card grid is not a layout a 384 px
          store has room for. It lives in the header's drawer instead. */}
      <div className="flex-1 flex min-h-0 @container">
        <div className="hidden @2xl:block w-56 shrink-0 overflow-y-auto border-r border-[var(--border-subtle)] p-4">
          <FacetRail
            groups={groups}
            activeCount={activeCount}
            onClearAll={clearAllFilters}
            footnotes={railFootnotes}
          />
        </div>
        <div
          id="hs-tabpanel"
          role="tabpanel"
          aria-labelledby={`hs-tab-${tab}`}
          ref={scrollRef}
          className="flex-1 min-w-0 overflow-y-auto p-4 @container"
        >
        {browsing ? (
          <>
            {showFirstRun && (
              <Alert tone="info" icon="hourglass_top">
                {COPY.buildingCatalog}
                <span className="mt-1 block text-[var(--text-secondary)]">{COPY.buildingCatalogAuto}</span>
                <span className="mt-2 block h-1 w-full rounded-full bg-[var(--surface-card)] overflow-hidden">
                  <span className="block h-full w-1/3 bg-[var(--coral-bright)] animate-pulse" />
                </span>
              </Alert>
            )}
            {catalog.loading && catalog.results.length === 0 && (
              <SkillGrid busy>
                {[...Array(8)].map((_, i) => (
                  <CardSkeleton key={i} />
                ))}
              </SkillGrid>
            )}
            {catalog.error && !catalog.loading && (
              // A search the route would not run is the owner's to fix, not the
              // device's: Retry re-sends the same rejected text, so that case
              // gets the search's own icon and the button that empties it.
              <EmptyState
                icon={badQuery || badFilter ? 'search_off' : 'error'}
                tone={badQuery || badFilter ? 'muted' : 'danger'}
                title={COPY.browseError(catalog.error)}
                action={
                  badQuery ? (
                    <PrimaryButton onClick={() => catalog.setQuery('')}>{COPY.clearSearch}</PrimaryButton>
                  ) : badFilter ? (
                    <PrimaryButton onClick={catalog.clearFilters}>{COPY.filtersClearAll}</PrimaryButton>
                  ) : (
                    <PrimaryButton onClick={catalog.reload}>{COPY.retry}</PrimaryButton>
                  )
                }
              />
            )}
            {/* "Nothing here" is a claim about the catalogue, so it may only be
                made once the device HAS one — never while it is still building. */}
            {!catalog.error && !catalog.loading && !catalog.preparing && catalog.results.length === 0 && (
              <EmptyState
                icon="search_off"
                title={
                  q
                    ? COPY.emptySearch(q)
                    : catalog.activeCount > 0
                      ? COPY.emptyFiltered
                      : COPY.emptyCatalog
                }
                hint={catalog.activeCount === 0 ? COPY.emptySearchHint : undefined}
                action={
                  catalog.activeCount > 0 ? (
                    <PrimaryButton onClick={catalog.clearFilters}>{COPY.filtersClearAll}</PrimaryButton>
                  ) : undefined
                }
              />
            )}
            {catalog.results.length > 0 && (
              <SkillGrid busy={catalog.loading}>
                {catalog.results.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onOpen={() => openDetail(skill)}
                    action={renderBrowseAction(skill)}
                  />
                ))}
              </SkillGrid>
            )}
            {catalog.hasMore && (
              <div ref={sentinelRef} className="flex flex-col items-center gap-2 py-6">
                {catalog.appending ? (
                  <span className="text-xs text-[var(--text-secondary)]">{COPY.loadingMore}</span>
                ) : (
                  <GhostButton onClick={catalog.loadMore}>{COPY.loadMore}</GhostButton>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            {installed.loading && installed.skills.length === 0 && (
              <SkillGrid busy>
                {[...Array(6)].map((_, i) => (
                  <CardSkeleton key={i} />
                ))}
              </SkillGrid>
            )}
            {/* A failed read and an empty list are DIFFERENT answers — and a
                failed REFRESH is a third: the list on screen is still the last
                good answer, so it stays and the failure is a banner above it
                rather than an empty state contradicting the grid below. */}
            {installed.error && !installed.loading && installed.skills.length === 0 && (
              <EmptyState
                icon="error"
                tone="danger"
                title={COPY.installedError}
                // No hint: the route used to answer the raw exception here — an
                // absolute device path under a localised header — and now
                // answers one fixed English sentence that says exactly what the
                // localised title above already says. A second line in a
                // language the owner may not read adds nothing.
                action={<PrimaryButton onClick={() => installed.refresh()}>{COPY.retry}</PrimaryButton>}
              />
            )}
            {installed.error && installed.skills.length > 0 && (
              <Alert tone="warn" icon="error">
                <span className="flex items-center gap-3 flex-wrap">
                  {COPY.installedStale}
                  <GhostButton onClick={() => installed.refresh()}>{COPY.retry}</GhostButton>
                </span>
              </Alert>
            )}
            {!installed.error && !installed.loading && installed.skills.length === 0 && (
              <EmptyState
                icon="extension"
                title={COPY.emptyInstalled}
                hint={COPY.emptyInstalledHint}
                action={<PrimaryButton onClick={() => selectTab('browse')}>{COPY.browseSkills}</PrimaryButton>}
              />
            )}
            {!installed.error && installed.skills.length > 0 && installedFiltered.length === 0 && (
              <EmptyState
                icon="search_off"
                title={installedQuery.trim() ? COPY.emptySearch(installedQuery.trim()) : COPY.emptyFiltered}
                action={
                  installedActiveCount > 0 ? (
                    <PrimaryButton onClick={clearInstalledFilters}>{COPY.filtersClearAll}</PrimaryButton>
                  ) : undefined
                }
              />
            )}
            {installedFiltered.length > 0 && (
              <SkillGrid busy={installed.loading}>
                {installedFiltered.map((skill) => (
                  <SkillCard
                    key={skill.id}
                    skill={skill}
                    onOpen={() => openDetail(skill)}
                    action={renderInstalledAction(skill)}
                  />
                ))}
              </SkillGrid>
            )}
          </>
        )}
        </div>
      </div>
    </div>
  );
}

function SearchInput({
  value,
  onChange,
  busy,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  busy?: boolean;
  testId?: string;
}) {
  const COPY = useCopy();
  return (
    <div className="relative flex-1">
      <span
        className="material-symbols-rounded absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-secondary)]"
        style={{ fontSize: 16 }}
        aria-hidden="true"
      >
        search
      </span>
      <input
        type="search"
        placeholder={COPY.searchPlaceholder}
        aria-label={COPY.searchLabel}
        data-testid={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full h-10 pl-9 pr-9 rounded-lg bg-[var(--bg-deep)] border border-[var(--border-subtle)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--coral-bright)] ${FOCUS_RING}`}
      />
      {busy && (
        <span
          className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 border-2 border-[var(--border-subtle)] rounded-full animate-spin"
          style={{ borderTopColor: 'var(--coral-bright)' }}
          role="status"
          aria-label={COPY.searchBusy}
        />
      )}
      {!busy && value && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={COPY.clearSearch}
          className={`absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--surface-card)] transition-colors ${FOCUS_RING}`}
        >
          <span className="material-symbols-rounded" style={{ fontSize: 16 }} aria-hidden="true">
            close
          </span>
        </button>
      )}
    </div>
  );
}
