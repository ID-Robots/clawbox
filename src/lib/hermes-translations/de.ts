/**
 * German (Deutsch) — TASK-458.
 *
 * Register follows the shipped ClawBox Settings copy, which is the surface all
 * four of these panels live in: whole sentences address the user with the
 * formal "Sie" ("Wählen Sie", "Versuchen Sie es erneut"), short controls stay
 * terse and verb-first ("Speichern", "Abbrechen", "Erneut versuchen").
 *
 * Terminology reused from the existing catalogue: Einstellungen, Speichern,
 * Abbrechen, Erneut versuchen, Anmelden (sign in), KI-Anbieter (provider),
 * Modell, API-Schlüssel, Zugangsdaten (credentials), Passwort, Gerät / Box,
 * Installieren / Entfernen. "Skill" stays the loanword the App Store block
 * already ships ("KI-Skills", "Die Installation eines Skills"), compounded
 * German-style: Hermes-Skills, Skill-Katalog.
 *
 * Quotes are „…“; the em dash —, the ellipsis … and the arrow → are kept
 * exactly where the English uses them. Prefix/suffix pairs are re-balanced for
 * German word order: the past participle of the split sentence moves into the
 * suffix (e.g. "Wird für … SSH und" + <sudo> + " verwendet.").
 */
export const de: Record<string, string> = {
  // === Sidebar sections that had no key at all ===
  "settings.localAi": "Lokale KI",
  "settings.localModels": "Lokale Modelle",
  "settings.voice": "Stimme",

  // === System password card ===
  "settings.security.passwordLabel": "Passwort",
  "settings.security.passwordHintPrefix": "Wird für die Web-Anmeldung, SSH und",
  "settings.security.passwordHintSuffix": " verwendet. Wenn Sie es hier ändern, gilt das für alle drei.",
  "settings.security.currentPassword": "Aktuelles Passwort",
  "settings.security.newPassword": "Neues Passwort",
  "settings.security.newPasswordPlaceholder": "Neues Passwort (mind. 8 Zeichen)",
  "settings.security.confirmNewPassword": "Neues Passwort bestätigen",
  "settings.security.hideCurrentPassword": "Aktuelles Passwort verbergen",
  "settings.security.showCurrentPassword": "Aktuelles Passwort anzeigen",
  "settings.security.hideNewPassword": "Neues Passwort verbergen",
  "settings.security.showNewPassword": "Neues Passwort anzeigen",
  "settings.security.hideConfirmPassword": "Passwortbestätigung verbergen",
  "settings.security.showConfirmPassword": "Passwortbestätigung anzeigen",
  "settings.security.clearAndReenter": "Aktuelles Passwort löschen und neu eingeben",
  "settings.security.reenter": "Neu eingeben",
  "settings.security.checking": "Wird geprüft…",
  "settings.security.verify": "Prüfen",
  "settings.security.passwordsDontMatchYet": "Passwörter stimmen noch nicht überein",
  "settings.security.saving": "Wird gespeichert…",
  "settings.security.updatePassword": "Passwort ändern",

  // === "Write this password down" confirmation dialog ===
  "settings.security.confirmTitle": "Schreiben Sie dieses Passwort auf",
  "settings.security.confirmBodyPrefix": "Damit ändern Sie Ihr Passwort für",
  "settings.security.confirmBodyScope": "Web-Anmeldung, SSH und sudo",
  "settings.security.confirmBodySuffix": ". Wenn Sie es vergessen, sperren Sie sich womöglich komplett aus dem Gerät aus und können es nur mit einem Zurücksetzen auf die Werkseinstellungen wiederherstellen.",
  "settings.security.hidePassword": "Passwort verbergen",
  "settings.security.revealPassword": "Passwort anzeigen",
  "settings.security.hide": "Verbergen",
  "settings.security.reveal": "Anzeigen",
  "settings.security.confirmChange": "Ich habe es notiert — ändern",

  // === Validation and status ===
  "settings.security.errorTooShort": "Das neue Passwort muss mindestens 8 Zeichen lang sein",
  "settings.security.errorMismatch": "Die neuen Passwörter stimmen nicht überein",
  "settings.security.errorSameAsCurrent": "Das neue Passwort muss sich vom aktuellen unterscheiden",
  "settings.security.errorInvalidChars": "Das Passwort enthält ungültige Zeichen",
  "settings.security.verificationFailed": "Prüfung fehlgeschlagen",
  "settings.security.updateSuccess": "Passwort geändert. Verwenden Sie das neue Passwort bei der nächsten Anmeldung oder SSH-Verbindung.",
  "settings.security.failed": "Fehlgeschlagen",

  // === Saved Wi-Fi password editor ===
  "settings.security.wifiPasswordLength": "Das Passwort muss 8–63 Zeichen lang sein",
  "settings.security.wifiPasswordUpdated": "Passwort für {ssid} geändert",

  // === Panel chrome ===
  "hermesProvider.title": "Hermes-Modelle",
  "hermesProvider.intro":
    "Dieses Gerät läuft mit Hermes. Wählen Sie einen Inferenz-Anbieter und ein Standardmodell — Hermes wechselt sie direkt, ganz ohne Dashboard.",
  "hermesProvider.radioGroupLabel": "KI-Anbieter",
  "hermesProvider.continue": "Weiter",

  // === Provider rows ===
  "hermesProvider.row.desc.openrouter": "300+ Modelle mit einem API-Schlüssel",
  "hermesProvider.row.desc.anthropic": "Claude — anmelden oder API-Schlüssel nutzen",
  "hermesProvider.row.desc.openaiCodex": "Mit OpenAI (Codex) anmelden",
  "hermesProvider.row.desc.gemini": "Gemini-Modelle, direkt",
  "hermesProvider.row.desc.zai": "GLM-Modelle von Zhipu",
  "hermesProvider.row.desc.kimiCoding": "Moonshot Kimi (Programmieren)",
  "hermesProvider.row.desc.copilot": "Mit GitHub anmelden",
  "hermesProvider.row.desc.nous": "Mit Nous anmelden",

  // === ClawBox AI card ===
  "hermesProvider.clawai.activeBadge": "Aktiv",
  "hermesProvider.clawai.switching": "Wird gewechselt…",
  "hermesProvider.clawai.switchTo": "Zu {tier} wechseln",
  "hermesProvider.clawai.inUse": "ClawBox AI wird verwendet",
  "hermesProvider.clawai.modelLabel": "Modell:",
  "hermesProvider.clawai.finishingSetup": "Einrichtung auf diesem Gerät wird abgeschlossen…",
  "hermesProvider.clawai.nowActive": "ClawBox AI ist jetzt Ihr aktives Modell",
  "hermesProvider.clawai.switchFailed": "Wechsel zu ClawBox AI nicht möglich",

  // === Provider sign-in (Hermes-native OAuth) ===
  "hermesProvider.oauth.signInWith": "Mit {provider} anmelden",
  "hermesProvider.oauth.connectedDesc": "Verbunden. OAuth-Zugangsdaten sind aktiv.",
  "hermesProvider.oauth.cliOnlyDesc": "Bei diesem Anbieter erfolgt die Anmeldung über die Hermes CLI.",
  "hermesProvider.oauth.availableDesc": "OAuth über Hermes (kein API-Schlüssel nötig).",
  "hermesProvider.oauth.connectedBadge": "Verbunden",
  "hermesProvider.oauth.signIn": "Anmelden",
  "hermesProvider.oauth.tryAgain": "Erneut versuchen",
  "hermesProvider.oauth.cliInstructions": "Führen Sie dies im Terminal des Geräts aus und öffnen Sie diesen Bereich danach erneut:",
  "hermesProvider.oauth.starting": "Anmeldung mit {provider} wird gestartet...",
  "hermesProvider.oauth.pkceInstructions":
    "Ein Anmelde-Tab von {provider} wurde geöffnet. Erlauben Sie dort den Zugriff, kopieren Sie den angezeigten Code und fügen Sie ihn hier ein.",
  "hermesProvider.oauth.reopenSignInPage": "Anmeldeseite erneut öffnen",
  "hermesProvider.oauth.codeLabel": "Code von {provider} einfügen",
  "hermesProvider.oauth.submitting": "Wird gesendet...",
  "hermesProvider.oauth.submitCode": "Code senden",
  "hermesProvider.oauth.startOver": "Von vorn beginnen",
  "hermesProvider.oauth.deviceInstructions":
    "Geben Sie diesen Code auf der Bestätigungsseite von {provider} ein. Dieser Bereich aktualisiert sich von selbst, sobald Sie zustimmen.",
  "hermesProvider.oauth.copyCode": "Code kopieren",
  "hermesProvider.oauth.copied": "Kopiert",
  "hermesProvider.oauth.openVerificationPage": "Bestätigungsseite öffnen",
  "hermesProvider.oauth.waitingApproval": "Warte auf Bestätigung...",
  "hermesProvider.oauth.orPasteKey": "…oder fügen Sie stattdessen unten einen API-Schlüssel ein.",
  "hermesProvider.oauth.advancedLabel": "Erweitert:",
  "hermesProvider.oauth.dashboardLink": "Hermes-Dashboard (nur im LAN)",

  // === Provider sign-in failures raised by this panel ===
  "hermesProvider.oauth.unexpectedResponse": "Unerwartete Antwort von Hermes",
  "hermesProvider.oauth.startFailed": "Anmeldung konnte nicht gestartet werden",
  "hermesProvider.oauth.codeRejected": "Der Code wurde nicht akzeptiert",
  "hermesProvider.oauth.expired": "Die Anmeldeanfrage ist abgelaufen. Versuchen Sie es erneut.",
  "hermesProvider.oauth.failed": "Anmeldung fehlgeschlagen. Versuchen Sie es erneut.",

  // === Model picker ===
  "hermesProvider.model.label": "Standardmodell",
  "hermesProvider.model.loading": "Wird geladen…",
  "hermesProvider.model.noCredentials": "Für diesen Anbieter liegen noch keine Zugangsdaten vor",
  "hermesProvider.model.noModels": "Keine Modelle verfügbar",
  "hermesProvider.model.savedElsewherePrefix": "Dieses Gerät verwendet derzeit",
  "hermesProvider.model.savedElsewhereSuffix": ". Beim Speichern wechselt es zu {provider}.",
  "hermesProvider.model.staleColdStart": "Hermes hat noch keine Modellliste veröffentlicht — angezeigt wird eine minimale Ersatzliste.",
  "hermesProvider.model.staleCached": "Angezeigt wird eine zwischengespeicherte Modellliste; der Live-Katalog von Hermes ist nicht erreichbar.",

  // === API key + save ===
  "hermesProvider.key.label": "API-Schlüssel für {provider}",
  "hermesProvider.key.placeholder": "API-Schlüssel einfügen (optional, wenn bereits gesetzt)",
  "hermesProvider.save.button": "Modell & Anbieter speichern",
  "hermesProvider.save.saving": "Wird gespeichert…",
  "hermesProvider.save.ok": "Gespeichert",
  "hermesProvider.save.keySavedOk": "Schlüssel gespeichert — Anbieter & Modell aktualisiert",
  "hermesProvider.save.failed": "Speichern fehlgeschlagen",
  "hermesProvider.save.keySavedNoCatalog":
    "Schlüssel für {provider} gespeichert, aber es wurde noch keine Modellliste veröffentlicht — öffnen Sie diesen Bereich gleich noch einmal und wählen Sie ein Modell.",
  "hermesProvider.save.noCredentials": "Für {provider} liegen noch keine Zugangsdaten vor — melden Sie sich zuerst an oder fügen Sie einen API-Schlüssel ein.",
  "hermesProvider.save.catalogUnavailable":
    "Die Modellliste von Hermes ist gerade nicht erreichbar, daher lassen sich die Modelle von {provider} nicht prüfen. Versuchen Sie es gleich noch einmal.",

  // === Header ===
  "skills.title": "Hermes-Skills",
  "skills.subtitleWithCount": "{n} Skills für Ihren Hermes-Agenten verfügbar",
  "skills.subtitleFallback": "Erweitern Sie Ihren Hermes-Agenten um neue Fähigkeiten",

  // === Tabs ===
  "skills.tablistLabel": "Skill-Ansicht",
  "skills.tabInstalled.withCount": "Installiert ({n})",
  "skills.tabInstalled.empty": "Installiert",
  "skills.tabBrowse": "Entdecken",

  // === Search and filters ===
  "skills.searchPlaceholder": "Skills suchen…",
  "skills.searchLabel": "Skills durchsuchen",
  "skills.searchBusy": "Wird geladen",
  "skills.clearSearch": "Suche löschen",
  "skills.sortLabel": "Sortieren",
  "skills.sortOptions.relevance": "Beste Treffer",
  "skills.sortOptions.name": "Name (A–Z)",
  "skills.sortOptions.trust": "Am vertrauenswürdigsten",
  "skills.sortOptions.popular": "Am häufigsten installiert",
  "skills.sourceLabel": "Quelle",
  "skills.allSources": "Alle Quellen",
  "skills.providerLabel": "Herausgeber",
  "skills.allProviders": "Alle Herausgeber",
  "skills.categoryLabel": "Kategorie",
  "skills.allCategories": "Alle Kategorien",
  "skills.showingRange": "{from}–{to} von {total} werden angezeigt",
  "skills.degradedCount": "Die {n} besten Treffer — grenzen Sie Ihre Suche weiter ein",
  "skills.loadMore": "Mehr laden",
  "skills.loadingMore": "Weitere Skills werden geladen…",

  // === Scan verdicts ===
  "skills.scanPassed": "Prüfung bestanden",
  "skills.scanFlagged.one": "Prüfung meldet {n} Befund",
  "skills.scanFlagged.other": "Prüfung meldet {n} Befunde",
  "skills.notScanned": "Nicht geprüft",

  // === Where a skill came from ===
  "skills.originBuiltin": "Integriert",
  "skills.originHub": "Installiert",
  "skills.originLocal": "Hier erstellt",
  "skills.originLocalHelp": "Von Ihrem Agenten auf diesem Gerät geschrieben — nicht aus einer Registry.",

  // === Actions ===
  "skills.install": "Installieren",
  "skills.installing": "Wird installiert…",
  "skills.installed": "Installiert",
  "skills.remove": "Entfernen",
  "skills.removing": "Wird entfernt…",
  "skills.retry": "Erneut versuchen",
  "skills.builtinLocked": "Bereits verfügbar (integriert)",
  "skills.cancel": "Abbrechen",

  // === Install / remove confirmation ===
  "skills.installTitle": "{name} installieren?",
  "skills.installTrustedBody": "Dieser Skill läuft in Ihrem Hermes-Agenten. Hermes prüft ihn, bevor er ihn aktiviert.",
  "skills.installCommunityBody": "Von der Community beigesteuert und nicht von ID Robots geprüft. Vergewissern Sie sich, dass die Kennung unten zu dem Herausgeber passt, den Sie erwarten.",
  "skills.installWillAsk": "Fragt Sie nach: {labels}",
  "skills.uninstallTitle": "{name} entfernen?",
  "skills.uninstallBody.withPath": "Damit wird {path} aus Ihrem Agenten gelöscht. Sie können den Skill über „Entdecken“ erneut installieren.",
  "skills.uninstallBody.generic": "Damit wird der Skill aus Ihrem Agenten gelöscht. Sie können ihn über „Entdecken“ erneut installieren.",

  // === Mutation status (announced in the store's live region) ===
  "skills.liveInstalling": "{name} wird installiert",
  "skills.liveInstalled": "{name} wurde installiert",
  "skills.liveInstallFailed": "{name} konnte nicht installiert werden",
  "skills.installFailed": "Installation fehlgeschlagen",
  "skills.liveRemoving": "{name} wird entfernt",
  "skills.liveRemoved": "{name} wurde entfernt",
  "skills.liveRemoveFailed": "{name} konnte nicht entfernt werden",
  "skills.uninstallFailed": "Entfernen fehlgeschlagen",

  // === Empty and error states ===
  "skills.emptySearch": "Keine Skills passen zu „{q}“",
  "skills.emptySearchHint": "Versuchen Sie es mit einem anderen Begriff.",
  "skills.emptySearchAllSources": "Stattdessen in allen Quellen suchen",
  "skills.emptySource": "Noch nichts in {label}",
  "skills.clearSourceFilter": "Filter „{label}“ entfernen",
  "skills.emptyInstalled": "Keine Skills installiert",
  "skills.emptyInstalledHint": "Durchsuchen Sie die Registry, um Fähigkeiten hinzuzufügen.",
  "skills.browseSkills": "Skills entdecken",
  "skills.installedError": "Ihre installierten Skills konnten nicht gelesen werden.",
  "skills.installedStale": "Diese Liste konnte nicht aktualisiert werden — angezeigt wird der zuletzt bekannte Stand.",
  "skills.buildingCatalog": "Der Skill-Katalog wird aufgebaut — das erste Stöbern auf einem neuen Gerät dauert etwa eine Minute.",
  "skills.buildingCatalogAuto": "Die Skills erscheinen hier, sobald er fertig ist — Sie können das Fenster offen lassen.",
  "skills.catalogStale": "Katalog zuletzt {when} heruntergeladen.",

  // === Ambiguous identifier ===
  "skills.ambiguousTitle": "{n} Skills tragen den Namen „{q}“. Wählen Sie den gewünschten aus:",
  "skills.ambiguousPickFirst": "Wählen Sie unten einen zum Installieren aus",

  // === Platform compatibility ===
  "skills.platformWarning": "Erfordert {platforms} — dieser Skill läuft nicht auf Ihrer ClawBox.",
  "skills.platformOnly": "Nur {platforms}",

  // === Detail sections ===
  "skills.sectionRequirements": "Voraussetzungen",
  "skills.sectionGlance": "Auf einen Blick",
  "skills.sectionAbout": "Über",
  "skills.sectionSecurity": "Sicherheit & Herkunft",
  "skills.sectionRelated": "Verwandte Skills",
  "skills.sectionDocs": "Dokumentation",
  "skills.docsOutline": "In diesem Dokument",
  "skills.docsSections": "{n} Abschnitte",
  "skills.readMore": "Mehr anzeigen",
  "skills.showLess": "Weniger anzeigen",
  "skills.docsFull": "Vollständige SKILL.md",
  "skills.docsPreview": "Vorschau der Dokumentation — der vollständige Text ist nach der Installation verfügbar",
  "skills.docsLoading": "Dokumentation wird geladen…",
  "skills.docsUnavailable": "Für diesen Skill gibt es noch keine Dokumentation.",

  // === Requirements card ===
  "skills.reqCommands": "Befehle",
  "skills.reqCommandPresent": "auf diesem Gerät verfügbar",
  "skills.reqCommandMissing": "nicht installiert",
  "skills.reqEnvVars": "Umgebungsvariablen",
  "skills.reqDependencies": "Pakete",
  "skills.reqCredentials": "Zugangsdaten-Dateien",
  "skills.reqCompatibility": "Kompatibilität",
  "skills.reqSetup": "Einrichtung",
  "skills.reqSecrets": "Fragt Sie nach",
  "skills.reqGetKey": "Schlüssel holen",
  "skills.reqSetupGuide": "Einrichtungsanleitung",

  // === Provenance card ===
  "skills.provSource": "Quelle",
  "skills.provSourceUnverified": "Website des Herausgebers (ungeprüft)",
  "skills.provRepo": "Code-Repository",
  "skills.provDetailPage": "Detailseite",
  "skills.provHomepage": "Startseite",
  "skills.provInstallCommand": "Installationsbefehl",
  "skills.provWeeklyInstalls": "Installationen",
  "skills.provContentHash": "Inhalts-Hash",
  "skills.showAllFindings": "Alle {n} Befunde anzeigen",
  "skills.copyIdentifier": "Kennung kopieren",
  "skills.copied": "Kopiert",

  // === "At a glance" fields and card facts ===
  "skills.fieldVersion": "Skill-Version",
  "skills.fieldAuthor": "Autor",
  "skills.fieldLicense": "Lizenz",
  "skills.fieldCategory": "Kategorie",
  "skills.fieldPlatforms": "Plattformen",
  "skills.fieldSize": "Größe",
  "skills.fieldIncludes": "Enthält",
  "skills.fieldInstalled": "Installiert",
  "skills.fieldUpdated": "Aktualisiert",
  "skills.fileCount.one": "{n} Datei",
  "skills.fileCount.other": "{n} Dateien",
  "skills.installedAgo": "Installiert {when}",

  // === Navigation ===
  "skills.back": "Zurück zu den Skills",
  "skills.breadcrumbLabel": "Navigationspfad",
  "skills.breadcrumbBrowse": "Entdecken",
  "skills.breadcrumbInstalled": "Installiert",

  // === Relative dates (hub lock timestamps) ===
  "skills.relative.justNow": "gerade eben",
  "skills.relative.minutes": "vor {n} Min.",
  "skills.relative.hours": "vor {n} Std.",
  "skills.relative.days.one": "vor {n} Tag",
  "skills.relative.days.other": "vor {n} Tagen",
  "skills.relative.months.one": "vor {n} Monat",
  "skills.relative.months.other": "vor {n} Monaten",
  "skills.relative.years": "vor {n} J.",

  // === Kind of model ===
  "localModels.kind.llm": "Sprache",
  "localModels.kind.tts": "Sprachausgabe",
  "localModels.kind.stt": "Spracheingabe",
  "localModels.kind.embedding": "Gedächtnis",

  // === Run state ===
  "localModels.run.running": "Läuft",
  "localModels.run.idle": "Gestoppt",
  "localModels.run.onDemand": "Bei Bedarf",
  "localModels.run.notInstalled": "Nicht installiert",
  "localModels.run.notOnThisEdition": "In dieser Edition nicht verfügbar",

  // === Panel ===
  "localModels.intro": "Alles, was auf der Box selbst laufen kann, und was es gerade tut. Was hier als nicht installiert steht, fehlt tatsächlich — es ist keine Einstellung, die Sie hier einschalten können.",
  "localModels.unavailable": "Der Zustand von {list} konnte nicht gelesen werden.",
  "localModels.disk": "Speicherplatz {size}",
  "localModels.memoryInUse": "Belegter Arbeitsspeicher {size}",
  "localModels.managedInClawKeep": "Wird in ClawKeep verwaltet.",
  "localModels.managedInLocalAi": "Wird unter Einstellungen → Lokale KI verwaltet.",
  "localModels.toggleLabel": "{name} aktiviert",
  "localModels.footer": "Wenn Sie ein Modell ausschalten, wird es sofort gestoppt und bleibt auch nach einem Neustart aus.",

  // === Errors ===
  "localModels.error.changeFailed": "Dieses Modell konnte nicht geändert werden.",
  "localModels.error.unreachable": "Die Box ist nicht erreichbar — dieses Modell konnte nicht geändert werden.",
};
