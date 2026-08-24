/**
 * Dutch (Nederlands) — TASK-458.
 *
 * Register follows the shipped ClawBox copy: the user is addressed informally
 * ("je"/"jij"), never "u". Short controls are bare infinitives the way the rest
 * of the app words them ("Opslaan", "Annuleren", "Installeren", "Opnieuw
 * proberen"); whole sentences are full sentences addressed to "je".
 *
 * Terminology reused from the existing nl block (desktop-translations-part3.ts
 * and translations.ts): Instellingen, Opslaan, Annuleren, Doorgaan, Inloggen
 * (sign in), provider (AI-provider), model, skill/skills (left untranslated —
 * that is how the App Store copy already words it), Installeren/Geïnstalleerd/
 * Verwijderen, wachtwoord, apparaat (device) with "de box" kept for the
 * physical box the way wifi.handoffRecover already does, API-sleutel,
 * inloggegevens (credentials), Geheugen, Opnieuw proberen, Gekopieerd.
 *
 * Quotes are the curly “…” pair already used in the nl catalogue; the em dash —,
 * the arrow →, the ellipsis … and trailing punctuation are kept as English has
 * them. Sentence fragments (…Prefix/…Suffix, confirmBodyScope) are worded so
 * the concatenated sentence is grammatical Dutch.
 */
export const nl: Record<string, string> = {
  // === Sidebar sections that had no key at all ===
  "settings.localAi": "Lokale AI",
  "settings.localModels": "Lokale modellen",
  "settings.voice": "Spraak",

  // === System password card ===
  "settings.security.passwordLabel": "Wachtwoord",
  "settings.security.passwordHintPrefix": "Wordt gebruikt voor inloggen op het web, voor SSH en voor",
  "settings.security.passwordHintSuffix": ". Als je het hier wijzigt, verandert het voor alle drie.",
  "settings.security.currentPassword": "Huidig wachtwoord",
  "settings.security.newPassword": "Nieuw wachtwoord",
  "settings.security.newPasswordPlaceholder": "Nieuw wachtwoord (8+ tekens)",
  "settings.security.confirmNewPassword": "Nieuw wachtwoord bevestigen",
  "settings.security.hideCurrentPassword": "Huidig wachtwoord verbergen",
  "settings.security.showCurrentPassword": "Huidig wachtwoord tonen",
  "settings.security.hideNewPassword": "Nieuw wachtwoord verbergen",
  "settings.security.showNewPassword": "Nieuw wachtwoord tonen",
  "settings.security.hideConfirmPassword": "Wachtwoordbevestiging verbergen",
  "settings.security.showConfirmPassword": "Wachtwoordbevestiging tonen",
  "settings.security.clearAndReenter": "Wissen en het huidige wachtwoord opnieuw invoeren",
  "settings.security.reenter": "Opnieuw invoeren",
  "settings.security.checking": "Controleren…",
  "settings.security.verify": "Verifiëren",
  "settings.security.passwordsDontMatchYet": "Wachtwoorden komen nog niet overeen",
  "settings.security.saving": "Opslaan…",
  "settings.security.updatePassword": "Wachtwoord wijzigen",

  // === "Write this password down" confirmation dialog ===
  "settings.security.confirmTitle": "Schrijf dit wachtwoord op",
  "settings.security.confirmBodyPrefix": "Hiermee wijzig je je wachtwoord voor",
  "settings.security.confirmBodyScope": "inloggen op het web, SSH en sudo",
  "settings.security.confirmBodySuffix": ". Als je het vergeet, kun je volledig buitengesloten raken van het apparaat en is een fabrieksreset nodig om er weer bij te komen.",
  "settings.security.hidePassword": "Wachtwoord verbergen",
  "settings.security.revealPassword": "Wachtwoord tonen",
  "settings.security.hide": "Verbergen",
  "settings.security.reveal": "Tonen",
  "settings.security.confirmChange": "Ik heb het opgeschreven — wijzigen",

  // === Validation and status ===
  "settings.security.errorTooShort": "Het nieuwe wachtwoord moet minimaal 8 tekens bevatten",
  "settings.security.errorMismatch": "De nieuwe wachtwoorden komen niet overeen",
  "settings.security.errorSameAsCurrent": "Het nieuwe wachtwoord moet afwijken van het huidige",
  "settings.security.errorInvalidChars": "Het wachtwoord bevat ongeldige tekens",
  "settings.security.verificationFailed": "Verificatie mislukt",
  "settings.security.updateSuccess": "Wachtwoord gewijzigd. Gebruik het nieuwe wachtwoord de volgende keer dat je inlogt of SSH gebruikt.",
  "settings.security.failed": "Mislukt",

  // === Saved Wi-Fi password editor ===
  "settings.security.wifiPasswordLength": "Het wachtwoord moet 8–63 tekens bevatten",
  "settings.security.wifiPasswordUpdated": "Wachtwoord voor {ssid} gewijzigd",

  // === Panel chrome ===
  "hermesProvider.title": "Hermes-modellen",
  "hermesProvider.intro":
    "Dit apparaat draait op Hermes. Kies een inferentieprovider en een standaardmodel — je schakelt ze rechtstreeks via Hermes om, een dashboard is niet nodig.",
  "hermesProvider.radioGroupLabel": "AI-provider",
  "hermesProvider.continue": "Doorgaan",

  // === Provider rows ===
  "hermesProvider.row.desc.openrouter": "300+ modellen met één API-sleutel",
  "hermesProvider.row.desc.anthropic": "Claude — inloggen of een API-sleutel gebruiken",
  "hermesProvider.row.desc.openaiCodex": "Inloggen met OpenAI (Codex)",
  "hermesProvider.row.desc.gemini": "Gemini-modellen, rechtstreeks",
  "hermesProvider.row.desc.zai": "GLM-modellen van Zhipu",
  "hermesProvider.row.desc.kimiCoding": "Moonshot Kimi (voor code)",
  "hermesProvider.row.desc.copilot": "Inloggen met GitHub",
  "hermesProvider.row.desc.nous": "Inloggen met Nous",

  // === ClawBox AI card ===
  "hermesProvider.clawai.activeBadge": "Actief",
  "hermesProvider.clawai.switching": "Overschakelen…",
  "hermesProvider.clawai.switchTo": "Overschakelen naar {tier}",
  "hermesProvider.clawai.inUse": "ClawBox AI is in gebruik",
  "hermesProvider.clawai.modelLabel": "Actief model:",
  "hermesProvider.clawai.finishingSetup": "Installatie op dit apparaat afronden…",
  "hermesProvider.clawai.nowActive": "ClawBox AI is nu je actieve model",
  "hermesProvider.clawai.switchFailed": "Kan niet overschakelen naar ClawBox AI",

  // === Provider sign-in (Hermes-native OAuth) ===
  "hermesProvider.oauth.signInWith": "Inloggen met {provider}",
  "hermesProvider.oauth.connectedDesc": "Verbonden. OAuth-inloggegevens zijn actief.",
  "hermesProvider.oauth.cliOnlyDesc": "Bij deze provider log je in via de Hermes CLI.",
  "hermesProvider.oauth.availableDesc": "OAuth via Hermes (geen API-sleutel nodig).",
  "hermesProvider.oauth.connectedBadge": "Verbonden",
  "hermesProvider.oauth.signIn": "Inloggen",
  "hermesProvider.oauth.tryAgain": "Opnieuw proberen",
  "hermesProvider.oauth.cliInstructions": "Voer dit uit in de terminal van het apparaat en open dit paneel daarna opnieuw:",
  "hermesProvider.oauth.starting": "Inloggen met {provider} starten...",
  "hermesProvider.oauth.pkceInstructions":
    "Er is een tabblad geopend om in te loggen bij {provider}. Keur de toegang daar goed, kopieer de code die je te zien krijgt en plak deze hier.",
  "hermesProvider.oauth.reopenSignInPage": "Inlogpagina opnieuw openen",
  "hermesProvider.oauth.codeLabel": "Plak de code van {provider}",
  "hermesProvider.oauth.submitting": "Versturen...",
  "hermesProvider.oauth.submitCode": "Code versturen",
  "hermesProvider.oauth.startOver": "Opnieuw beginnen",
  "hermesProvider.oauth.deviceInstructions":
    "Voer deze code in op de verificatiepagina van {provider}. Dit paneel werkt zichzelf bij zodra je goedkeuring geeft.",
  "hermesProvider.oauth.copyCode": "Code kopiëren",
  "hermesProvider.oauth.copied": "Gekopieerd",
  "hermesProvider.oauth.openVerificationPage": "Verificatiepagina openen",
  "hermesProvider.oauth.waitingApproval": "Wachten op goedkeuring...",
  "hermesProvider.oauth.orPasteKey": "…of plak hieronder in plaats daarvan een API-sleutel.",
  "hermesProvider.oauth.advancedLabel": "Geavanceerd:",
  "hermesProvider.oauth.dashboardLink": "Hermes-dashboard (alleen via LAN)",

  // === Provider sign-in failures raised by this panel ===
  "hermesProvider.oauth.unexpectedResponse": "Onverwacht antwoord van Hermes",
  "hermesProvider.oauth.startFailed": "Kan het inloggen niet starten",
  "hermesProvider.oauth.codeRejected": "De code is niet geaccepteerd",
  "hermesProvider.oauth.expired": "Het inlogverzoek is verlopen. Probeer het opnieuw.",
  "hermesProvider.oauth.failed": "Inloggen mislukt. Probeer het opnieuw.",

  // === Model picker ===
  "hermesProvider.model.label": "Standaardmodel",
  "hermesProvider.model.loading": "Laden…",
  "hermesProvider.model.noCredentials": "Nog geen inloggegevens voor deze provider",
  "hermesProvider.model.noModels": "Geen modellen beschikbaar",
  "hermesProvider.model.savedElsewherePrefix": "Dit apparaat gebruikt op dit moment",
  "hermesProvider.model.savedElsewhereSuffix": ". Als je opslaat, schakelt het over naar {provider}.",
  "hermesProvider.model.staleColdStart": "Hermes heeft nog geen modellenlijst gepubliceerd — er wordt een minimale reservelijst getoond.",
  "hermesProvider.model.staleCached": "Er wordt een opgeslagen modellenlijst getoond; de actuele catalogus van Hermes is onbereikbaar.",

  // === API key + save ===
  "hermesProvider.key.label": "API-sleutel voor {provider}",
  "hermesProvider.key.placeholder": "Plak een API-sleutel (optioneel als die al is ingesteld)",
  "hermesProvider.save.button": "Model en provider opslaan",
  "hermesProvider.save.saving": "Opslaan…",
  "hermesProvider.save.ok": "Opgeslagen",
  "hermesProvider.save.keySavedOk": "Sleutel opgeslagen — provider en model bijgewerkt",
  "hermesProvider.save.failed": "Opslaan mislukt",
  "hermesProvider.save.keySavedNoCatalog":
    "De sleutel voor {provider} is opgeslagen, maar er is nog geen modellenlijst gepubliceerd — open dit paneel zo meteen opnieuw en kies een model.",
  "hermesProvider.save.noCredentials": "{provider} heeft nog geen inloggegevens — log eerst in of plak een API-sleutel.",
  "hermesProvider.save.catalogUnavailable":
    "De modellenlijst van Hermes is op dit moment onbereikbaar, dus de modellen van {provider} kunnen niet worden gecontroleerd. Probeer het zo meteen opnieuw.",

  // === Header ===
  "skills.title": "Hermes-skills",
  "skills.subtitleWithCount": "{n} skills beschikbaar voor je Hermes-agent",
  "skills.subtitleFallback": "Voeg mogelijkheden toe aan je Hermes-agent",

  // === Tabs ===
  "skills.tablistLabel": "Weergave van skills",
  "skills.tabInstalled.withCount": "Geïnstalleerd ({n})",
  "skills.tabInstalled.empty": "Geïnstalleerd",
  "skills.tabBrowse": "Bladeren",

  // === Search and filters ===
  "skills.searchPlaceholder": "Skills zoeken…",
  "skills.searchLabel": "Zoeken naar skills",
  "skills.searchBusy": "Bezig met laden",
  "skills.clearSearch": "Zoekopdracht wissen",
  "skills.sortLabel": "Sorteren",
  "skills.sortOptions.relevance": "Beste overeenkomst",
  "skills.sortOptions.name": "Naam A–Z",
  "skills.sortOptions.trust": "Meest vertrouwd",
  "skills.sortOptions.popular": "Meest geïnstalleerd",
  "skills.sourceLabel": "Bron",
  "skills.allSources": "Alle bronnen",
  "skills.providerLabel": "Uitgever",
  "skills.allProviders": "Alle uitgevers",
  "skills.categoryLabel": "Categorie",
  "skills.allCategories": "Alle categorieën",
  "skills.showingRange": "{from}–{to} van {total} getoond",
  "skills.degradedCount": "Beste {n} overeenkomsten — verfijn je zoekopdracht om verder te filteren",
  "skills.loadMore": "Meer laden",
  "skills.loadingMore": "Meer skills laden…",

  // === Scan verdicts ===
  "skills.scanPassed": "Scan geslaagd",
  "skills.scanFlagged.one": "Scan meldde {n} bevinding",
  "skills.scanFlagged.other": "Scan meldde {n} bevindingen",
  "skills.notScanned": "Niet gescand",

  // === Where a skill came from ===
  "skills.originBuiltin": "Ingebouwd",
  "skills.originHub": "Geïnstalleerd",
  "skills.originLocal": "Hier gemaakt",
  "skills.originLocalHelp": "Op dit apparaat geschreven door je agent — niet afkomstig uit een register.",

  // === Actions ===
  "skills.install": "Installeren",
  "skills.installing": "Installeren…",
  "skills.installed": "Geïnstalleerd",
  "skills.remove": "Verwijderen",
  "skills.removing": "Verwijderen…",
  "skills.retry": "Opnieuw proberen",
  "skills.builtinLocked": "Al beschikbaar (ingebouwd)",
  "skills.cancel": "Annuleren",

  // === Install / remove confirmation ===
  "skills.installTitle": "{name} installeren?",
  "skills.installTrustedBody": "Deze skill draait in je Hermes-agent. Hermes scant hem voordat hij wordt ingeschakeld.",
  "skills.installCommunityBody": "Bijgedragen door de community en niet gecontroleerd door ID Robots. Controleer of de identifier hieronder overeenkomt met de uitgever die je verwacht.",
  "skills.installWillAsk": "Vraagt je om: {labels}",
  "skills.uninstallTitle": "{name} verwijderen?",
  "skills.uninstallBody.withPath": "Hiermee verwijder je {path} van je agent. Je kunt de skill later opnieuw installeren via “Bladeren”.",
  "skills.uninstallBody.generic": "Hiermee verwijder je de skill van je agent. Je kunt hem later opnieuw installeren via “Bladeren”.",

  // === Mutation status (announced in the store's live region) ===
  "skills.liveInstalling": "{name} installeren",
  "skills.liveInstalled": "{name} is geïnstalleerd",
  "skills.liveInstallFailed": "{name} kon niet worden geïnstalleerd",
  "skills.installFailed": "Installatie mislukt",
  "skills.liveRemoving": "{name} verwijderen",
  "skills.liveRemoved": "{name} is verwijderd",
  "skills.liveRemoveFailed": "{name} kon niet worden verwijderd",
  "skills.uninstallFailed": "Verwijderen mislukt",

  // === Empty and error states ===
  "skills.emptySearch": "Geen skills komen overeen met “{q}”",
  "skills.emptySearchHint": "Probeer een andere zoekterm.",
  "skills.emptySearchAllSources": "In plaats daarvan alle bronnen doorzoeken",
  "skills.emptySource": "Nog niets in {label}",
  "skills.clearSourceFilter": "Het filter {label} wissen",
  "skills.emptyInstalled": "Geen skills geïnstalleerd",
  "skills.emptyInstalledHint": "Blader door het register om mogelijkheden toe te voegen.",
  "skills.browseSkills": "Door skills bladeren",
  "skills.installedError": "Je geïnstalleerde skills konden niet worden gelezen.",
  "skills.installedStale": "Deze lijst kon niet worden vernieuwd — de laatst bekende status wordt getoond.",
  "skills.buildingCatalog": "De skillcatalogus wordt opgebouwd — de eerste keer bladeren duurt op een nieuw apparaat ongeveer een minuut.",
  "skills.buildingCatalogAuto": "Skills verschijnen hier zodra de catalogus klaar is — je kunt dit gerust open laten staan.",
  "skills.catalogStale": "Catalogus voor het laatst gedownload: {when}.",

  // === Ambiguous identifier ===
  "skills.ambiguousTitle": "{n} skills heten “{q}”. Kies degene die je wilt:",
  "skills.ambiguousPickFirst": "Kies er hieronder één om te installeren",

  // === Platform compatibility ===
  "skills.platformWarning": "Vereist {platforms} — deze skill draait niet op je ClawBox.",
  "skills.platformOnly": "Alleen {platforms}",

  // === Detail sections ===
  "skills.sectionRequirements": "Vereisten",
  "skills.sectionGlance": "In het kort",
  "skills.sectionAbout": "Over",
  "skills.sectionSecurity": "Beveiliging en herkomst",
  "skills.sectionRelated": "Verwante skills",
  "skills.sectionDocs": "Documentatie",
  "skills.docsOutline": "In dit document",
  "skills.docsSections": "{n} secties",
  "skills.readMore": "Meer lezen",
  "skills.showLess": "Minder tonen",
  "skills.docsFull": "Volledige SKILL.md",
  "skills.docsPreview": "Voorbeeld van de documentatie — de volledige tekst is beschikbaar na installatie",
  "skills.docsLoading": "Documentatie laden…",
  "skills.docsUnavailable": "Voor deze skill is nog geen documentatie beschikbaar.",

  // === Requirements card ===
  "skills.reqCommands": "Commando's",
  "skills.reqCommandPresent": "beschikbaar op dit apparaat",
  "skills.reqCommandMissing": "niet geïnstalleerd",
  "skills.reqEnvVars": "Omgevingsvariabelen",
  "skills.reqDependencies": "Pakketten",
  "skills.reqCredentials": "Bestanden met inloggegevens",
  "skills.reqCompatibility": "Compatibiliteit",
  "skills.reqSetup": "Instellen",
  "skills.reqSecrets": "Vraagt je om",
  "skills.reqGetKey": "Sleutel ophalen",
  "skills.reqSetupGuide": "Handleiding voor instellen",

  // === Provenance card ===
  "skills.provSource": "Bron",
  "skills.provSourceUnverified": "Site van de uitgever (niet geverifieerd)",
  "skills.provRepo": "Coderepository",
  "skills.provDetailPage": "Detailpagina",
  "skills.provHomepage": "Startpagina",
  "skills.provInstallCommand": "Installatiecommando",
  "skills.provWeeklyInstalls": "Installaties",
  "skills.provContentHash": "Hash van de inhoud",
  "skills.showAllFindings": "Alle {n} bevindingen tonen",
  "skills.copyIdentifier": "Identifier kopiëren",
  "skills.copied": "Gekopieerd",

  // === "At a glance" fields and card facts ===
  "skills.fieldVersion": "Versie",
  "skills.fieldAuthor": "Auteur",
  "skills.fieldLicense": "Licentie",
  "skills.fieldCategory": "Categorie",
  "skills.fieldPlatforms": "Platformen",
  "skills.fieldSize": "Grootte",
  "skills.fieldIncludes": "Bevat",
  "skills.fieldInstalled": "Geïnstalleerd",
  "skills.fieldUpdated": "Bijgewerkt",
  "skills.fileCount.one": "{n} bestand",
  "skills.fileCount.other": "{n} bestanden",
  "skills.installedAgo": "{when} geïnstalleerd",

  // === Navigation ===
  "skills.back": "Terug naar de skills",
  "skills.breadcrumbLabel": "Kruimelpad",
  "skills.breadcrumbBrowse": "Bladeren",
  "skills.breadcrumbInstalled": "Geïnstalleerd",

  // === Relative dates (hub lock timestamps) ===
  "skills.relative.justNow": "zojuist",
  "skills.relative.minutes": "{n} min geleden",
  "skills.relative.hours": "{n} u geleden",
  "skills.relative.days.one": "{n} dag geleden",
  "skills.relative.days.other": "{n} dagen geleden",
  "skills.relative.months.one": "{n} maand geleden",
  "skills.relative.months.other": "{n} maanden geleden",
  "skills.relative.years": "{n} jr geleden",

  // === Kind of model ===
  "localModels.kind.llm": "Taal",
  "localModels.kind.tts": "Spraakuitvoer",
  "localModels.kind.stt": "Spraakinvoer",
  "localModels.kind.embedding": "Geheugen",

  // === Run state ===
  "localModels.run.running": "Actief",
  "localModels.run.idle": "Gestopt",
  "localModels.run.onDemand": "Op aanvraag",
  "localModels.run.notInstalled": "Niet geïnstalleerd",

  // === Panel ===
  "localModels.intro": "Alles wat op de box zelf kan draaien, en wat het op dit moment doet. Alles wat als niet geïnstalleerd wordt getoond, ontbreekt echt — het is geen instelling die je hier kunt aanzetten.",
  "localModels.unavailable": "De status van het volgende kon niet worden gelezen: {list}.",
  "localModels.disk": "Schijf {size}",
  "localModels.memoryInUse": "Geheugen in gebruik {size}",
  "localModels.managedInClawKeep": "Wordt beheerd in ClawKeep.",
  "localModels.managedInLocalAi": "Wordt beheerd in Instellingen → Lokale AI.",
  "localModels.toggleLabel": "{name} ingeschakeld",
  "localModels.footer": "Als je een model uitschakelt, stopt het meteen en blijft het na een herstart uitgeschakeld.",

  // === Errors ===
  "localModels.error.changeFailed": "Kan dat model niet wijzigen.",
  "localModels.error.unreachable": "Kan de box niet bereiken om dat model te wijzigen.",
};
