// Build-time switches. The vault service builds the extension when it starts
// (src/server/extensiondir.ts) and sets these from its own configuration, so
// the browser and the service can never disagree about them.
declare const __VAULT_CARDS__: boolean | undefined;

/**
 * Payment cards. Off unless the service runs with CLAWBOX_VAULT_CARDS=1: the
 * content script then reads no card field at all, shows no chip and no card
 * save bar, the popup has no Cards tab and no card command is carried out.
 */
export const CARDS_ENABLED: boolean = typeof __VAULT_CARDS__ === "boolean" ? __VAULT_CARDS__ : false;
