export const PORTAL_LOGIN_URL = "https://openclawhardware.dev/portal";
export const PORTAL_REGISTER_URL = `${PORTAL_LOGIN_URL}/register`;
export const PORTAL_SUBSCRIBE_URL = `${PORTAL_LOGIN_URL}/subscribe`;

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
  "Highest priority",
  "Full support from real humans via call/meeting",
] as const;

export const MAX_PLAN_BONUSES = [
  "Free 3 months of Max with your ClawBox purchase",
  "Extended warranty bonus",
] as const;

export const PURCHASE_EMAIL_NOTE =
  "Use the same email address as your ClawBox purchase to unlock the bonus.";
