export const PORTAL_LOGIN_URL = "https://openclawhardware.dev/portal";
export const PORTAL_REGISTER_URL = `${PORTAL_LOGIN_URL}/register`;
export const PORTAL_SUBSCRIBE_URL = `${PORTAL_LOGIN_URL}/subscribe`;
// Where Free users generate a manual ClawBox AI token. Surfaced from the
// 400 free_users_use_manual_token response Mike's portal returns when
// the device tries to pair as Free.
export const PORTAL_DASHBOARD_URL = `${PORTAL_LOGIN_URL}/dashboard`;

export const FREE_PLAN_FEATURES = [
  "Standard daily usage",
  "Powered by DeepSeek",
  "Portal access",
] as const;

export const PRO_PLAN_FEATURES = [
  "5x more usage than Free",
  "Powered by DeepSeek",
  "Priority processing",
  "Email support",
] as const;

export const MAX_PLAN_FEATURES = [
  "Maximum usage",
  "Powered by DeepSeek",
  "1M token context window",
  "Highest priority",
  "Full support from real humans via call/meeting",
] as const;

export const MAX_PLAN_BONUSES = [
  "Free 3 months of Max with your ClawBox purchase",
  "Extended warranty bonus",
] as const;

export const PURCHASE_EMAIL_NOTE =
  "Use the same email address as your ClawBox purchase to unlock the bonus.";
