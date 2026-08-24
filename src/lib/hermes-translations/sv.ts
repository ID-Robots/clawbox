/**
 * Swedish (svenska) — TASK-458.
 *
 * Register follows the shipped ClawBox copy: the user is addressed with
 * informal "du" (as everywhere else in this app), short controls are bare
 * imperatives ("Spara", "Avbryt", "Försök igen"), quotes are ”…” and the
 * em dash —, the arrow → and the ellipsis … are kept exactly where English
 * has them.
 *
 * Terminology taken from the existing sv block in desktop-translations-part3,
 * translations.ts and clawkeep-translations: Inställningar, Spara, Avbryt,
 * Logga in, leverantör (provider), modell, installera/avinstallera, lösenord,
 * enhet — and "boxen" for the physical box, which clawkeep sv already uses.
 * "Skill" stays the loanword the app store copy already ships ("Installation
 * av en skill…", "{count} AI-skills"), inflected Swedish: en skill, skillen,
 * skills.
 */
export const sv: Record<string, string> = {
  // === Sidebar sections that had no key at all ===
  "settings.localAi": "Lokal AI",
  "settings.localModels": "Lokala modeller",
  "settings.voice": "Röst",

  // === System password card ===
  "settings.security.passwordLabel": "Lösenord",
  "settings.security.passwordHintPrefix": "Används för webbinloggning, SSH och",
  "settings.security.passwordHintSuffix": ". Ändrar du det här gäller ändringen alla tre.",
  "settings.security.currentPassword": "Nuvarande lösenord",
  "settings.security.newPassword": "Nytt lösenord",
  "settings.security.newPasswordPlaceholder": "Nytt lösenord (minst 8 tecken)",
  "settings.security.confirmNewPassword": "Bekräfta nytt lösenord",
  "settings.security.hideCurrentPassword": "Dölj det nuvarande lösenordet",
  "settings.security.showCurrentPassword": "Visa det nuvarande lösenordet",
  "settings.security.hideNewPassword": "Dölj det nya lösenordet",
  "settings.security.showNewPassword": "Visa det nya lösenordet",
  "settings.security.hideConfirmPassword": "Dölj lösenordsbekräftelsen",
  "settings.security.showConfirmPassword": "Visa lösenordsbekräftelsen",
  "settings.security.clearAndReenter": "Rensa och ange det nuvarande lösenordet igen",
  "settings.security.reenter": "Ange igen",
  "settings.security.checking": "Kontrollerar…",
  "settings.security.verify": "Verifiera",
  "settings.security.passwordsDontMatchYet": "Lösenorden matchar inte än",
  "settings.security.saving": "Sparar…",
  "settings.security.updatePassword": "Uppdatera lösenord",

  // === "Write this password down" confirmation dialog ===
  "settings.security.confirmTitle": "Skriv ner det här lösenordet",
  "settings.security.confirmBodyPrefix": "Det här ändrar ditt lösenord för",
  "settings.security.confirmBodyScope": "webbinloggning, SSH och sudo",
  "settings.security.confirmBodySuffix": ". Om du glömmer det kan du bli helt utelåst från enheten och behöva göra en fabriksåterställning för att komma in igen.",
  "settings.security.hidePassword": "Dölj lösenord",
  "settings.security.revealPassword": "Visa lösenord",
  "settings.security.hide": "Dölj",
  "settings.security.reveal": "Visa",
  "settings.security.confirmChange": "Jag har skrivit ner det — ändra",

  // === Validation and status ===
  "settings.security.errorTooShort": "Det nya lösenordet måste vara minst 8 tecken",
  "settings.security.errorMismatch": "De nya lösenorden matchar inte",
  "settings.security.errorSameAsCurrent": "Det nya lösenordet måste skilja sig från det nuvarande",
  "settings.security.errorInvalidChars": "Lösenordet innehåller ogiltiga tecken",
  "settings.security.verificationFailed": "Verifieringen misslyckades",
  "settings.security.updateSuccess": "Lösenordet har uppdaterats. Använd det nya lösenordet nästa gång du loggar in eller använder SSH.",
  "settings.security.failed": "Misslyckades",

  // === Saved Wi-Fi password editor ===
  "settings.security.wifiPasswordLength": "Lösenordet måste vara 8–63 tecken",
  "settings.security.wifiPasswordUpdated": "Lösenordet för {ssid} har uppdaterats",

  // === Panel chrome ===
  "hermesProvider.title": "Hermes-modeller",
  "hermesProvider.intro":
    "Den här enheten körs på Hermes. Välj en inferensleverantör och en standardmodell — de byts direkt i Hermes, ingen kontrollpanel behövs.",
  "hermesProvider.radioGroupLabel": "AI-leverantör",
  "hermesProvider.continue": "Fortsätt",

  // === Provider rows ===
  "hermesProvider.row.desc.openrouter": "300+ modeller bakom en enda API-nyckel",
  "hermesProvider.row.desc.anthropic": "Claude — logga in eller använd en API-nyckel",
  "hermesProvider.row.desc.openaiCodex": "Logga in med OpenAI (Codex)",
  "hermesProvider.row.desc.gemini": "Gemini-modeller, direkt",
  "hermesProvider.row.desc.zai": "GLM-modeller från Zhipu",
  "hermesProvider.row.desc.kimiCoding": "Moonshot Kimi (kodning)",
  "hermesProvider.row.desc.copilot": "Logga in med GitHub",
  "hermesProvider.row.desc.nous": "Logga in med Nous",

  // === ClawBox AI card ===
  "hermesProvider.clawai.activeBadge": "Aktiv",
  "hermesProvider.clawai.switching": "Växlar…",
  "hermesProvider.clawai.switchTo": "Byt till {tier}",
  "hermesProvider.clawai.inUse": "ClawBox AI används",
  "hermesProvider.clawai.modelLabel": "Modell:",
  "hermesProvider.clawai.finishingSetup": "Slutför konfigurationen på den här enheten…",
  "hermesProvider.clawai.nowActive": "ClawBox AI är nu din aktiva modell",
  "hermesProvider.clawai.switchFailed": "Det gick inte att byta till ClawBox AI",

  // === Provider sign-in (Hermes-native OAuth) ===
  "hermesProvider.oauth.signInWith": "Logga in med {provider}",
  "hermesProvider.oauth.connectedDesc": "Ansluten. OAuth-uppgifterna är aktiva.",
  "hermesProvider.oauth.cliOnlyDesc": "Inloggning hos den här leverantören sker via Hermes CLI.",
  "hermesProvider.oauth.availableDesc": "OAuth via Hermes (ingen API-nyckel behövs).",
  "hermesProvider.oauth.connectedBadge": "Ansluten",
  "hermesProvider.oauth.signIn": "Logga in",
  "hermesProvider.oauth.tryAgain": "Försök igen",
  "hermesProvider.oauth.cliInstructions": "Kör det här i enhetens terminal och öppna sedan den här panelen igen:",
  "hermesProvider.oauth.starting": "Startar inloggning med {provider}...",
  "hermesProvider.oauth.pkceInstructions":
    "En inloggningsflik för {provider} har öppnats. Godkänn åtkomsten där, kopiera koden som visas och klistra in den här.",
  "hermesProvider.oauth.reopenSignInPage": "Öppna inloggningssidan igen",
  "hermesProvider.oauth.codeLabel": "Klistra in koden från {provider}",
  "hermesProvider.oauth.submitting": "Skickar...",
  "hermesProvider.oauth.submitCode": "Skicka kod",
  "hermesProvider.oauth.startOver": "Börja om",
  "hermesProvider.oauth.deviceInstructions":
    "Ange den här koden på verifieringssidan hos {provider}. Panelen uppdateras av sig själv så snart du godkänner.",
  "hermesProvider.oauth.copyCode": "Kopiera kod",
  "hermesProvider.oauth.copied": "Kopierat",
  "hermesProvider.oauth.openVerificationPage": "Öppna verifieringssidan",
  "hermesProvider.oauth.waitingApproval": "Väntar på godkännande...",
  "hermesProvider.oauth.orPasteKey": "…eller klistra in en API-nyckel nedan i stället.",
  "hermesProvider.oauth.advancedLabel": "Avancerat:",
  "hermesProvider.oauth.dashboardLink": "Hermes kontrollpanel (endast LAN)",

  // === Provider sign-in failures raised by this panel ===
  "hermesProvider.oauth.unexpectedResponse": "Oväntat svar från Hermes",
  "hermesProvider.oauth.startFailed": "Inloggningen kunde inte startas",
  "hermesProvider.oauth.codeRejected": "Koden godtogs inte",
  "hermesProvider.oauth.expired": "Inloggningsbegäran har gått ut. Försök igen.",
  "hermesProvider.oauth.failed": "Inloggningen misslyckades. Försök igen.",

  // === Model picker ===
  "hermesProvider.model.label": "Standardmodell",
  "hermesProvider.model.loading": "Laddar…",
  "hermesProvider.model.noCredentials": "Inga inloggningsuppgifter för den här leverantören än",
  "hermesProvider.model.noModels": "Inga modeller tillgängliga",
  "hermesProvider.model.savedElsewherePrefix": "Den här enheten använder just nu",
  "hermesProvider.model.savedElsewhereSuffix": ". Om du sparar byter du till {provider}.",
  "hermesProvider.model.staleColdStart": "Hermes har inte publicerat någon modellista än — en minimal reservlista visas.",
  "hermesProvider.model.staleCached": "En cachad modellista visas; Hermes livekatalog går inte att nå.",

  // === API key + save ===
  "hermesProvider.key.label": "API-nyckel för {provider}",
  "hermesProvider.key.placeholder": "Klistra in API-nyckel (valfritt om den redan är angiven)",
  "hermesProvider.save.button": "Spara modell och leverantör",
  "hermesProvider.save.saving": "Sparar…",
  "hermesProvider.save.ok": "Sparat",
  "hermesProvider.save.keySavedOk": "Nyckeln sparad — leverantör och modell uppdaterade",
  "hermesProvider.save.failed": "Det gick inte att spara",
  "hermesProvider.save.keySavedNoCatalog":
    "Nyckeln för {provider} är sparad, men leverantören har inte publicerat någon modellista än — öppna den här panelen igen om en stund och välj en modell.",
  "hermesProvider.save.noCredentials": "{provider} har inga inloggningsuppgifter än — logga in eller klistra in en API-nyckel först.",
  "hermesProvider.save.catalogUnavailable":
    "Hermes modellista går inte att nå just nu, så modellerna hos {provider} kan inte kontrolleras. Försök igen om en stund.",

  // === Header ===
  "skills.title": "Hermes-skills",
  "skills.subtitleWithCount": "{n} skills tillgängliga för din Hermes-agent",
  "skills.subtitleFallback": "Ge din Hermes-agent fler förmågor",

  // === Tabs ===
  "skills.tablistLabel": "Vy för skills",
  "skills.tabInstalled.withCount": "Installerade ({n})",
  "skills.tabInstalled.empty": "Installerade",
  "skills.tabBrowse": "Bläddra",

  // === Search and filters ===
  "skills.searchPlaceholder": "Sök skills…",
  "skills.searchLabel": "Sök bland skills",
  "skills.searchBusy": "Laddar",
  "skills.clearSearch": "Rensa sökning",
  "skills.sortLabel": "Sortera",
  "skills.sortOptions.relevance": "Bästa träff",
  "skills.sortOptions.name": "Namn A–Ö",
  "skills.sortOptions.trust": "Mest betrodda",
  "skills.sortOptions.popular": "Mest installerade",
  "skills.sourceLabel": "Källa",
  "skills.allSources": "Alla källor",
  "skills.providerLabel": "Utgivare",
  "skills.allProviders": "Alla utgivare",
  "skills.categoryLabel": "Kategori",
  "skills.allCategories": "Alla kategorier",
  "skills.showingRange": "Visar {from}–{to} av {total}",
  "skills.degradedCount": "De {n} bästa träffarna — förfina sökningen för att begränsa resultatet",
  "skills.loadMore": "Ladda fler",
  "skills.loadingMore": "Laddar fler skills…",

  // === Scan verdicts ===
  "skills.scanPassed": "Genomsökningen godkänd",
  "skills.scanFlagged.one": "Genomsökningen flaggade {n} fynd",
  "skills.scanFlagged.other": "Genomsökningen flaggade {n} fynd",
  "skills.notScanned": "Inte genomsökt",

  // === Where a skill came from ===
  "skills.originBuiltin": "Inbyggd",
  "skills.originHub": "Installerad",
  "skills.originLocal": "Skapad här",
  "skills.originLocalHelp": "Skriven på den här enheten av din agent — inte hämtad från något register.",

  // === Actions ===
  "skills.install": "Installera",
  "skills.installing": "Installerar…",
  "skills.installed": "Installerad",
  "skills.remove": "Ta bort",
  "skills.removing": "Tar bort…",
  "skills.retry": "Försök igen",
  "skills.builtinLocked": "Redan tillgänglig (inbyggd)",
  "skills.cancel": "Avbryt",

  // === Install / remove confirmation ===
  "skills.installTitle": "Installera {name}?",
  "skills.installTrustedBody": "Den här skillen körs inuti din Hermes-agent. Hermes genomsöker den innan den aktiveras.",
  "skills.installCommunityBody": "Skapad av communityn och inte granskad av ID Robots. Kontrollera att identifieraren nedan stämmer med den utgivare du förväntar dig.",
  "skills.installWillAsk": "Kommer att be dig om: {labels}",
  "skills.uninstallTitle": "Ta bort {name}?",
  "skills.uninstallBody.withPath": "Det här raderar {path} från din agent. Du kan installera den igen från Bläddra.",
  "skills.uninstallBody.generic": "Det här raderar skillen från din agent. Du kan installera den igen från Bläddra.",

  // === Mutation status (announced in the store's live region) ===
  "skills.liveInstalling": "Installerar {name}",
  "skills.liveInstalled": "{name} har installerats",
  "skills.liveInstallFailed": "Det gick inte att installera {name}",
  "skills.installFailed": "Installationen misslyckades",
  "skills.liveRemoving": "Tar bort {name}",
  "skills.liveRemoved": "{name} har tagits bort",
  "skills.liveRemoveFailed": "Det gick inte att ta bort {name}",
  "skills.uninstallFailed": "Avinstallationen misslyckades",

  // === Empty and error states ===
  "skills.emptySearch": "Inga skills matchar ”{q}”",
  "skills.emptySearchHint": "Prova ett annat sökord.",
  "skills.emptySearchAllSources": "Sök i alla källor i stället",
  "skills.emptySource": "Inget i {label} än",
  "skills.clearSourceFilter": "Rensa filtret för {label}",
  "skills.emptyInstalled": "Inga skills installerade",
  "skills.emptyInstalledHint": "Bläddra i registret för att lägga till förmågor.",
  "skills.browseSkills": "Bläddra bland skills",
  "skills.installedError": "Det gick inte att läsa dina installerade skills.",
  "skills.installedStale": "Listan kunde inte uppdateras — det senast kända läget visas.",
  "skills.buildingCatalog": "Skillkatalogen byggs upp — första gången du bläddrar på en ny enhet tar det ungefär en minut.",
  "skills.buildingCatalogAuto": "Skills visas här så snart katalogen är klar — du kan lämna det här öppet.",
  "skills.catalogStale": "Katalogen hämtades senast {when}.",

  // === Ambiguous identifier ===
  "skills.ambiguousTitle": "{n} skills heter ”{q}”. Välj den du vill ha:",
  "skills.ambiguousPickFirst": "Välj en nedan för att installera den",

  // === Platform compatibility ===
  "skills.platformWarning": "Kräver {platforms} — den här skillen kan inte köras på din ClawBox.",
  "skills.platformOnly": "Endast {platforms}",

  // === Detail sections ===
  "skills.sectionRequirements": "Krav",
  "skills.sectionGlance": "I korthet",
  "skills.sectionAbout": "Om",
  "skills.sectionSecurity": "Säkerhet och ursprung",
  "skills.sectionRelated": "Relaterade skills",
  "skills.sectionDocs": "Dokumentation",
  "skills.docsOutline": "I det här dokumentet",
  "skills.docsSections": "{n} avsnitt",
  "skills.readMore": "Läs mer",
  "skills.showLess": "Visa mindre",
  "skills.docsFull": "Fullständig SKILL.md",
  "skills.docsPreview": "Förhandsvisning av dokumentationen — hela texten finns efter installationen",
  "skills.docsLoading": "Laddar dokumentation…",
  "skills.docsUnavailable": "Det finns ingen dokumentation för den här skillen än.",

  // === Requirements card ===
  "skills.reqCommands": "Kommandon",
  "skills.reqCommandPresent": "finns på den här enheten",
  "skills.reqCommandMissing": "inte installerat",
  "skills.reqEnvVars": "Miljövariabler",
  "skills.reqDependencies": "Paket",
  "skills.reqCredentials": "Filer med inloggningsuppgifter",
  "skills.reqCompatibility": "Kompatibilitet",
  "skills.reqSetup": "Konfiguration",
  "skills.reqSecrets": "Kommer att be dig om",
  "skills.reqGetKey": "Hämta en nyckel",
  "skills.reqSetupGuide": "Konfigurationsguide",

  // === Provenance card ===
  "skills.provSource": "Källa",
  "skills.provSourceUnverified": "Utgivarens webbplats (overifierad)",
  "skills.provRepo": "Kodförråd",
  "skills.provDetailPage": "Detaljsida",
  "skills.provHomepage": "Hemsida",
  "skills.provInstallCommand": "Installationskommando",
  "skills.provWeeklyInstalls": "Installationer",
  "skills.provContentHash": "Innehållshash",
  "skills.showAllFindings": "Visa alla {n} fynd",
  "skills.copyIdentifier": "Kopiera identifieraren",
  "skills.copied": "Kopierat",

  // === "At a glance" fields and card facts ===
  "skills.fieldVersion": "Versionsnummer",
  "skills.fieldAuthor": "Skapare",
  "skills.fieldLicense": "Licens",
  "skills.fieldCategory": "Kategori",
  "skills.fieldPlatforms": "Plattformar",
  "skills.fieldSize": "Storlek",
  "skills.fieldIncludes": "Innehåller",
  "skills.fieldInstalled": "Installerad",
  "skills.fieldUpdated": "Uppdaterad",
  "skills.fileCount.one": "{n} fil",
  "skills.fileCount.other": "{n} filer",
  "skills.installedAgo": "Installerad {when}",

  // === Navigation ===
  "skills.back": "Tillbaka till skills",
  "skills.breadcrumbLabel": "Sökväg",
  "skills.breadcrumbBrowse": "Bläddra",
  "skills.breadcrumbInstalled": "Installerade",

  // === Relative dates (hub lock timestamps) ===
  "skills.relative.justNow": "just nu",
  "skills.relative.minutes": "{n} min sedan",
  "skills.relative.hours": "{n} h sedan",
  "skills.relative.days.one": "{n} dag sedan",
  "skills.relative.days.other": "{n} dagar sedan",
  "skills.relative.months.one": "{n} månad sedan",
  "skills.relative.months.other": "{n} månader sedan",
  "skills.relative.years": "{n} år sedan",

  // === Kind of model ===
  "localModels.kind.llm": "Språk",
  "localModels.kind.tts": "Tal ut",
  "localModels.kind.stt": "Tal in",
  "localModels.kind.embedding": "Minne",

  // === Run state ===
  "localModels.run.running": "Igång",
  "localModels.run.idle": "Stoppad",
  "localModels.run.onDemand": "Vid behov",
  "localModels.run.notInstalled": "Inte installerad",
  "localModels.run.notOnThisEdition": "Inte tillgänglig i den här utgåvan",

  // === Panel ===
  "localModels.intro": "Allt som kan köras på själva boxen, och vad det gör just nu. Det som står som inte installerat saknas verkligen — det är ingen inställning du kan slå på här.",
  "localModels.unavailable": "Det gick inte att läsa läget för: {list}.",
  "localModels.disk": "På disk {size}",
  "localModels.memoryInUse": "Använt minne {size}",
  "localModels.managedInClawKeep": "Hanteras i ClawKeep.",
  "localModels.managedInLocalAi": "Hanteras i Inställningar → Lokal AI.",
  "localModels.toggleLabel": "{name} aktiverad",
  "localModels.footer": "Att stänga av en modell stoppar den direkt och håller den avstängd även efter omstart.",

  // === Errors ===
  "localModels.error.changeFailed": "Det gick inte att ändra den modellen.",
  "localModels.error.unreachable": "Det gick inte att nå boxen för att ändra den modellen.",
};
