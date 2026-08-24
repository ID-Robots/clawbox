export const skillsEn: Record<string, string> = {
  // === Header ===
  "skills.title": "Hermes Skills",
  "skills.subtitleWithCount": "{n} skills available for your Hermes agent",
  "skills.subtitleFallback": "Add capabilities to your Hermes agent",

  // === Tabs ===
  "skills.tablistLabel": "Skills view",
  "skills.tabInstalled.withCount": "Installed ({n})",
  "skills.tabInstalled.empty": "Installed",
  "skills.tabBrowse": "Browse",

  // === Search and filters ===
  "skills.searchPlaceholder": "Search skills…",
  "skills.searchLabel": "Search skills",
  "skills.searchBusy": "Loading",
  "skills.clearSearch": "Clear search",
  "skills.sortLabel": "Sort",
  "skills.sortOptions.relevance": "Best match",
  "skills.sortOptions.name": "Name A–Z",
  "skills.sortOptions.trust": "Most trusted",
  "skills.sortOptions.popular": "Most installed",
  "skills.sourceLabel": "Source",
  "skills.allSources": "All sources",
  "skills.providerLabel": "Publisher",
  "skills.allProviders": "All publishers",
  "skills.categoryLabel": "Category",
  "skills.allCategories": "All categories",
  "skills.showingRange": "Showing {from}–{to} of {total}",
  "skills.degradedCount": "Top {n} matches — refine your search to narrow it",
  "skills.loadMore": "Load more",
  "skills.loadingMore": "Loading more skills…",

  // === Scan verdicts ===
  "skills.scanPassed": "Scan passed",
  "skills.scanFlagged.one": "Scan flagged {n} finding",
  "skills.scanFlagged.other": "Scan flagged {n} findings",
  "skills.notScanned": "Not scanned",

  // === Where a skill came from ===
  "skills.originBuiltin": "Built-in",
  "skills.originHub": "Installed",
  "skills.originLocal": "Created here",
  "skills.originLocalHelp": "Written on this device by your agent — not from a registry.",

  // === Actions ===
  "skills.install": "Install",
  "skills.installing": "Installing…",
  "skills.installed": "Installed",
  "skills.remove": "Remove",
  "skills.removing": "Removing…",
  "skills.retry": "Retry",
  "skills.builtinLocked": "Already available (built-in)",
  "skills.cancel": "Cancel",

  // === Install / remove confirmation ===
  "skills.installTitle": "Install {name}?",
  "skills.installTrustedBody": "This skill runs inside your Hermes agent. Hermes scans it before enabling it.",
  "skills.installCommunityBody": "Community-contributed and not reviewed by ID Robots. Check the identifier below matches the publisher you expect.",
  "skills.installWillAsk": "Will ask you for: {labels}",
  "skills.uninstallTitle": "Remove {name}?",
  "skills.uninstallBody.withPath": "This deletes {path} from your agent. You can install it again from Browse.",
  "skills.uninstallBody.generic": "This deletes the skill from your agent. You can install it again from Browse.",

  // === Mutation status (announced in the store's live region) ===
  "skills.liveInstalling": "Installing {name}",
  "skills.liveInstalled": "{name} installed",
  "skills.liveInstallFailed": "Could not install {name}",
  "skills.installFailed": "Install failed",
  "skills.liveRemoving": "Removing {name}",
  "skills.liveRemoved": "{name} removed",
  "skills.liveRemoveFailed": "Could not remove {name}",
  "skills.uninstallFailed": "Uninstall failed",

  // === Empty and error states ===
  "skills.emptySearch": "No skills match “{q}”",
  "skills.emptySearchHint": "Try a different term.",
  "skills.emptySearchAllSources": "Search all sources instead",
  "skills.emptySource": "Nothing in {label} yet",
  "skills.clearSourceFilter": "Clear the {label} filter",
  "skills.emptyInstalled": "No skills installed",
  "skills.emptyInstalledHint": "Browse the registry to add capabilities.",
  "skills.browseSkills": "Browse skills",
  "skills.installedError": "Couldn’t read your installed skills.",
  "skills.installedStale": "Couldn’t refresh this list — showing the last known state.",
  "skills.buildingCatalog": "Building the skill catalogue — the first browse on a new device takes about a minute.",
  "skills.buildingCatalogAuto": "Skills will appear here as soon as it is ready — you can leave this open.",
  "skills.catalogStale": "Catalogue last downloaded {when}.",

  // === Ambiguous identifier ===
  "skills.ambiguousTitle": "{n} skills are named “{q}”. Pick the one you want:",
  "skills.ambiguousPickFirst": "Pick one below to install",

  // === Platform compatibility ===
  "skills.platformWarning": "Requires {platforms} — this skill won’t run on your ClawBox.",
  "skills.platformOnly": "{platforms} only",

  // === Detail sections ===
  "skills.sectionRequirements": "Requirements",
  "skills.sectionGlance": "At a glance",
  "skills.sectionAbout": "About",
  "skills.sectionSecurity": "Security & provenance",
  "skills.sectionRelated": "Related skills",
  "skills.sectionDocs": "Documentation",
  "skills.docsOutline": "In this document",
  "skills.docsSections": "{n} sections",
  "skills.readMore": "Read more",
  "skills.showLess": "Show less",
  "skills.docsFull": "Full SKILL.md",
  "skills.docsPreview": "Documentation preview — the full text is available after install",
  "skills.docsLoading": "Loading documentation…",
  "skills.docsUnavailable": "No documentation available for this skill yet.",

  // === Requirements card ===
  "skills.reqCommands": "Commands",
  "skills.reqCommandPresent": "available on this device",
  "skills.reqCommandMissing": "not installed",
  "skills.reqEnvVars": "Environment variables",
  "skills.reqDependencies": "Packages",
  "skills.reqCredentials": "Credential files",
  "skills.reqCompatibility": "Compatibility",
  "skills.reqSetup": "Setup",
  "skills.reqSecrets": "Will ask you for",
  "skills.reqGetKey": "Get a key",
  "skills.reqSetupGuide": "Setup guide",

  // === Provenance card ===
  "skills.provSource": "Source",
  "skills.provSourceUnverified": "Publisher site (unverified)",
  "skills.provRepo": "Repository",
  "skills.provDetailPage": "Detail page",
  "skills.provHomepage": "Homepage",
  "skills.provInstallCommand": "Install command",
  "skills.provWeeklyInstalls": "Installs",
  "skills.provContentHash": "Content hash",
  "skills.showAllFindings": "Show all {n} findings",
  "skills.copyIdentifier": "Copy identifier",
  "skills.copied": "Copied",

  // === "At a glance" fields and card facts ===
  "skills.fieldVersion": "Version",
  "skills.fieldAuthor": "Author",
  "skills.fieldLicense": "License",
  "skills.fieldCategory": "Category",
  "skills.fieldPlatforms": "Platforms",
  "skills.fieldSize": "Size",
  "skills.fieldIncludes": "Includes",
  "skills.fieldInstalled": "Installed",
  "skills.fieldUpdated": "Updated",
  "skills.fileCount.one": "{n} file",
  "skills.fileCount.other": "{n} files",
  "skills.installedAgo": "Installed {when}",

  // === Navigation ===
  "skills.back": "Back to skills",
  "skills.breadcrumbLabel": "Breadcrumb",
  "skills.breadcrumbBrowse": "Browse",
  "skills.breadcrumbInstalled": "Installed",

  // === Relative dates (hub lock timestamps) ===
  "skills.relative.justNow": "just now",
  "skills.relative.minutes": "{n} min ago",
  "skills.relative.hours": "{n} h ago",
  "skills.relative.days.one": "{n} day ago",
  "skills.relative.days.other": "{n} days ago",
  "skills.relative.months.one": "{n} month ago",
  "skills.relative.months.other": "{n} months ago",
  "skills.relative.years": "{n} y ago",

  // === TASK-452: flagged-skill warning + confirmation ===
  // Krasi's ruling: warn and confirm, never block, at every trust tier.
  "skills.dangerTitle": "Check {name} before installing",
  "skills.dangerLead": "This device scanned the skill and flagged it as “{verdict}”. Installing it is your decision.",
  "skills.dangerSeverity": "The scan raised {critical} critical and {high} high-severity findings.",
  "skills.dangerCanDo": "What this skill can do on your device",
  "skills.dangerNoCapabilities": "The scan did not say which part of the device the skill touches.",
  "skills.dangerOther.one": "And {n} more finding the scan could not categorise.",
  "skills.dangerOther.other": "And {n} more findings the scan could not categorise.",
  "skills.dangerTrustNote": "The publisher’s reputation does not change this: every skill is scanned and every flagged skill is confirmed by you.",
  "skills.dangerShowFindings": "Show the {n} scan findings",
  "skills.dangerUnderstand": "I understand what this skill can do and want to install it anyway.",
  "skills.dangerInstallAnyway": "Install anyway",
  "skills.dangerCancel": "Don’t install",
  "skills.capability.shell": "Run commands on your device",
  "skills.capability.filesystem": "Read, change or delete your files",
  "skills.capability.network": "Send and receive data over the internet",
  "skills.capability.credentials": "Read your saved keys, tokens and passwords",
  "skills.capability.browser": "Control the browser on your device",
  "skills.capability.system": "Change system settings or install software",
  "skills.capability.agentInstructions": "Change the instructions your assistant follows",
  "skills.capability.other": "Something the scan flagged but could not name",

  // === TASK-452: install refusals ===
  "skills.installIncomplete": "The download was incomplete — missing: {files}",
  "skills.installIncompleteHint": "Nothing was installed. Check your internet connection and try again.",
  "skills.nameConflict": "“{name}” already came with this device.",
  "skills.nameConflictHint": "Built-in skills are updated with the device, not from the store.",
  "skills.installRepaired.one": "Completed the download: {n} file the installer had skipped.",
  "skills.installRepaired.other": "Completed the download: {n} files the installer had skipped.",

  // === TASK-452: enabled / disabled ===
  "skills.skillDisabled": "Disabled",
  "skills.skillDisabledHelp": "Installed, but switched off — your assistant will not use it.",
  "skills.countDisabled": "{n} disabled",

  // === TASK-452: API keys a skill needs ===
  "skills.secretSaveLabel": "Enter {label}",
  "skills.secretPlaceholder": "Paste the key here",
  "skills.secretSave": "Save key",
  "skills.secretSaving": "Saving…",
  "skills.secretSaved": "Key saved",
  "skills.secretStored": "Saved on this device",
  "skills.secretClear": "Remove key",
  "skills.secretFailed": "The key could not be saved.",
  "skills.secretHelp": "The key is stored on this device only and is never shown again.",
};
