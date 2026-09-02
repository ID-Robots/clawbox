'use client';

import { useMemo } from 'react';
import { useT } from '@/lib/i18n';

// Every user-facing string of the Hermes Skills store, resolved through `t()`.
//
// WHY one hook: keeping the store's copy in a single object means a component
// still reads `COPY.installTitle(name)` rather than a key literal, so the shape
// the store was written against survives translation — and a new string has
// exactly one place to land. The catalogue lives in
// lib/hermes-translations/en-skills.ts under `skills.*`.
//
// Plurals branch HERE, in TypeScript, with one key per branch: the catalogue is
// a flat string map and encoding plural rules in it would make every translator
// reimplement them.

export function useCopy() {
  const { t } = useT();
  return useMemo(
    () => ({
      title: t('skills.title'),
      subtitleWithCount: (n: number) =>
        t('skills.subtitleWithCount', { n: n.toLocaleString() }),
      subtitleFallback: t('skills.subtitleFallback'),

      tablistLabel: t('skills.tablistLabel'),
      tabInstalled: (n: number) =>
        n > 0 ? t('skills.tabInstalled.withCount', { n }) : t('skills.tabInstalled.empty'),
      tabBrowse: t('skills.tabBrowse'),

      searchPlaceholder: t('skills.searchPlaceholder'),
      searchLabel: t('skills.searchLabel'),
      searchBusy: t('skills.searchBusy'),
      clearSearch: t('skills.clearSearch'),
      sortLabel: t('skills.sortLabel'),
      sortOptions: {
        relevance: t('skills.sortOptions.relevance'),
        name: t('skills.sortOptions.name'),
        trust: t('skills.sortOptions.trust'),
        popular: t('skills.sortOptions.popular'),
      } as const,
      sourceLabel: t('skills.sourceLabel'),
      providerLabel: t('skills.providerLabel'),
      categoryLabel: t('skills.categoryLabel'),

      // === The facet rail ===
      filtersHeading: t('skills.filtersHeading'),
      filtersButton: t('skills.filtersButton'),
      filtersButtonWithCount: (n: number) => t('skills.filtersButtonWithCount', { n }),
      filtersClearAll: t('skills.filtersClearAll'),
      filtersClose: t('skills.filtersClose'),
      filtersShowAll: (n: number) => t('skills.filtersShowAll', { n }),
      filtersShowFewer: t('skills.filtersShowFewer'),
      filtersNone: t('skills.filtersNone'),
      filterChipRemove: (group: string, value: string) =>
        t('skills.filterChipRemove', { group, value }),
      facetTrust: t('skills.facetTrust'),
      facetSafety: t('skills.facetSafety'),
      /** Fixed vocabularies, so an id a newer index invents falls back to itself. */
      trustBucket: (id: string) => trustLabel(t, id),
      safetyBucket: (id: string) => safetyLabel(t, id),
      facetCategoryCoverage: (n: number, total: number) =>
        t('skills.facetCategoryCoverage', { n: n.toLocaleString(), total: total.toLocaleString() }),
      facetCountsLoaded: (n: number) => t('skills.facetCountsLoaded', { n: n.toLocaleString() }),
      facetSafetyBrowseNote: t('skills.facetSafetyBrowseNote'),
      liveResults: (n: number) =>
        n === 1 ? t('skills.liveResults.one', { n }) : t('skills.liveResults.other', { n: n.toLocaleString() }),
      liveResultsNone: t('skills.liveResults.none'),
      showingRange: (from: number, to: number, total: number) =>
        t('skills.showingRange', {
          from: from.toLocaleString(),
          to: to.toLocaleString(),
          total: total.toLocaleString(),
        }),
      degradedCount: (n: number) => t('skills.degradedCount', { n }),
      loadMore: t('skills.loadMore'),
      loadingMore: t('skills.loadingMore'),

      scanPassed: t('skills.scanPassed'),
      scanFlagged: (n: number) =>
        n === 1 ? t('skills.scanFlagged.one', { n }) : t('skills.scanFlagged.other', { n }),
      notScanned: t('skills.notScanned'),

      originBuiltin: t('skills.originBuiltin'),
      originHub: t('skills.originHub'),
      originLocal: t('skills.originLocal'),
      originLocalHelp: t('skills.originLocalHelp'),

      install: t('skills.install'),
      installing: t('skills.installing'),
      installed: t('skills.installed'),
      remove: t('skills.remove'),
      removing: t('skills.removing'),
      retry: t('skills.retry'),
      builtinLocked: t('skills.builtinLocked'),

      installTitle: (name: string) => t('skills.installTitle', { name }),
      installTrustedBody: t('skills.installTrustedBody'),
      installCommunityBody: t('skills.installCommunityBody'),
      installWillAsk: (labels: string[]) => t('skills.installWillAsk', { labels: labels.join(', ') }),
      cancel: t('skills.cancel'),

      uninstallTitle: (name: string) => t('skills.uninstallTitle', { name }),
      uninstallBody: (installPath?: string) =>
        installPath
          ? t('skills.uninstallBody.withPath', { path: installPath })
          : t('skills.uninstallBody.generic'),

      liveInstalling: (name: string) => t('skills.liveInstalling', { name }),
      liveInstalled: (name: string) => t('skills.liveInstalled', { name }),
      liveInstallFailed: (name: string) => t('skills.liveInstallFailed', { name }),
      installFailed: t('skills.installFailed'),
      liveRemoving: (name: string) => t('skills.liveRemoving', { name }),
      liveRemoved: (name: string) => t('skills.liveRemoved', { name }),
      liveRemoveFailed: (name: string) => t('skills.liveRemoveFailed', { name }),
      uninstallFailed: t('skills.uninstallFailed'),

      emptySearch: (q: string) => t('skills.emptySearch', { q }),
      emptySearchHint: t('skills.emptySearchHint'),
      emptyFiltered: t('skills.emptyFiltered'),
      emptyCatalog: t('skills.emptyCatalog'),
      emptyInstalled: t('skills.emptyInstalled'),
      emptyInstalledHint: t('skills.emptyInstalledHint'),
      browseSkills: t('skills.browseSkills'),
      installedError: t('skills.installedError'),
      installedStale: t('skills.installedStale'),
      buildingCatalog: t('skills.buildingCatalog'),
      // The store re-asks on a timer while the index builds, so say so: the earlier
      // wording left people closing and reopening the window to make skills appear.
      buildingCatalogAuto: t('skills.buildingCatalogAuto'),
      // Keyed off when THIS device last downloaded the catalogue. The publisher's
      // own build date never moves on a refetch, so it can't say anything here.
      catalogStale: (when: string) => t('skills.catalogStale', { when }),

      ambiguousTitle: (n: number, q: string) => t('skills.ambiguousTitle', { n, q }),
      ambiguousPickFirst: t('skills.ambiguousPickFirst'),

      platformWarning: (platforms: string[]) =>
        t('skills.platformWarning', { platforms: platforms.map(platformName).join(' or ') }),

      sectionRequirements: t('skills.sectionRequirements'),
      sectionGlance: t('skills.sectionGlance'),
      sectionAbout: t('skills.sectionAbout'),
      sectionSecurity: t('skills.sectionSecurity'),
      sectionRelated: t('skills.sectionRelated'),
      sectionDocs: t('skills.sectionDocs'),
      docsOutline: t('skills.docsOutline'),
      docsSections: (n: number) => t('skills.docsSections', { n }),
      readMore: t('skills.readMore'),
      showLess: t('skills.showLess'),
      docsFull: t('skills.docsFull'),
      docsPreview: t('skills.docsPreview'),
      docsLoading: t('skills.docsLoading'),
      docsUnavailable: t('skills.docsUnavailable'),

      reqCommands: t('skills.reqCommands'),
      reqCommandPresent: t('skills.reqCommandPresent'),
      reqCommandMissing: t('skills.reqCommandMissing'),
      reqEnvVars: t('skills.reqEnvVars'),
      reqDependencies: t('skills.reqDependencies'),
      reqCredentials: t('skills.reqCredentials'),
      reqCompatibility: t('skills.reqCompatibility'),
      reqSetup: t('skills.reqSetup'),
      reqSecrets: t('skills.reqSecrets'),
      reqGetKey: t('skills.reqGetKey'),
      reqSetupGuide: t('skills.reqSetupGuide'),

      provSource: t('skills.provSource'),
      provSourceUnverified: t('skills.provSourceUnverified'),
      provRepo: t('skills.provRepo'),
      provDetailPage: t('skills.provDetailPage'),
      provHomepage: t('skills.provHomepage'),
      provInstallCommand: t('skills.provInstallCommand'),
      provWeeklyInstalls: t('skills.provWeeklyInstalls'),
      provContentHash: t('skills.provContentHash'),
      copyIdentifier: t('skills.copyIdentifier'),
      copied: t('skills.copied'),

      // "At a glance" field labels + the small card facts. They live here, not in
      // the components, so a component never has to name a translation key.
      fieldVersion: t('skills.fieldVersion'),
      fieldAuthor: t('skills.fieldAuthor'),
      fieldLicense: t('skills.fieldLicense'),
      fieldCategory: t('skills.fieldCategory'),
      fieldPlatforms: t('skills.fieldPlatforms'),
      fieldSize: t('skills.fieldSize'),
      fieldIncludes: t('skills.fieldIncludes'),
      fieldInstalled: t('skills.fieldInstalled'),
      fieldUpdated: t('skills.fieldUpdated'),
      fileCount: (n: number) =>
        n === 1 ? t('skills.fileCount.one', { n }) : t('skills.fileCount.other', { n }),
      platformOnly: (platforms: string[]) =>
        t('skills.platformOnly', { platforms: platforms.join(' / ') }),
      installedAgo: (when: string) => t('skills.installedAgo', { when }),
      showAllFindings: (n: number) => t('skills.showAllFindings', { n }),

      // === TASK-452: the flagged-skill warning + confirm ===
      dangerTitle: (name: string) => t('skills.dangerTitle', { name }),
      dangerLead: (verdict: string) => t('skills.dangerLead', { verdict }),
      dangerSeverity: (critical: number, high: number) =>
        t('skills.dangerSeverity', { critical, high }),
      dangerCanDo: t('skills.dangerCanDo'),
      dangerNoCapabilities: t('skills.dangerNoCapabilities'),
      dangerOther: (n: number) =>
        n === 1 ? t('skills.dangerOther.one', { n }) : t('skills.dangerOther.other', { n }),
      dangerTrustNote: t('skills.dangerTrustNote'),
      dangerShowFindings: (n: number) => t('skills.dangerShowFindings', { n }),
      dangerUnderstand: t('skills.dangerUnderstand'),
      dangerInstallAnyway: t('skills.dangerInstallAnyway'),
      dangerCancel: t('skills.dangerCancel'),
      /** Plain-language name for one capability bucket. */
      capability: (id: string) =>
        t(`skills.capability.${CAPABILITY_KEYS.has(id) ? id : 'other'}`),

      // === TASK-452: install refusals ===
      installIncomplete: (files: string[]) =>
        t('skills.installIncomplete', { files: files.slice(0, 5).join(', ') }),
      installIncompleteHint: t('skills.installIncompleteHint'),
      nameConflict: (name: string) => t('skills.nameConflict', { name }),
      nameConflictHint: t('skills.nameConflictHint'),
      installRepaired: (n: number) =>
        n === 1 ? t('skills.installRepaired.one', { n }) : t('skills.installRepaired.other', { n }),

      // === HERMES-04: refusals the routes name by code ===
      // The routes' own `error` sentences are English composed on the server;
      // the card reads the `code` (installRefusalCopy / uninstallRefusalCopy in
      // HermesSkillsStore) and says it from here.
      installTimeout: (name: string) => t('skills.installTimeout', { name }),
      ambiguousId: t('skills.ambiguousId'),
      alreadyInstalled: t('skills.alreadyInstalled'),
      alreadyInstalledFlagged: (name: string, verdict?: string) =>
        t('skills.alreadyInstalledFlagged', { name, verdict: safetyLabel(t, verdict || 'caution') }),
      rateLimited: t('skills.rateLimited'),
      downloadFailed: t('skills.downloadFailed'),
      unresolved: t('skills.unresolved'),
      /**
       * The scanner's verdict and the source's trust tier, as the rail names
       * them. The route sends this code for a "dangerous" verdict and nothing
       * else, so that is what a payload missing the verdict is assumed to say —
       * "caution" would describe a skill the device does install.
       */
      blockedByDevice: (name: string, verdict?: string, trust?: string) =>
        t('skills.blockedByDevice', {
          name,
          verdict: safetyLabel(t, verdict || 'dangerous'),
          trust: trustLabel(t, trust || 'unknown'),
        }),
      builtinSkill: (name: string) => t('skills.builtinSkill', { name }),
      notInstalled: (name: string) => t('skills.notInstalled', { name }),
      uninstallRefused: t('skills.uninstallRefused'),
      /** The browse route's failure code; one it did not name gets the generic line. */
      browseError: (code: string) => t(`skills.${BROWSE_ERROR_KEYS[code] ?? 'browseFailed'}`),

      // === TASK-452: enabled/disabled ===
      skillDisabled: t('skills.skillDisabled'),
      skillDisabledHelp: t('skills.skillDisabledHelp'),
      countDisabled: (n: number) => t('skills.countDisabled', { n }),

      // === TASK-452: API keys ===
      secretSaveLabel: (label: string) => t('skills.secretSaveLabel', { label }),
      secretPlaceholder: t('skills.secretPlaceholder'),
      secretSave: t('skills.secretSave'),
      secretSaving: t('skills.secretSaving'),
      secretSaved: t('skills.secretSaved'),
      secretStored: t('skills.secretStored'),
      secretClear: t('skills.secretClear'),
      secretFailed: t('skills.secretFailed'),
      secretHelp: t('skills.secretHelp'),

      back: t('skills.back'),
      breadcrumbLabel: t('skills.breadcrumbLabel'),
      breadcrumbBrowse: t('skills.breadcrumbBrowse'),
      breadcrumbInstalled: t('skills.breadcrumbInstalled'),

      /** "3 days ago" / "just now" — dates come from the hub lock (ISO-8601). */
      relativeDate: (iso?: string): string | undefined => {
        if (!iso) return undefined;
        const parsed = Date.parse(iso);
        if (Number.isNaN(parsed)) return undefined;
        const seconds = Math.round((Date.now() - parsed) / 1000);
        if (seconds < 60) return t('skills.relative.justNow');
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return t('skills.relative.minutes', { n: minutes });
        const hours = Math.round(minutes / 60);
        if (hours < 24) return t('skills.relative.hours', { n: hours });
        const days = Math.round(hours / 24);
        if (days < 31) {
          return days === 1
            ? t('skills.relative.days.one', { n: days })
            : t('skills.relative.days.other', { n: days });
        }
        const months = Math.round(days / 30);
        if (months < 12) {
          return months === 1
            ? t('skills.relative.months.one', { n: months })
            : t('skills.relative.months.other', { n: months });
        }
        return t('skills.relative.years', { n: Math.round(months / 12) });
      },
    }),
    [t],
  );
}

// The two fixed facet vocabularies, as key sets, for the same reason the
// capability ids below are: a bucket a newer index or scanner invents must fall
// back to its own id rather than render a raw translation key at the customer.
const TRUST_KEYS = new Set(['official', 'trusted', 'community', 'unknown']);
const SAFETY_KEYS = new Set(['safe', 'caution', 'dangerous', 'unscanned']);

type Translate = ReturnType<typeof useT>['t'];

const trustLabel = (t: Translate, id: string) =>
  TRUST_KEYS.has(id) ? t(`skills.trustBucket.${id}`) : id;
const safetyLabel = (t: Translate, id: string) =>
  SAFETY_KEYS.has(id) ? t(`skills.safetyBucket.${id}`) : id;

// The browse route's failure codes that have their own line; `cli_failed`,
// `too_large`, `cancelled` and a code this build does not know share the
// generic one. (`cancelled` is answered only once the client has gone, so no
// card ever shows it — it has no line of its own on purpose.)
const BROWSE_ERROR_KEYS: Record<string, string> = {
  cli_timeout: 'browseTimeout',
  cli_missing: 'browseUnavailable',
};

// The capability ids hermes-skill-capabilities.ts can emit. Kept as a set so a
// bucket a newer scanner introduces falls back to the generic line instead of
// rendering a raw translation key at the customer.
const CAPABILITY_KEYS = new Set([
  'shell',
  'filesystem',
  'network',
  'credentials',
  'browser',
  'system',
  'agentInstructions',
  'other',
]);

/** The copy object every component in the store reads its strings from. */
export type SkillsCopy = ReturnType<typeof useCopy>;

const PLATFORM_NAMES: Record<string, string> = {
  macos: 'macOS',
  darwin: 'macOS',
  windows: 'Windows',
  win32: 'Windows',
  linux: 'Linux',
};

/** Proper nouns, not copy: the same on every locale. */
export function platformName(id: string): string {
  return PLATFORM_NAMES[id.toLowerCase()] || id;
}
