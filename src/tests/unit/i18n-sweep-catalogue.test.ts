import { describe, expect, it } from "vitest";
import { translations } from "@/lib/translations";
import { de as editionDe } from "@/lib/edition-translations/de";
import type { Locale } from "@/lib/i18n";

/**
 * The UI sweep of the live device found whole surfaces that stayed English on
 * a German, Japanese or Bulgarian desktop: the System Update page (one `t()`
 * call and forty literals), the Files status bar and dialogs, the Terminal's
 * connection strings, the chat header and composer, the mascot menu, the
 * ClawBox AI device-code card, the "Connect AI Provider" card and the Network
 * page's address block. The components were wrapped with an English floor —
 * `tr(key, english)` — by an earlier pass, which fixes nothing on its own: a
 * key no locale carries renders the same English it used to hard-code.
 *
 * `translations.test.ts` cannot catch that. It compares the locale tables to
 * each other, so a key absent from ALL of them is invisible to it, and its
 * "mostly non-English" check allows 15% of the catalogue to match English —
 * these ~120 keys would disappear inside that allowance. This file asserts the
 * property that actually broke, per key and per locale.
 */

const NON_EN: Exclude<Locale, "en">[] = ["bg", "de", "es", "fr", "it", "ja", "nl", "sv", "zh"];

/** The System Update page — every string of it (sweep: update #4, #5, #8, #9). */
const UPDATE_KEYS = [
  "update.heroChecking", "update.heroCheckingSub", "update.heroUnreachable",
  "update.heroUnreachableSub", "update.heroCurrent", "update.heroCurrentSub",
  "update.heroAvailableOne", "update.heroAvailableMany", "update.heroAvailableSub",
  "update.componentJoin", "update.heroUpdating", "update.heroUpdatingSub",
  "update.heroComplete", "update.heroCompleteRestart", "update.heroCompleteSub",
  "update.heroFailed", "update.heroFailedSub", "update.updateEverything",
  "update.checkForUpdates", "update.checking", "update.tryAgain", "update.retrying",
  "update.startFailed", "update.startFailedHttp", "update.clawboxCardSub",
  "update.badgeUpdate", "update.badgeUnknown", "update.badgeCurrent",
  "update.installed", "update.latest", "update.updateComponent", "update.couldNotCheck",
  "update.upToDateShort", "update.agent", "update.agentSub", "update.pinnedByClawbox",
  "update.advancedOptions", "update.betaChannel", "update.betaChannelHelp",
  "update.branchOverride", "update.branchOverrideHelp", "update.save", "update.saving",
  "update.forceFullUpdate", "update.forceFullUpdateHelp", "update.betaConfirmTitle",
  "update.betaConfirmAction", "update.betaConfirmBody", "update.forceConfirmTitle",
  "update.forceConfirmAction", "update.forceConfirmBody", "update.forceConfirmReboot",
  "update.cancel", "update.progressFinished", "update.progressStopped",
  "update.progressRunning", "update.dismiss", "update.connecting", "update.unknownError",
  "update.reloadOnRestart",
  // The /updating screen, the one page guaranteed to be open while the box is
  // offline.
  "update.stuckHint", "update.offlineHint",
];

/** Settings → Providers and the ClawBox AI device-code card (sweep: settings #1). */
const AI_KEYS = [
  "settings.aiConnectTitle", "settings.aiConnectDesc",
  "ai.clawaiDeviceIntro", "ai.clawaiGetCode", "ai.clawaiHaveToken",
  "ai.clawaiTokenLabel", "ai.clawaiTokenPlaceholder", "ai.clawaiTokenHint",
  "ai.clawaiTokenFailed",
];

/** Settings → Network, half-translated under Deutsch (sweep: settings #2). */
const NETWORK_KEYS = [
  "settings.wired", "settings.accessDeviceAt", "settings.copyUrl",
  "settings.urlCopied", "settings.urlCopiedToClipboard", "settings.mdnsHint",
  "settings.hotspotNameRequired", "settings.hotspotNameTooLong",
  "settings.hotspotNameUpdated", "settings.hotspotPasswordTooLong",
  "settings.hotspotPasswordUpdated", "settings.loadingRemote",
];

/** The Files app's status bar, dialogs and menu names (sweep: files #6, #9, #10). */
const FILES_KEYS = [
  "files.results", "files.hiddenCount", "files.folderCreated", "files.renamed",
  "files.deleted", "files.uploadingFile", "files.uploadedCount", "files.noDiskSpace",
  "files.errorPrefix", "files.deleteTitle", "files.cannotUndo", "files.actionsFor",
  "files.nameNotPath", "files.searchStoppedEarly",
];

/** Terminal, launcher, window header, store, standalone page (sweep: apps #4, #7; shell #12, #16, #19). */
const SHELL_KEYS = [
  "terminal.connected", "terminal.disconnected", "terminal.error",
  "terminal.connectingToServer", "terminal.retrying", "terminal.tabsLabel",
  "launcher.page", "window.switchApp", "app.backToDesktop",
  "store.installedNotFromStore",
];

/** Chat header, composer and pills, plus the mascot menu (sweep: chat #5, #9). */
const CHAT_KEYS = [
  "chat.attachFile", "chat.dockToRight", "chat.undockPanel", "chat.openFullUi",
  "chat.pillChatProvider", "chat.pillHermesModel", "chat.pillProviderModel",
  "chat.pillReasoningEffort", "chat.pillThinking",
  "chat.effort.off", "chat.effort.minimal", "chat.effort.low", "chat.effort.medium",
  "chat.effort.high", "chat.effort.xhigh", "chat.effort.max", "chat.effort.adaptive",
  "mascot.openChat", "mascot.menuSleep", "mascot.menuHide",
];

/**
 * Memory Shard's amber banner and its "Last run:" line (sweep: memory #2). The
 * route names its failures in snake_case; a translation key may only carry
 * alphanumeric segments, so the component camel-cases the code — these are the
 * camel forms, one per code `clawkeep-memory.ts` can actually send.
 */
const MEMORY_KEYS = [
  "clawkeep.memory.error.indexIdentityMismatched",
  "clawkeep.memory.error.indexIdentityMissing",
  "clawkeep.memory.error.providerDegraded",
  "clawkeep.memory.error.statusUnavailable",
  "clawkeep.memory.runError.timedOut",
  "clawkeep.memory.runError.interrupted",
  "clawkeep.memory.runError.migrationBusy",
  "clawkeep.memory.runError.openclawMissing",
  "clawkeep.memory.runError.indexFailed",
];

const SURFACES: [string, string[]][] = [
  ["System Update page", UPDATE_KEYS],
  ["Providers card + ClawBox AI device login", AI_KEYS],
  ["Settings → Network", NETWORK_KEYS],
  ["Files app", FILES_KEYS],
  ["Terminal, launcher, window header, store", SHELL_KEYS],
  ["chat header and mascot", CHAT_KEYS],
  ["Memory Shard errors", MEMORY_KEYS],
];

/**
 * Values a locale may keep byte-identical to English, listed one by one rather
 * than by rule: each is a word the language really does spell that way ("das
 * Update", "l'Agent", "Page {n}", Spanish "Error", Swedish "Max"). Anything
 * not on this list that matches English is a gap, not a cognate.
 */
const SAME_AS_ENGLISH = new Set([
  "de:update.badgeUpdate", "de:update.agent", "de:chat.effort.minimal",
  "es:files.errorPrefix",
  "fr:update.agent", "fr:launcher.page", "fr:chat.effort.minimal",
  "nl:update.agent",
  "sv:update.agent", "sv:chat.effort.minimal", "sv:chat.effort.max",
]);

describe("strings the UI sweep found hard-coded in English", () => {
  describe.each(SURFACES)("%s", (_name, keys) => {
    it("has English copy for every key", () => {
      const missing = keys.filter((k) => !(k in translations.en));
      expect(missing, "keys missing from the English catalogue").toEqual([]);
    });

    for (const locale of NON_EN) {
      it(`'${locale}' carries a translation for every key`, () => {
        const missing = keys.filter((k) => !(k in translations[locale]));
        expect(missing, `keys missing from '${locale}'`).toEqual([]);

        const untranslated = keys.filter(
          (k) => translations[locale][k] === translations.en[k]
            && !SAME_AS_ENGLISH.has(`${locale}:${k}`),
        );
        expect(untranslated, `still English in '${locale}'`).toEqual([]);
      });
    }
  });

  it("keeps the interpolation slots the components substitute", () => {
    // A dropped slot is worse than an untranslated string: "Uploading (1/2)…"
    // with no file name, or an mDNS sentence with no address in it.
    const withSlots: [string, string[]][] = [
      ["update.heroAvailableSub", ["{components}"]],
      ["update.heroAvailableMany", ["{count}"]],
      ["update.betaChannelHelp", ["{beta}", "{main}"]],
      ["update.forceConfirmBody", ["{reboot}"]],
      ["update.startFailedHttp", ["{status}"]],
      ["update.updateComponent", ["{name}"]],
      ["settings.mdnsHint", ["{url}"]],
      ["files.uploadingFile", ["{name}", "{index}", "{total}"]],
      ["files.uploadedCount", ["{ok}", "{total}"]],
      ["files.noDiskSpace", ["{need}", "{available}"]],
      ["files.deleteTitle", ["{name}"]],
      ["launcher.page", ["{n}"]],
      ["chat.pillProviderModel", ["{provider}"]],
    ];
    for (const locale of ["en", ...NON_EN] as Locale[]) {
      for (const [key, slots] of withSlots) {
        for (const slot of slots) {
          expect(translations[locale][key], `${locale}["${key}"] lost ${slot}`).toContain(slot);
        }
      }
    }
  });
});

describe("German register", () => {
  /**
   * The sweep found the Coding Agent surfaces addressing the owner both ways
   * in one window: "Lassen Sie den Assistenten…" on the New app card,
   * "Deine Repositories werden gelesen…" in the Import panel two clicks away.
   * 27 of the namespace's strings used "Sie" and 6 used "du", so "Sie" is the
   * register the surface keeps.
   */
  it("addresses the owner as 'Sie' throughout the Coding Agent", () => {
    const informal = /\b(du|dein|deine|deinen|deinem|deiner|deines|dich|dir)\b/i;
    const offenders = Object.entries(editionDe)
      .filter(([key, value]) => key.startsWith("codingAgent.") && informal.test(value))
      .map(([key]) => key);
    expect(offenders, "codingAgent.* German strings still using the du-form").toEqual([]);
  });
});
