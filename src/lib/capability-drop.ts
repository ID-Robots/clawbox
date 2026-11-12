/**
 * The capability drop for the programs the web server starts, for the
 * TypeScript side. The implementation is scripts/capability-drop.js, which
 * production-server.js's CommonJS scripts require as well: one file, so the
 * gate cannot judge a host one way here and another way there. Nothing but
 * this re-export belongs in this file (capability-drop.test.ts pins that).
 */
export {
  CAPABILITY_DROP_COMMAND,
  CAPABILITY_DROP_ARGS,
  SETPRIV_PATH,
  WEB_SERVER_OWN_SETTINGS,
  withoutWebServerSettings,
  withCapabilityDrop,
} from "../../scripts/capability-drop.js";
