/**
 * Italian (Italiano) — TASK-458.
 *
 * Register follows the shipped ClawBox Italian copy: the user is addressed
 * informally ("tu" — "Assicurati", "il tuo ClawBox", "Riprova"), short controls
 * are the bare imperative ("Salva", "Annulla", "Installa", "Riprova") and whole
 * sentences stay in the same familiar voice.
 *
 * Terminology reused from the existing catalogue: "Impostazioni", "Salva",
 * "Annulla", "Riprova", "Accedi" (sign in), "Provider IA" / "provider",
 * "chiave API", "Modello", "competenza/competenze" (skill — as in
 * `store.confirmMessage` and `store.poweredBy`), "Installa / Installazione… /
 * Installata", "Disinstalla", "dispositivo" (device) with "box" kept only where
 * ClawKeep already says "il box", "password" (invariant), "Editore" for
 * publisher, «guillemets» for quoted user input (as in `files.searchResultsFor`).
 * Skill is feminine in Italian, so its participles agree: "Installata",
 * "Rimossa", "Non scansionata".
 *
 * Notes on individual strings:
 * - "Password" alone is identical in Italian, so the card label is rendered as
 *   "Password di sistema", matching `credentials.systemPassword`.
 * - "{n} file" is invariant in Italian; the file-count chip is therefore worded
 *   "{n} file incluso/inclusi", which reads naturally both as a chip and inside
 *   the "Dimensione" field ("3 file inclusi · 12 KB").
 * - The Prefix/Suffix pairs are worded so the concatenated sentence is
 *   grammatical: "Usata per l'accesso web, per SSH e per" + `sudo` + ". Se
 *   l'aggiorni qui, cambia per tutti e tre.", "Cambierai la password per" +
 *   "l'accesso web, SSH e sudo" + ". Se la dimentichi, …", and "Al momento
 *   questo dispositivo sta usando" + provider + ". Se salvi, passerà a
 *   {provider}." — the gerund ("Salvando passerà…") was dropped because its
 *   implicit subject is the reader, not the device.
 */
export const it: Record<string, string> = {
  // === Sidebar sections that had no key at all ===
  "settings.localAi": "IA locale",
  "settings.localModels": "Modelli locali",
  "settings.voice": "Voce",

  // === System password card ===
  "settings.security.passwordLabel": "Password di sistema",
  "settings.security.passwordHintPrefix": "Usata per l'accesso web, per SSH e per",
  "settings.security.passwordHintSuffix": ". Se l'aggiorni qui, cambia per tutti e tre.",
  "settings.security.currentPassword": "Password attuale",
  "settings.security.newPassword": "Nuova password",
  "settings.security.newPasswordPlaceholder": "Nuova password (8+ caratteri)",
  "settings.security.confirmNewPassword": "Conferma la nuova password",
  "settings.security.hideCurrentPassword": "Nascondi la password attuale",
  "settings.security.showCurrentPassword": "Mostra la password attuale",
  "settings.security.hideNewPassword": "Nascondi la nuova password",
  "settings.security.showNewPassword": "Mostra la nuova password",
  "settings.security.hideConfirmPassword": "Nascondi la password di conferma",
  "settings.security.showConfirmPassword": "Mostra la password di conferma",
  "settings.security.clearAndReenter": "Cancella e reinserisci la password attuale",
  "settings.security.reenter": "Reinserisci",
  "settings.security.checking": "Verifica…",
  "settings.security.verify": "Verifica",
  "settings.security.passwordsDontMatchYet": "Le password non corrispondono ancora",
  "settings.security.saving": "Salvataggio…",
  "settings.security.updatePassword": "Aggiorna la password",

  // === "Write this password down" confirmation dialog ===
  "settings.security.confirmTitle": "Annota questa password",
  "settings.security.confirmBodyPrefix": "Cambierai la password per",
  "settings.security.confirmBodyScope": "l'accesso web, SSH e sudo",
  "settings.security.confirmBodySuffix": ". Se la dimentichi, potresti perdere del tutto l'accesso al dispositivo e servirà un ripristino di fabbrica per riaverlo.",
  "settings.security.hidePassword": "Nascondi la password",
  "settings.security.revealPassword": "Mostra la password",
  "settings.security.hide": "Nascondi",
  "settings.security.reveal": "Mostra",
  "settings.security.confirmChange": "L'ho annotata — cambia",

  // === Validation and status ===
  "settings.security.errorTooShort": "La nuova password deve avere almeno 8 caratteri",
  "settings.security.errorMismatch": "Le nuove password non corrispondono",
  "settings.security.errorSameAsCurrent": "La nuova password deve essere diversa da quella attuale",
  "settings.security.errorInvalidChars": "La password contiene caratteri non validi",
  "settings.security.verificationFailed": "Verifica non riuscita",
  "settings.security.updateSuccess": "Password aggiornata. Usa la nuova password al prossimo accesso o via SSH.",
  "settings.security.failed": "Operazione non riuscita",

  // === Saved Wi-Fi password editor ===
  "settings.security.wifiPasswordLength": "La password deve avere da 8 a 63 caratteri",
  "settings.security.wifiPasswordUpdated": "Password aggiornata per {ssid}",

  // === Panel chrome ===
  "hermesProvider.title": "Provider IA",
  "hermesProvider.intro":
    "Questo dispositivo funziona con Hermes. Collega i provider e scegli quello predefinito: stato, accesso e cambio sono tutti qui.",
  "hermesProvider.radioGroupLabel": "Provider IA",
  "hermesProvider.hero.nativeSwitch": "cambia in modo nativo tramite Hermes",
  "hermesProvider.hero.changeModel": "Cambia modello",
  "hermesProvider.continue": "Continua",
  "hermesProvider.connected.affirmation": "Connesso",

  // === Provider rows ===
  "hermesProvider.row.desc.openrouter": "300+ modelli con un'unica chiave API",
  "hermesProvider.row.desc.anthropic": "Claude — accedi o usa una chiave API",
  "hermesProvider.row.desc.openaiCodex": "Accedi con OpenAI (Codex)",
  "hermesProvider.row.desc.gemini": "Modelli Gemini, senza intermediari",
  "hermesProvider.row.desc.zai": "Modelli GLM di Zhipu",
  "hermesProvider.row.desc.kimiCoding": "Moonshot Kimi (per il codice)",
  "hermesProvider.row.desc.copilot": "Accedi con GitHub",
  "hermesProvider.row.desc.nous": "Accedi con Nous",

  // === ClawBox AI card ===
  "hermesProvider.clawai.activeBadge": "Attivo",
  "hermesProvider.clawai.switching": "Cambio in corso…",
  "hermesProvider.clawai.switchTo": "Passa a {tier}",
  "hermesProvider.clawai.inUse": "ClawBox AI in uso",
  "hermesProvider.clawai.modelLabel": "Modello:",
  "hermesProvider.clawai.finishingSetup": "Completamento della configurazione su questo dispositivo…",
  "hermesProvider.clawai.nowActive": "ClawBox AI è ora il tuo modello attivo",
  "hermesProvider.clawai.switchFailed": "Non è stato possibile passare a ClawBox AI",

  // === Provider sign-in (Hermes-native OAuth) ===
  "hermesProvider.oauth.signInWith": "Accedi con {provider}",
  "hermesProvider.oauth.connectedDesc": "Connesso. Credenziali OAuth attive.",
  "hermesProvider.oauth.cliOnlyDesc": "Con questo provider l'accesso avviene tramite Hermes CLI.",
  "hermesProvider.oauth.availableDesc": "OAuth tramite Hermes (non serve alcuna chiave API).",
  "hermesProvider.oauth.connectedBadge": "Connesso",
  "hermesProvider.oauth.signIn": "Accedi",
  "hermesProvider.oauth.tryAgain": "Riprova",
  "hermesProvider.oauth.cliInstructions": "Esegui questo comando nel terminale del dispositivo, poi riapri questo pannello:",
  "hermesProvider.oauth.starting": "Avvio dell'accesso con {provider}...",
  "hermesProvider.oauth.pkceInstructions":
    "Si è aperta una scheda di accesso a {provider}. Autorizza l'accesso lì, copia il codice che compare e incollalo qui.",
  "hermesProvider.oauth.reopenSignInPage": "Riapri la pagina di accesso",
  "hermesProvider.oauth.codeLabel": "Incolla il codice ricevuto da {provider}",
  "hermesProvider.oauth.submitting": "Invio...",
  "hermesProvider.oauth.submitCode": "Invia il codice",
  "hermesProvider.oauth.startOver": "Ricomincia",
  "hermesProvider.oauth.deviceInstructions":
    "Inserisci questo codice nella pagina di verifica di {provider}. Questo pannello si aggiorna da solo appena approvi.",
  "hermesProvider.oauth.copyCode": "Copia codice",
  "hermesProvider.oauth.copied": "Copiato",
  "hermesProvider.oauth.openVerificationPage": "Apri la pagina di verifica",
  "hermesProvider.oauth.waitingApproval": "In attesa dell'approvazione...",
  "hermesProvider.oauth.orPasteKey": "…oppure incolla qui sotto una chiave API.",
  "hermesProvider.oauth.advancedLabel": "Avanzate:",
  "hermesProvider.oauth.dashboardLink": "Dashboard di Hermes (solo in LAN)",

  // === Provider sign-in failures raised by this panel ===
  "hermesProvider.oauth.unexpectedResponse": "Risposta inattesa da Hermes",
  "hermesProvider.oauth.startFailed": "Non è stato possibile avviare l'accesso",
  "hermesProvider.oauth.codeRejected": "Il codice non è stato accettato",
  "hermesProvider.oauth.expired": "La richiesta di accesso è scaduta. Riprova.",
  "hermesProvider.oauth.failed": "Accesso non riuscito. Riprova.",

  // === Model picker ===
  "hermesProvider.model.label": "Modello predefinito",
  "hermesProvider.model.loading": "Caricamento…",
  "hermesProvider.model.noCredentials": "Ancora nessuna credenziale per questo provider",
  "hermesProvider.model.noModels": "Nessun modello disponibile",
  "hermesProvider.model.savedElsewherePrefix": "Al momento questo dispositivo sta usando",
  "hermesProvider.model.savedElsewhereSuffix": ". Se salvi, passerà a {provider}.",
  "hermesProvider.model.staleColdStart": "Hermes non ha ancora pubblicato un elenco di modelli — viene mostrato un elenco minimo di riserva.",
  "hermesProvider.model.staleCached": "Viene mostrato un elenco di modelli dalla cache; il catalogo aggiornato di Hermes non è raggiungibile.",

  // === API key + save ===
  "hermesProvider.key.label": "Chiave API di {provider}",
  "hermesProvider.key.placeholder": "Incolla la chiave API (facoltativa se già impostata)",
  "hermesProvider.save.button": "Salva modello e provider",
  "hermesProvider.save.saving": "Salvataggio…",
  "hermesProvider.save.ok": "Salvato",
  "hermesProvider.save.keySavedOk": "Chiave salvata — provider e modello aggiornati",
  "hermesProvider.save.failed": "Salvataggio non riuscito",
  "hermesProvider.save.keySavedNoCatalog":
    "Chiave salvata per {provider}, ma non ha ancora pubblicato un elenco di modelli — riapri questo pannello tra un momento e scegli un modello.",
  "hermesProvider.save.noCredentials": "{provider} non ha ancora credenziali — accedi o incolla prima una chiave API.",
  "hermesProvider.save.catalogUnavailable":
    "L'elenco dei modelli di Hermes non è raggiungibile in questo momento, quindi i modelli di {provider} non possono essere verificati. Riprova tra un momento.",

  // === Header ===
  "skills.title": "Competenze Hermes",
  "skills.subtitleWithCount": "{n} competenze disponibili per il tuo agente Hermes",
  "skills.subtitleFallback": "Aggiungi funzionalità al tuo agente Hermes",

  // === Tabs ===
  "skills.tablistLabel": "Vista delle competenze",
  "skills.tabInstalled.withCount": "Installate ({n})",
  "skills.tabInstalled.empty": "Installate",
  "skills.tabBrowse": "Esplora",

  // === Search and filters ===
  "skills.searchPlaceholder": "Cerca competenze…",
  "skills.searchLabel": "Cerca tra le competenze",
  "skills.searchBusy": "Caricamento",
  "skills.clearSearch": "Cancella ricerca",
  "skills.sortLabel": "Ordina",
  "skills.sortOptions.relevance": "Più pertinenti",
  "skills.sortOptions.name": "Nome A–Z",
  "skills.sortOptions.trust": "Più affidabili",
  "skills.sortOptions.popular": "Più installate",
  "skills.sourceLabel": "Fonte",
  "skills.allSources": "Tutte le fonti",
  "skills.providerLabel": "Editore",
  "skills.allProviders": "Tutti gli editori",
  "skills.categoryLabel": "Categoria",
  "skills.allCategories": "Tutte le categorie",
  "skills.showingRange": "Visualizzate {from}–{to} di {total}",
  "skills.degradedCount": "Prime {n} corrispondenze — affina la ricerca per restringerle",
  "skills.loadMore": "Carica altre",
  "skills.loadingMore": "Caricamento di altre competenze…",

  // === Scan verdicts ===
  "skills.scanPassed": "Scansione superata",
  "skills.scanFlagged.one": "La scansione ha segnalato {n} problema",
  "skills.scanFlagged.other": "La scansione ha segnalato {n} problemi",
  "skills.notScanned": "Non scansionata",

  // === Where a skill came from ===
  "skills.originBuiltin": "Integrata",
  "skills.originHub": "Installata",
  "skills.originLocal": "Creata qui",
  "skills.originLocalHelp": "Scritta su questo dispositivo dal tuo agente — non arriva da un registro.",

  // === Actions ===
  "skills.install": "Installa",
  "skills.installing": "Installazione…",
  "skills.installed": "Installata",
  "skills.remove": "Rimuovi",
  "skills.removing": "Rimozione…",
  "skills.retry": "Riprova",
  "skills.builtinLocked": "Già disponibile (integrata)",
  "skills.cancel": "Annulla",

  // === Install / remove confirmation ===
  "skills.installTitle": "Installare {name}?",
  "skills.installTrustedBody": "Questa competenza viene eseguita all'interno del tuo agente Hermes. Hermes la analizza prima di attivarla.",
  "skills.installCommunityBody": "Contributo della community, non verificato da ID Robots. Controlla che l'identificatore qui sotto corrisponda all'editore che ti aspetti.",
  "skills.installWillAsk": "Ti chiederà: {labels}",
  "skills.uninstallTitle": "Rimuovere {name}?",
  "skills.uninstallBody.withPath": "Questa azione elimina {path} dal tuo agente. Puoi installarla di nuovo da «Esplora».",
  "skills.uninstallBody.generic": "Questa azione elimina la competenza dal tuo agente. Puoi installarla di nuovo da «Esplora».",

  // === Mutation status (announced in the store's live region) ===
  "skills.liveInstalling": "Installazione di {name} in corso",
  "skills.liveInstalled": "{name} è stata installata",
  "skills.liveInstallFailed": "Non è stato possibile installare {name}",
  "skills.installFailed": "Installazione non riuscita",
  "skills.liveRemoving": "Rimozione di {name} in corso",
  "skills.liveRemoved": "{name} è stata rimossa",
  "skills.liveRemoveFailed": "Non è stato possibile rimuovere {name}",
  "skills.uninstallFailed": "Disinstallazione non riuscita",

  // === Empty and error states ===
  "skills.emptySearch": "Nessuna competenza corrisponde a «{q}»",
  "skills.emptySearchHint": "Prova con un altro termine.",
  "skills.emptySearchAllSources": "Cerca invece in tutte le fonti",
  "skills.emptySource": "Ancora niente in {label}",
  "skills.clearSourceFilter": "Rimuovi il filtro {label}",
  "skills.emptyInstalled": "Nessuna competenza installata",
  "skills.emptyInstalledHint": "Esplora il registro per aggiungere funzionalità.",
  "skills.browseSkills": "Esplora le competenze",
  "skills.installedError": "Non è stato possibile leggere le competenze installate.",
  "skills.installedStale": "Non è stato possibile aggiornare questo elenco — viene mostrato l'ultimo stato noto.",
  "skills.buildingCatalog": "Creazione del catalogo delle competenze — la prima esplorazione su un dispositivo nuovo richiede circa un minuto.",
  "skills.buildingCatalogAuto": "Le competenze compariranno qui appena il catalogo sarà pronto — puoi lasciare questa finestra aperta.",
  "skills.catalogStale": "Catalogo scaricato l'ultima volta {when}.",

  // === Ambiguous identifier ===
  "skills.ambiguousTitle": "{n} competenze si chiamano «{q}». Scegli quella che ti serve:",
  "skills.ambiguousPickFirst": "Scegline una qui sotto da installare",

  // === Platform compatibility ===
  "skills.platformWarning": "Richiede {platforms} — questa competenza non funzionerà sul tuo ClawBox.",
  "skills.platformOnly": "Solo {platforms}",

  // === Detail sections ===
  "skills.sectionRequirements": "Requisiti",
  "skills.sectionGlance": "In breve",
  "skills.sectionAbout": "Informazioni",
  "skills.sectionSecurity": "Sicurezza e provenienza",
  "skills.sectionRelated": "Competenze correlate",
  "skills.sectionDocs": "Documentazione",
  "skills.docsOutline": "In questo documento",
  "skills.docsSections": "{n} sezioni",
  "skills.readMore": "Leggi di più",
  "skills.showLess": "Mostra meno",
  "skills.docsFull": "SKILL.md completo",
  "skills.docsPreview": "Anteprima della documentazione — il testo completo è disponibile dopo l'installazione",
  "skills.docsLoading": "Caricamento della documentazione…",
  "skills.docsUnavailable": "Per questa competenza non c'è ancora documentazione.",

  // === Requirements card ===
  "skills.reqCommands": "Comandi",
  "skills.reqCommandPresent": "disponibile su questo dispositivo",
  "skills.reqCommandMissing": "non installato",
  "skills.reqEnvVars": "Variabili d'ambiente",
  "skills.reqDependencies": "Pacchetti",
  "skills.reqCredentials": "File delle credenziali",
  "skills.reqCompatibility": "Compatibilità",
  "skills.reqSetup": "Configurazione",
  "skills.reqSecrets": "Ti chiederà",
  "skills.reqGetKey": "Ottieni una chiave",
  "skills.reqSetupGuide": "Guida alla configurazione",

  // === Provenance card ===
  "skills.provSource": "Fonte",
  "skills.provSourceUnverified": "Sito dell'editore (non verificato)",
  "skills.provRepo": "Repository del codice",
  "skills.provDetailPage": "Pagina dei dettagli",
  "skills.provHomepage": "Pagina iniziale",
  "skills.provInstallCommand": "Comando di installazione",
  "skills.provWeeklyInstalls": "Installazioni",
  "skills.provContentHash": "Hash del contenuto",
  "skills.showAllFindings": "Mostra tutti i {n} problemi",
  "skills.copyIdentifier": "Copia identificatore",
  "skills.copied": "Copiato",

  // === "At a glance" fields and card facts ===
  "skills.fieldVersion": "Versione",
  "skills.fieldAuthor": "Autore",
  "skills.fieldLicense": "Licenza",
  "skills.fieldCategory": "Categoria",
  "skills.fieldPlatforms": "Piattaforme",
  "skills.fieldSize": "Dimensione",
  "skills.fieldIncludes": "Include",
  "skills.fieldInstalled": "Installata",
  "skills.fieldUpdated": "Aggiornata",
  "skills.fileCount.one": "{n} file incluso",
  "skills.fileCount.other": "{n} file inclusi",
  "skills.installedAgo": "Installata {when}",

  // === Navigation ===
  "skills.back": "Torna alle competenze",
  "skills.breadcrumbLabel": "Percorso di navigazione",
  "skills.breadcrumbBrowse": "Esplora",
  "skills.breadcrumbInstalled": "Installate",

  // === Relative dates (hub lock timestamps) ===
  "skills.relative.justNow": "proprio ora",
  "skills.relative.minutes": "{n} min fa",
  "skills.relative.hours": "{n} h fa",
  "skills.relative.days.one": "{n} giorno fa",
  "skills.relative.days.other": "{n} giorni fa",
  "skills.relative.months.one": "{n} mese fa",
  "skills.relative.months.other": "{n} mesi fa",
  "skills.relative.years": "{n} anni fa",

  // === Kind of model ===
  "localModels.kind.llm": "Linguaggio",
  "localModels.kind.tts": "Voce in uscita",
  "localModels.kind.stt": "Voce in entrata",
  "localModels.kind.embedding": "Memoria",

  // === Run state ===
  "localModels.run.running": "In esecuzione",
  "localModels.run.idle": "Fermo",
  "localModels.run.onDemand": "Su richiesta",
  "localModels.run.notInstalled": "Non installato",
  "localModels.run.notOnThisEdition": "Non disponibile in questa edizione",

  // === Panel ===
  "localModels.intro": "Tutto ciò che può funzionare sul box stesso e che cosa sta facendo in questo momento. Ciò che risulta non installato manca davvero — non è un'impostazione che puoi attivare da qui.",
  "localModels.unavailable": "Non è stato possibile leggere lo stato di: {list}.",
  "localModels.disk": "Disco {size}",
  "localModels.memoryInUse": "Memoria in uso {size}",
  "localModels.managedInClawKeep": "Si gestisce in ClawKeep.",
  "localModels.managedInLocalAi": "Si gestisce in Impostazioni → IA locale.",
  "localModels.toggleLabel": "{name} abilitato",
  "localModels.footer": "Disattivare un modello lo ferma subito e lo mantiene spento anche dopo un riavvio.",

  // === Errors ===
  "localModels.error.changeFailed": "Non è stato possibile modificare quel modello.",
  "localModels.error.unreachable": "Non è stato possibile raggiungere il box per modificare quel modello.",

  // === Desktop & power (TASK-455) ===
  "systemProfile.title": "Desktop e alimentazione",
  "systemProfile.desktopLabel": "Ambiente desktop",
  "systemProfile.desktopHelp": "Avvia il desktop GNOME completo sull'uscita HDMI della box e nel Desktop remoto. Disattivalo per lavorare senza schermo e recuperare circa 700 MB di memoria: non viene disinstallato nulla, puoi riattivarlo quando vuoi.",
  "systemProfile.performanceLabel": "Modalità prestazioni",
  "systemProfile.performanceHelp": "Blocca CPU e GPU alla frequenza massima invece di lasciarle variare. Il primo token arriva prima, ma la scheda resta a circa 7,2 W da ferma e l'inferenza locale prolungata è stata misurata a 74,8 °C, appena sopra il limite di 74 °C del raffreddamento passivo. Lasciala disattivata a meno che tu non esegua lavori lunghi con una buona ventilazione.",
  "systemProfile.rebootRequired": "Riavvia la box per applicare la modifica.",
  "systemProfile.unsupported": "Non disponibile su questo dispositivo.",
  "systemProfile.powerState": "Profilo di alimentazione: {profile} · frequenze: {clocks}",
  "systemProfile.clocksPinned": "bloccate",
  "systemProfile.clocksDynamic": "dinamiche",
  "systemProfile.memoryGuards": "Limiti di memoria attivi: AI locale {ollama}, browser {browser}, desktop {desktop}. L'AI locale serve {parallel} richieste per volta.",
  "systemProfile.loadFailed": "Impossibile leggere le impostazioni di desktop e alimentazione.",
  "systemProfile.desktopFailed": "Impossibile modificare l'impostazione del desktop.",
  "systemProfile.powerFailed": "Impossibile modificare il profilo di alimentazione.",

  // === TASK-452: skills store safety (flagged skills, incomplete downloads, keys) ===
  "skills.dangerTitle": "Controlla «{name}» prima di installarla",
  "skills.dangerLead": "Questo dispositivo ha analizzato la skill e l’ha segnalata come «{verdict}». Installarla è una sua decisione.",
  "skills.dangerSeverity": "L’analisi ha rilevato {critical} riscontri critici e {high} gravi.",
  "skills.dangerCanDo": "Cosa può fare questa skill sul suo dispositivo",
  "skills.dangerNoCapabilities": "L’analisi non ha indicato quale parte del dispositivo la skill tocchi.",
  "skills.dangerOther.one": "E {n} altro riscontro che l’analisi non ha saputo classificare.",
  "skills.dangerOther.other": "E altri {n} riscontri che l’analisi non ha saputo classificare.",
  "skills.dangerTrustNote": "La reputazione dell’autore non cambia le cose: ogni skill viene analizzata e ogni skill segnalata la conferma lei.",
  "skills.dangerShowFindings": "Mostra i {n} riscontri dell’analisi",
  "skills.dangerUnderstand": "Ho capito cosa può fare questa skill e voglio installarla lo stesso.",
  "skills.dangerInstallAnyway": "Installa lo stesso",
  "skills.dangerCancel": "Non installare",
  "skills.capability.shell": "Eseguire comandi sul suo dispositivo",
  "skills.capability.filesystem": "Leggere, modificare o eliminare i suoi file",
  "skills.capability.network": "Inviare e ricevere dati su internet",
  "skills.capability.credentials": "Leggere le sue chiavi, i token e le password salvate",
  "skills.capability.browser": "Controllare il browser del suo dispositivo",
  "skills.capability.system": "Modificare le impostazioni di sistema o installare software",
  "skills.capability.agentInstructions": "Modificare le istruzioni che il suo assistente segue",
  "skills.capability.other": "Qualcosa che l’analisi ha segnalato senza saperlo nominare",
  "skills.installIncomplete": "Il download è rimasto incompleto — mancano: {files}",
  "skills.installIncompleteHint": "Non è stato installato nulla. Controlli la connessione a internet e riprovi.",
  "skills.nameConflict": "«{name}» era già presente su questo dispositivo.",
  "skills.nameConflictHint": "Le skill incluse si aggiornano insieme al dispositivo, non dallo store.",
  "skills.installRepaired.one": "Download completato: {n} file che il programma di installazione aveva saltato.",
  "skills.installRepaired.other": "Download completato: {n} file che il programma di installazione aveva saltato.",
  "skills.skillDisabled": "Disattivata",
  "skills.skillDisabledHelp": "Installata ma spenta — il suo assistente non la userà.",
  "skills.countDisabled": "{n} disattivate",
  "skills.secretSaveLabel": "Inserisca {label}",
  "skills.secretPlaceholder": "Incolli qui la chiave",
  "skills.secretSave": "Salva chiave",
  "skills.secretSaving": "Salvataggio…",
  "skills.secretSaved": "Chiave salvata",
  "skills.secretStored": "Salvata su questo dispositivo",
  "skills.secretClear": "Rimuovi chiave",
  "skills.secretFailed": "Non è stato possibile salvare la chiave.",
  "skills.secretHelp": "La chiave viene salvata solo su questo dispositivo e non viene più mostrata.",

  // The Coding Agent app (the assistant's delegated Claude Code runs).
  "codingAgent.title": "Agente di codice",
  "codingAgent.chatWorking": "L'agente di codice sta lavorando",
  "codingAgent.chatWorkingOwner": "La tua esecuzione è in corso",  "codingAgent.chatFinished": "L'agente di codice ha finito",
  "codingAgent.chatFailed": "L'agente di codice non ha finito",
  "codingAgent.chatStopped": "Agente di codice fermato",

  "codingAgent.chatOpenApp": "apri",
  "codingAgent.noticeOpen": "Apri l'agente di codice",
  "codingAgent.noticeDismiss": "Ignora",
  "codingAgent.switchLabel": "Consenti all'assistente di delegare il lavoro di programmazione",
  "codingAgent.folderLabel": "Cartella del progetto",
  "codingAgent.folderPlaceholder": "/home/clawbox/Projects",
  "codingAgent.folderSave": "Salva",
  "codingAgent.folderFailed": "Impossibile salvare la cartella predefinita.",
  "codingAgent.claudeCode": "Claude Code",
  "codingAgent.wrapper": "claude-ds",
  "codingAgent.clawai": "ClawBox AI",
  "codingAgent.missing": "mancante",
  "codingAgent.notConnected": "non connesso",
  "codingAgent.effortLabel": "Sforzo",
  "codingAgent.effort.low": "Basso",
  "codingAgent.effort.xhigh": "Molto alto",
  "codingAgent.effort.max": "Massimo",
  "codingAgent.effortFailed": "Non è stato possibile cambiare lo sforzo di ragionamento.",
  "codingAgent.thinking": "sta pensando · {n} token",
  "codingAgent.more": "Mostra altro",
  "codingAgent.tokensWord": "token",
  "codingAgent.updated": "aggiornato",
  "codingAgent.githubOff": "non connesso",
  "codingAgent.githubConnect": "Connetti",
  "codingAgent.githubReconnect": "Cambia",
  "codingAgent.githubOut": "Esci",
  "codingAgent.githubOutConfirm": "Esci — tocca ancora",
  "codingAgent.githubOutFailed": "Impossibile disconnettere GitHub.",
  "codingAgent.backup": "Backup",
  "codingAgent.backupBusy": "Backup in corso…",
  "codingAgent.backupDone": "Backup su {repo}",
  "codingAgent.backupFailed": "Impossibile eseguire il backup su GitHub.",
  "codingAgent.recentRuns": "Esecuzioni recenti",  "codingAgent.clearRuns": "Cancella la cronologia",
  "codingAgent.clearConfirm": "Cancella — tocca ancora",
  "codingAgent.clearFailed": "Impossibile cancellare la cronologia.",

  "codingAgent.noRuns": "Nessuna esecuzione finora. Chiedi all'assistente di creare o modificare qualcosa in un progetto di codice.",
  "codingAgent.statusRunning": "In corso",
  "codingAgent.statusCompleted": "Completata",
  "codingAgent.statusFailed": "Non completata",
  "codingAgent.statusStopped": "Interrotta",
  "codingAgent.startedByAgent": "avviata dall'assistente",
  "codingAgent.startedByOwner": "avviata da te",
  "codingAgent.runMeta": "{turns} passaggi · {files} file modificati · {duration}",
  "codingAgent.denials": "{n} azioni non sono state consentite",
  "codingAgent.deniedTitle": "Non consentito",
  "codingAgent.deniedHelp": "L'agente di codice può eseguire solo un insieme fisso di comandi nella propria cartella. È il limite di sicurezza che funziona, non un errore: l'esecuzione di solito trova un'altra strada.",
  "codingAgent.stop": "Interrompi",
  "codingAgent.openLive": "Guarda dal vivo",
  "codingAgent.openResume": "Apri nel terminale",
  "codingAgent.showDetails": "Mostra dettagli",
  "codingAgent.hideDetails": "Nascondi dettagli",
  "codingAgent.loadFailed": "Impossibile leggere le impostazioni dell'agente di codice.",
  "codingAgent.toggleFailed": "Impossibile modificare l'impostazione dell'agente di codice.",
  "codingAgent.stopFailed": "Impossibile interrompere l'esecuzione.",
};
