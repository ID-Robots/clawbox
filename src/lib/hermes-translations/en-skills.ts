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
  "skills.providerLabel": "Publisher",
  "skills.categoryLabel": "Category",
  // === The facet rail: grouped multi-select filters over both tabs ===
  "skills.filtersHeading": "Filters",
  "skills.filtersButton": "Filters",
  "skills.filtersButtonWithCount": "Filters ({n})",
  "skills.filtersClearAll": "Clear all",
  "skills.filtersClose": "Close filters",
  "skills.filtersShowAll": "Show {n} more",
  "skills.filtersShowFewer": "Show fewer",
  "skills.filtersNone": "Nothing to filter on yet.",
  "skills.filterChipRemove": "Remove filter {group}: {value}",
  "skills.facetTrust": "Trust",
  "skills.facetSafety": "Safety",
  "skills.trustBucket.official": "Official",
  "skills.trustBucket.trusted": "Trusted",
  "skills.trustBucket.community": "Community",
  "skills.trustBucket.unknown": "Unknown",
  "skills.safetyBucket.safe": "Scan passed",
  "skills.safetyBucket.caution": "Flagged",
  "skills.safetyBucket.dangerous": "Dangerous",
  "skills.safetyBucket.unscanned": "Not scanned",
  "skills.facetCategoryCoverage": "{n} of {total} say what they are.",
  "skills.facetCountsLoaded": "Counts cover the {n} skills loaded, not the whole catalogue.",
  "skills.facetSafetyBrowseNote": "Safety is checked while a skill installs, so it can only be filtered under Installed.",
  "skills.liveResults.one": "{n} skill matches",
  "skills.liveResults.other": "{n} skills match",
  "skills.liveResults.none": "No skills match",
  "skills.emptyFiltered": "Nothing matches these filters",
  "skills.emptyCatalog": "Nothing here yet",
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

  // === HERMES-04: refusals the routes name by code ===
  // The install/uninstall routes answer every refusal with a machine `code`
  // and an English sentence. The sentence is for the log and the agent; the
  // card reads the code and says it from here, in the owner's language.
  // `{verdict}` and `{trust}` are the scanner's verdict and the source's
  // trust tier, already translated through the rail's bucket labels.
  "skills.installTimeout": "Installing “{name}” took too long and was stopped, so nothing was installed. Some community skills download from a slow source — try again in a moment.",
  "skills.ambiguousId": "More than one skill goes by that name — install it by its full identifier.",
  "skills.alreadyInstalled": "That skill is already installed on this device.",
  "skills.alreadyInstalledFlagged": "“{name}” is already installed, so nothing was changed. Its security scan rated it “{verdict}” — remove it from the Skills store if you no longer want it.",
  "skills.rateLimited": "The skill could not be downloaded: this device has used up its hourly GitHub allowance. Try again in an hour.",
  "skills.downloadFailed": "The skill was found in the store, but none of its sources would serve it.",
  "skills.unresolved": "That skill could not be found — try its full identifier.",
  "skills.blockedByDevice": "The device refused to install “{name}”: its security scan rated it “{verdict}” and its source has the “{trust}” trust level, which the device will not install even when confirmed.",
  "skills.blockedByDeviceUnknownSource": "The device refused to install “{name}”: its security scan rated it “{verdict}”, which the device will not install even when confirmed.",
  "skills.builtinSkill": "“{name}” came with this device, so it cannot be removed.",
  "skills.notInstalled": "No store skill called “{name}” is installed on this device.",
  "skills.uninstallRefused": "The device refused to remove that skill.",
  "skills.ambiguousName": "More than one installed skill answers to \u201c{name}\u201d. Remove it by its own name: {names}.",

  // === HERMES-04: browse failures, by the route's code ===
  // `cli_failed`, `too_large` and `cancelled` share the generic line.
  "skills.browseTimeout": "Loading the skill catalogue took too long. Try again in a moment.",
  "skills.browseUnavailable": "Hermes is not installed on this device, so the skill catalogue cannot be loaded.",
  "skills.browseFailed": "Couldn’t load the skill catalogue. Try again.",
  "skills.browseBadQuery": "That search can’t be used. Try different words.",
  "skills.browseBadFilter": "The device refused one of the filters. Clear the filters and try again.",
  "skills.browseTooManyFilters": "Too many filters at once. Remove a few and try again.",
  "skills.installUnknownOutcome": "The device’s answer was too long to read, so whether “{name}” was installed is not known. Check the Installed tab before trying again.",
  "skills.uninstallUnknownOutcome": "The device’s answer was too long to read, so whether “{name}” was removed is not known. Check the Installed tab before trying again.",
  "skills.detailFailed": "Couldn’t load this skill’s details. Try again.",
  "skills.detailUnavailable": "Hermes is not installed on this device, so this skill’s details cannot be loaded.",
  "skills.detailDocsFailed": "Couldn’t load this skill’s full documentation. The details above come from the device.",

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
