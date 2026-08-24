/**
 * Spanish (Español) — TASK-458.
 *
 * Register follows the shipped ClawBox copy (setup wizard, ClawKeep, chat):
 * the user is addressed informally with "tú" ("Elige", "Inténtalo de nuevo",
 * "tu dispositivo"), while short controls stay terse imperatives ("Guardar",
 * "Instalar", "Reintentar"). Quotes are «…» as the Files/ClawKeep copy already
 * does; the em dash —, the ellipsis … and the arrow → are kept exactly where
 * the English uses them.
 *
 * Terminology reused from the existing catalogues: Settings → "Ajustes",
 * skill → "habilidad" (feminine, hence "instalada"/"eliminada"), provider →
 * "proveedor", API key → "clave API", sign in → "iniciar sesión", password →
 * "contraseña", device → "dispositivo", "the box" → "la caja",
 * publisher → "editor", scan → "análisis".
 */
export const es: Record<string, string> = {
  // === Sidebar sections that had no key at all ===
  "settings.localAi": "IA local",
  "settings.localModels": "Modelos locales",
  "settings.voice": "Voz",

  // === System password card ===
  "settings.security.passwordLabel": "Contraseña",
  "settings.security.passwordHintPrefix": "Se usa para iniciar sesión en la web, para SSH y para",
  "settings.security.passwordHintSuffix": ". Si la cambias aquí, cambia en los tres sitios.",
  "settings.security.currentPassword": "Contraseña actual",
  "settings.security.newPassword": "Nueva contraseña",
  "settings.security.newPasswordPlaceholder": "Nueva contraseña (8+ caracteres)",
  "settings.security.confirmNewPassword": "Confirmar la nueva contraseña",
  "settings.security.hideCurrentPassword": "Ocultar la contraseña actual",
  "settings.security.showCurrentPassword": "Mostrar la contraseña actual",
  "settings.security.hideNewPassword": "Ocultar la nueva contraseña",
  "settings.security.showNewPassword": "Mostrar la nueva contraseña",
  "settings.security.hideConfirmPassword": "Ocultar la confirmación de la contraseña",
  "settings.security.showConfirmPassword": "Mostrar la confirmación de la contraseña",
  "settings.security.clearAndReenter": "Borrar y volver a introducir la contraseña actual",
  "settings.security.reenter": "Reintroducir",
  "settings.security.checking": "Comprobando…",
  "settings.security.verify": "Verificar",
  "settings.security.passwordsDontMatchYet": "Las contraseñas aún no coinciden",
  "settings.security.saving": "Guardando…",
  "settings.security.updatePassword": "Actualizar contraseña",

  // === "Write this password down" confirmation dialog ===
  "settings.security.confirmTitle": "Apunta esta contraseña",
  "settings.security.confirmBodyPrefix": "Esto cambiará tu contraseña para",
  "settings.security.confirmBodyScope": "el inicio de sesión web, SSH y sudo",
  "settings.security.confirmBodySuffix": ". Si la olvidas, podrías quedarte sin acceso al dispositivo por completo y necesitarías un restablecimiento de fábrica para recuperarlo.",
  "settings.security.hidePassword": "Ocultar la contraseña",
  "settings.security.revealPassword": "Mostrar la contraseña",
  "settings.security.hide": "Ocultar",
  "settings.security.reveal": "Mostrar",
  "settings.security.confirmChange": "La he apuntado — cambiar",

  // === Validation and status ===
  "settings.security.errorTooShort": "La nueva contraseña debe tener al menos 8 caracteres",
  "settings.security.errorMismatch": "Las nuevas contraseñas no coinciden",
  "settings.security.errorSameAsCurrent": "La nueva contraseña debe ser distinta de la actual",
  "settings.security.errorInvalidChars": "La contraseña contiene caracteres no válidos",
  "settings.security.verificationFailed": "Error de verificación",
  "settings.security.updateSuccess": "Contraseña actualizada. Usa la nueva contraseña la próxima vez que inicies sesión o entres por SSH.",
  "settings.security.failed": "Error",

  // === Saved Wi-Fi password editor ===
  "settings.security.wifiPasswordLength": "La contraseña debe tener entre 8 y 63 caracteres",
  "settings.security.wifiPasswordUpdated": "Contraseña actualizada para {ssid}",

  // === Panel chrome ===
  "hermesProvider.title": "Modelos de Hermes",
  "hermesProvider.intro":
    "Este dispositivo funciona con Hermes. Elige un proveedor de inferencia y un modelo por defecto — Hermes los cambia de forma nativa, sin necesidad de ningún panel externo.",
  "hermesProvider.radioGroupLabel": "Proveedor de IA",
  "hermesProvider.continue": "Continuar",

  // === Provider rows ===
  "hermesProvider.row.desc.openrouter": "Más de 300 modelos con una sola clave API",
  "hermesProvider.row.desc.anthropic": "Claude — inicia sesión o usa una clave API",
  "hermesProvider.row.desc.openaiCodex": "Inicia sesión con OpenAI (Codex)",
  "hermesProvider.row.desc.gemini": "Modelos Gemini, acceso directo",
  "hermesProvider.row.desc.zai": "Modelos GLM de Zhipu",
  "hermesProvider.row.desc.kimiCoding": "Moonshot Kimi (para código)",
  "hermesProvider.row.desc.copilot": "Inicia sesión con GitHub",
  "hermesProvider.row.desc.nous": "Inicia sesión con Nous",

  // === ClawBox AI card ===
  "hermesProvider.clawai.activeBadge": "Activo",
  "hermesProvider.clawai.switching": "Cambiando…",
  "hermesProvider.clawai.switchTo": "Cambiar a {tier}",
  "hermesProvider.clawai.inUse": "ClawBox AI en uso",
  "hermesProvider.clawai.modelLabel": "Modelo:",
  "hermesProvider.clawai.finishingSetup": "Terminando la configuración en este dispositivo…",
  "hermesProvider.clawai.nowActive": "ClawBox AI ya es tu modelo activo",
  "hermesProvider.clawai.switchFailed": "No se pudo cambiar a ClawBox AI",

  // === Provider sign-in (Hermes-native OAuth) ===
  "hermesProvider.oauth.signInWith": "Iniciar sesión con {provider}",
  "hermesProvider.oauth.connectedDesc": "Conectado. Credenciales OAuth activas.",
  "hermesProvider.oauth.cliOnlyDesc": "En este proveedor la sesión se inicia desde Hermes CLI.",
  "hermesProvider.oauth.availableDesc": "OAuth mediante Hermes (no se necesita clave API).",
  "hermesProvider.oauth.connectedBadge": "Conectado",
  "hermesProvider.oauth.signIn": "Iniciar sesión",
  "hermesProvider.oauth.tryAgain": "Reintentar",
  "hermesProvider.oauth.cliInstructions": "Ejecuta esto en el terminal del dispositivo y vuelve a abrir este panel:",
  "hermesProvider.oauth.starting": "Iniciando sesión con {provider}...",
  "hermesProvider.oauth.pkceInstructions":
    "Se ha abierto una pestaña de inicio de sesión de {provider}. Aprueba el acceso ahí, copia el código que te muestre y pégalo aquí.",
  "hermesProvider.oauth.reopenSignInPage": "Volver a abrir la página de inicio de sesión",
  "hermesProvider.oauth.codeLabel": "Pega el código de {provider}",
  "hermesProvider.oauth.submitting": "Enviando...",
  "hermesProvider.oauth.submitCode": "Enviar código",
  "hermesProvider.oauth.startOver": "Empezar de nuevo",
  "hermesProvider.oauth.deviceInstructions":
    "Introduce este código en la página de verificación de {provider}. Este panel se actualiza solo en cuanto lo apruebes.",
  "hermesProvider.oauth.copyCode": "Copiar código",
  "hermesProvider.oauth.copied": "Copiado",
  "hermesProvider.oauth.openVerificationPage": "Abrir la página de verificación",
  "hermesProvider.oauth.waitingApproval": "Esperando aprobación...",
  "hermesProvider.oauth.orPasteKey": "…o, en su lugar, pega abajo una clave API.",
  "hermesProvider.oauth.advancedLabel": "Avanzado:",
  "hermesProvider.oauth.dashboardLink": "Panel de Hermes (solo en la LAN)",

  // === Provider sign-in failures raised by this panel ===
  "hermesProvider.oauth.unexpectedResponse": "Respuesta inesperada de Hermes",
  "hermesProvider.oauth.startFailed": "No se pudo comenzar el inicio de sesión",
  "hermesProvider.oauth.codeRejected": "El código no se ha aceptado",
  "hermesProvider.oauth.expired": "La solicitud de inicio de sesión ha caducado. Inténtalo de nuevo.",
  "hermesProvider.oauth.failed": "Error al iniciar sesión. Inténtalo de nuevo.",

  // === Model picker ===
  "hermesProvider.model.label": "Modelo por defecto",
  "hermesProvider.model.loading": "Cargando…",
  "hermesProvider.model.noCredentials": "Aún no hay credenciales para este proveedor",
  "hermesProvider.model.noModels": "No hay modelos disponibles",
  "hermesProvider.model.savedElsewherePrefix": "Este dispositivo usa actualmente",
  "hermesProvider.model.savedElsewhereSuffix": ". Al guardar, cambiará a {provider}.",
  "hermesProvider.model.staleColdStart": "Hermes aún no ha publicado una lista de modelos — se muestra una lista mínima de reserva.",
  "hermesProvider.model.staleCached": "Se muestra una lista de modelos en caché; el catálogo en vivo de Hermes no está accesible.",

  // === API key + save ===
  "hermesProvider.key.label": "Clave API de {provider}",
  "hermesProvider.key.placeholder": "Pega la clave API (opcional si ya está configurada)",
  "hermesProvider.save.button": "Guardar modelo y proveedor",
  "hermesProvider.save.saving": "Guardando…",
  "hermesProvider.save.ok": "Guardado",
  "hermesProvider.save.keySavedOk": "Clave guardada — proveedor y modelo actualizados",
  "hermesProvider.save.failed": "Error al guardar",
  "hermesProvider.save.keySavedNoCatalog":
    "Se ha guardado la clave de {provider}, pero aún no ha publicado una lista de modelos — vuelve a abrir este panel dentro de un momento y elige un modelo.",
  "hermesProvider.save.noCredentials": "{provider} aún no tiene credenciales — inicia sesión o pega primero una clave API.",
  "hermesProvider.save.catalogUnavailable":
    "La lista de modelos de Hermes no está accesible ahora mismo, así que no se pueden comprobar los modelos de {provider}. Inténtalo de nuevo dentro de un momento.",

  // === Header ===
  "skills.title": "Habilidades de Hermes",
  "skills.subtitleWithCount": "{n} habilidades disponibles para tu agente Hermes",
  "skills.subtitleFallback": "Añade capacidades a tu agente Hermes",

  // === Tabs ===
  "skills.tablistLabel": "Vista de habilidades",
  "skills.tabInstalled.withCount": "Instaladas ({n})",
  "skills.tabInstalled.empty": "Instaladas",
  "skills.tabBrowse": "Explorar",

  // === Search and filters ===
  "skills.searchPlaceholder": "Buscar habilidades…",
  "skills.searchLabel": "Buscar habilidades",
  "skills.searchBusy": "Cargando",
  "skills.clearSearch": "Borrar búsqueda",
  "skills.sortLabel": "Ordenar",
  "skills.sortOptions.relevance": "Mejor coincidencia",
  "skills.sortOptions.name": "Nombre A–Z",
  "skills.sortOptions.trust": "Más fiables",
  "skills.sortOptions.popular": "Más instaladas",
  "skills.sourceLabel": "Fuente",
  "skills.allSources": "Todas las fuentes",
  "skills.providerLabel": "Editor",
  "skills.allProviders": "Todos los editores",
  "skills.categoryLabel": "Categoría",
  "skills.allCategories": "Todas las categorías",
  "skills.showingRange": "Mostrando {from}–{to} de {total}",
  "skills.degradedCount": "Las {n} mejores coincidencias — afina tu búsqueda para reducirlas",
  "skills.loadMore": "Cargar más",
  "skills.loadingMore": "Cargando más habilidades…",

  // === Scan verdicts ===
  "skills.scanPassed": "Análisis superado",
  "skills.scanFlagged.one": "El análisis detectó {n} hallazgo",
  "skills.scanFlagged.other": "El análisis detectó {n} hallazgos",
  "skills.notScanned": "Sin analizar",

  // === Where a skill came from ===
  "skills.originBuiltin": "Integrada",
  "skills.originHub": "Instalada",
  "skills.originLocal": "Creada aquí",
  "skills.originLocalHelp": "Escrita en este dispositivo por tu agente — no proviene de un registro.",

  // === Actions ===
  "skills.install": "Instalar",
  "skills.installing": "Instalando…",
  "skills.installed": "Instalada",
  "skills.remove": "Eliminar",
  "skills.removing": "Eliminando…",
  "skills.retry": "Reintentar",
  "skills.builtinLocked": "Ya disponible (integrada)",
  "skills.cancel": "Cancelar",

  // === Install / remove confirmation ===
  "skills.installTitle": "¿Instalar {name}?",
  "skills.installTrustedBody": "Esta habilidad se ejecuta dentro de tu agente Hermes. Hermes la analiza antes de activarla.",
  "skills.installCommunityBody": "Aportada por la comunidad y no revisada por ID Robots. Comprueba que el identificador de abajo coincide con el editor que esperas.",
  "skills.installWillAsk": "Te pedirá: {labels}",
  "skills.uninstallTitle": "¿Eliminar {name}?",
  "skills.uninstallBody.withPath": "Esto borra {path} de tu agente. Puedes volver a instalarla desde «Explorar».",
  "skills.uninstallBody.generic": "Esto borra la habilidad de tu agente. Puedes volver a instalarla desde «Explorar».",

  // === Mutation status (announced in the store's live region) ===
  "skills.liveInstalling": "Instalando {name}",
  "skills.liveInstalled": "{name} instalada",
  "skills.liveInstallFailed": "No se pudo instalar {name}",
  "skills.installFailed": "Error en la instalación",
  "skills.liveRemoving": "Eliminando {name}",
  "skills.liveRemoved": "{name} eliminada",
  "skills.liveRemoveFailed": "No se pudo eliminar {name}",
  "skills.uninstallFailed": "Error al desinstalar",

  // === Empty and error states ===
  "skills.emptySearch": "Ninguna habilidad coincide con «{q}»",
  "skills.emptySearchHint": "Prueba con otro término.",
  "skills.emptySearchAllSources": "Buscar en todas las fuentes",
  "skills.emptySource": "Aún no hay nada en {label}",
  "skills.clearSourceFilter": "Quitar el filtro de {label}",
  "skills.emptyInstalled": "No hay habilidades instaladas",
  "skills.emptyInstalledHint": "Explora el registro para añadir capacidades.",
  "skills.browseSkills": "Explorar habilidades",
  "skills.installedError": "No se pudieron leer tus habilidades instaladas.",
  "skills.installedStale": "No se pudo actualizar esta lista — se muestra el último estado conocido.",
  "skills.buildingCatalog": "Se está creando el catálogo de habilidades — la primera vez que lo exploras en un dispositivo nuevo tarda alrededor de un minuto.",
  "skills.buildingCatalogAuto": "Las habilidades aparecerán aquí en cuanto esté listo — puedes dejar esto abierto.",
  "skills.catalogStale": "Catálogo descargado por última vez {when}.",

  // === Ambiguous identifier ===
  "skills.ambiguousTitle": "{n} habilidades se llaman «{q}». Elige la que quieras:",
  "skills.ambiguousPickFirst": "Elige una de abajo para instalarla",

  // === Platform compatibility ===
  "skills.platformWarning": "Requiere {platforms} — esta habilidad no funcionará en tu ClawBox.",
  "skills.platformOnly": "Solo para {platforms}",

  // === Detail sections ===
  "skills.sectionRequirements": "Requisitos",
  "skills.sectionGlance": "De un vistazo",
  "skills.sectionAbout": "Acerca de",
  "skills.sectionSecurity": "Seguridad y procedencia",
  "skills.sectionRelated": "Habilidades relacionadas",
  "skills.sectionDocs": "Documentación",
  "skills.docsOutline": "En este documento",
  "skills.docsSections": "{n} secciones",
  "skills.readMore": "Leer más",
  "skills.showLess": "Mostrar menos",
  "skills.docsFull": "SKILL.md completo",
  "skills.docsPreview": "Vista previa de la documentación — el texto completo está disponible tras la instalación",
  "skills.docsLoading": "Cargando la documentación…",
  "skills.docsUnavailable": "Todavía no hay documentación para esta habilidad.",

  // === Requirements card ===
  "skills.reqCommands": "Comandos",
  "skills.reqCommandPresent": "disponible en este dispositivo",
  "skills.reqCommandMissing": "no instalado",
  "skills.reqEnvVars": "Variables de entorno",
  "skills.reqDependencies": "Paquetes",
  "skills.reqCredentials": "Archivos de credenciales",
  "skills.reqCompatibility": "Compatibilidad",
  "skills.reqSetup": "Configuración",
  "skills.reqSecrets": "Te pedirá",
  "skills.reqGetKey": "Obtener una clave",
  "skills.reqSetupGuide": "Guía de configuración",

  // === Provenance card ===
  "skills.provSource": "Fuente",
  "skills.provSourceUnverified": "Sitio del editor (sin verificar)",
  "skills.provRepo": "Repositorio",
  "skills.provDetailPage": "Página de detalles",
  "skills.provHomepage": "Página principal",
  "skills.provInstallCommand": "Comando de instalación",
  "skills.provWeeklyInstalls": "Instalaciones",
  "skills.provContentHash": "Hash del contenido",
  "skills.showAllFindings": "Mostrar los {n} hallazgos",
  "skills.copyIdentifier": "Copiar identificador",
  "skills.copied": "Copiado",

  // === "At a glance" fields and card facts ===
  "skills.fieldVersion": "Versión",
  "skills.fieldAuthor": "Autor",
  "skills.fieldLicense": "Licencia",
  "skills.fieldCategory": "Categoría",
  "skills.fieldPlatforms": "Plataformas",
  "skills.fieldSize": "Tamaño",
  "skills.fieldIncludes": "Incluye",
  "skills.fieldInstalled": "Instalada",
  "skills.fieldUpdated": "Actualizada",
  "skills.fileCount.one": "{n} archivo",
  "skills.fileCount.other": "{n} archivos",
  "skills.installedAgo": "Instalada {when}",

  // === Navigation ===
  "skills.back": "Volver a las habilidades",
  "skills.breadcrumbLabel": "Ruta de navegación",
  "skills.breadcrumbBrowse": "Explorar",
  "skills.breadcrumbInstalled": "Instaladas",

  // === Relative dates (hub lock timestamps) ===
  "skills.relative.justNow": "ahora mismo",
  "skills.relative.minutes": "hace {n} min",
  "skills.relative.hours": "hace {n} h",
  "skills.relative.days.one": "hace {n} día",
  "skills.relative.days.other": "hace {n} días",
  "skills.relative.months.one": "hace {n} mes",
  "skills.relative.months.other": "hace {n} meses",
  "skills.relative.years": "hace {n} a",

  // === Kind of model ===
  "localModels.kind.llm": "Lenguaje",
  "localModels.kind.tts": "Voz de salida",
  "localModels.kind.stt": "Voz de entrada",
  "localModels.kind.embedding": "Memoria",

  // === Run state ===
  "localModels.run.running": "En ejecución",
  "localModels.run.idle": "Detenido",
  "localModels.run.onDemand": "Bajo demanda",
  "localModels.run.notInstalled": "No instalado",

  // === Panel ===
  "localModels.intro": "Todo lo que puede ejecutarse en la propia caja y lo que está haciendo ahora mismo. Lo que aparece como no instalado es que de verdad no está — no es un ajuste que puedas activar aquí.",
  "localModels.unavailable": "No se pudo leer el estado de: {list}.",
  "localModels.disk": "Disco {size}",
  "localModels.memoryInUse": "Memoria en uso {size}",
  "localModels.managedInClawKeep": "Se gestiona en ClawKeep.",
  "localModels.managedInLocalAi": "Se gestiona en Ajustes → IA local.",
  "localModels.toggleLabel": "{name} activado",
  "localModels.footer": "Desactivar un modelo lo detiene al momento y sigue desactivado después de reiniciar.",

  // === Errors ===
  "localModels.error.changeFailed": "No se pudo cambiar ese modelo.",
  "localModels.error.unreachable": "No se pudo contactar con la caja para cambiar ese modelo.",
};
