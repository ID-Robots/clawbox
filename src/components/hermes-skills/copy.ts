// Every user-facing string of the Hermes Skills store lives here.
//
// WHY one map: the store is not translated yet (the rest of the desktop is, via
// lib/i18n). Keeping the strings in one place means the eventual i18n pass is a
// mechanical swap of this module for `t(...)` calls, instead of a hunt through
// eight components.

export const COPY = {
  title: 'Hermes Skills',
  subtitleWithCount: (n: number) => `${n.toLocaleString()} skills available for your Hermes agent`,
  subtitleFallback: 'Add capabilities to your Hermes agent',

  tabInstalled: (n: number) => (n > 0 ? `Installed (${n})` : 'Installed'),
  tabBrowse: 'Browse',

  searchPlaceholder: 'Search skills…',
  searchLabel: 'Search skills',
  clearSearch: 'Clear search',
  sortLabel: 'Sort',
  sortOptions: {
    relevance: 'Best match',
    name: 'Name A–Z',
    trust: 'Most trusted',
    popular: 'Most installed',
  } as const,
  sourceLabel: 'Source',
  allSources: 'All sources',
  providerLabel: 'Publisher',
  allProviders: 'All publishers',
  categoryLabel: 'Category',
  allCategories: 'All categories',
  showingRange: (from: number, to: number, total: number) =>
    `Showing ${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`,
  degradedCount: (n: number) => `Top ${n} matches — refine your search to narrow it`,
  loadMore: 'Load more',
  loadingMore: 'Loading more skills…',

  scanPassed: 'Scan passed',
  scanFlagged: (n: number) => `Scan flagged ${n} ${n === 1 ? 'finding' : 'findings'}`,
  notScanned: 'Not scanned',

  originBuiltin: 'Built-in',
  originHub: 'Installed',
  originLocal: 'Created here',
  originLocalHelp: 'Written on this device by your agent — not from a registry.',

  install: 'Install',
  installing: 'Installing…',
  installed: 'Installed',
  remove: 'Remove',
  removing: 'Removing…',
  retry: 'Retry',
  builtinLocked: 'Already available (built-in)',

  installTitle: (name: string) => `Install ${name}?`,
  installTrustedBody:
    'This skill runs inside your Hermes agent. Hermes scans it before enabling it.',
  installCommunityBody:
    'Community-contributed and not reviewed by ID Robots. Check the identifier below matches the publisher you expect.',
  installWillAsk: (labels: string[]) => `Will ask you for: ${labels.join(', ')}`,
  cancel: 'Cancel',

  uninstallTitle: (name: string) => `Remove ${name}?`,
  uninstallBody: (installPath?: string) =>
    installPath
      ? `This deletes ${installPath} from your agent. You can install it again from Browse.`
      : 'This deletes the skill from your agent. You can install it again from Browse.',

  emptySearch: (q: string) => `No skills match “${q}”`,
  emptySearchHint: 'Try a different term.',
  emptySearchAllSources: 'Search all sources instead',
  emptySource: (label: string) => `Nothing in ${label} yet`,
  clearSourceFilter: (label: string) => `Clear the ${label} filter`,
  emptyInstalled: 'No skills installed',
  emptyInstalledHint: 'Browse the registry to add capabilities.',
  browseSkills: 'Browse skills',
  installedError: 'Couldn’t read your installed skills.',
  installedStale: 'Couldn’t refresh this list — showing the last known state.',
  buildingCatalog:
    'Building the skill catalogue — the first browse on a new device takes about a minute.',
  // Keyed off when THIS device last downloaded the catalogue. The publisher's
  // own build date never moves on a refetch, so it can't say anything here.
  catalogStale: (when: string) => `Catalogue last downloaded ${when}.`,

  ambiguousTitle: (n: number, q: string) => `${n} skills are named “${q}”. Pick the one you want:`,
  ambiguousPickFirst: 'Pick one below to install',

  platformWarning: (platforms: string[]) =>
    `Requires ${platforms.map(platformName).join(' or ')} — this skill won’t run on your ClawBox.`,

  sectionRequirements: 'Requirements',
  sectionGlance: 'At a glance',
  sectionAbout: 'About',
  sectionSecurity: 'Security & provenance',
  sectionRelated: 'Related skills',
  sectionDocs: 'Documentation',
  docsOutline: 'In this document',
  readMore: 'Read more',
  showLess: 'Show less',
  docsFull: 'Full SKILL.md',
  docsPreview: 'Documentation preview — the full text is available after install',
  docsLoading: 'Loading documentation…',
  docsUnavailable: 'No documentation available for this skill yet.',

  reqCommands: 'Commands',
  reqCommandPresent: 'available on this device',
  reqCommandMissing: 'not installed',
  reqEnvVars: 'Environment variables',
  reqDependencies: 'Packages',
  reqCredentials: 'Credential files',
  reqCompatibility: 'Compatibility',
  reqSetup: 'Setup',
  reqSecrets: 'Will ask you for',
  reqGetKey: 'Get a key',
  reqSetupGuide: 'Setup guide',

  provSource: 'Source',
  provSourceUnverified: 'Publisher site (unverified)',
  provRepo: 'Repository',
  provDetailPage: 'Detail page',
  provHomepage: 'Homepage',
  provInstallCommand: 'Install command',
  provWeeklyInstalls: 'Installs',
  provContentHash: 'Content hash',
  copyIdentifier: 'Copy identifier',
  copied: 'Copied',

  // "At a glance" field labels + the small card facts. They live here, not in
  // the components, so the eventual i18n pass stays the mechanical swap the
  // header comment promises.
  fieldVersion: 'Version',
  fieldAuthor: 'Author',
  fieldLicense: 'License',
  fieldCategory: 'Category',
  fieldPlatforms: 'Platforms',
  fieldSize: 'Size',
  fieldIncludes: 'Includes',
  fieldInstalled: 'Installed',
  fieldUpdated: 'Updated',
  fileCount: (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`,
  platformOnly: (platforms: string[]) => `${platforms.join(' / ')} only`,
  installedAgo: (when: string) => `Installed ${when}`,
  showAllFindings: (n: number) => `Show all ${n} findings`,

  back: 'Back to skills',
  breadcrumbBrowse: 'Browse',
  breadcrumbInstalled: 'Installed',
} as const;

const PLATFORM_NAMES: Record<string, string> = {
  macos: 'macOS',
  darwin: 'macOS',
  windows: 'Windows',
  win32: 'Windows',
  linux: 'Linux',
};

export function platformName(id: string): string {
  return PLATFORM_NAMES[id.toLowerCase()] || id;
}

/** "3 days ago" / "just now" — dates come from the hub lock (ISO-8601). */
export function relativeDate(iso?: string): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const seconds = Math.round((Date.now() - t) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
  return `${Math.round(months / 12)} y ago`;
}
