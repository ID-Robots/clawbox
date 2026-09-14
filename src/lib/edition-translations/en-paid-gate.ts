/**
 * The paid-plan gate: what the first step of the Coding Agent and Memory Shard
 * wizards says when this box's ClawBox AI account is Free, or when there is no
 * account on it at all. Owner's decision, 2026-09-14.
 *
 * ONE namespace for both features rather than a copy under `codingAgent.*` and
 * another under `clawkeep.memory.*`: the sentences are the same sentences, the
 * component that draws them is shared, and the third feature that needs this
 * should add a name and a description here and nothing else.
 *
 * The plans are always named as the CUSTOMER knows them — "Pro" and "Max" —
 * never as the internal tier ids (`flash` is Pro and `pro` is Max; see
 * src/lib/paid-plan-gate.ts).
 */
export const paidGateEn: Record<string, string> = {
  // The feature names, as {feature} in `upgradeCard.needsPaidPlan`.
  "paidGate.featureCodingAgent": "Coding agent",
  "paidGate.featureMemoryShard": "Memory Shard",

  // The upgrade card's body, per feature: what it does, and what unlocks it.
  "paidGate.codingAgentDescription":
    "The coding agent hands a whole task to a coding run on this box — it writes the files, runs the tests and reports back. Available on the Pro and Max plans.",
  "paidGate.memoryShardDescription":
    "Memory Shard indexes the folders you choose so the assistant can search your own documents. Available on the Pro and Max plans.",

  // No ClawBox AI account on the box at all: the device-code handoff, the same
  // one the setup wizard and the Providers page run.
  "paidGate.signInTitle": "Connect your ClawBox account",
  "paidGate.signInBody": "{feature} needs a ClawBox Pro or Max plan. Connect this box to your ClawBox account, then switch the feature on.",
  "paidGate.signInButton": "Connect ClawBox AI",
  "paidGate.signInCancel": "Cancel",
  "paidGate.signInStarting": "Requesting a code…",

  // The disabled enable button's tooltip, on both wizards.
  "paidGate.buttonBlocked": "Needs a ClawBox Pro or Max plan",

  // The one line the two settings pages show when the plan does not cover the
  // feature that page is for, with a link to the portal.
  "paidGate.requiresPlan": "Requires a Pro or Max plan",
  "paidGate.upgradeLink": "Upgrade",

  // The gate is still being read.
  "paidGate.loading": "Checking your plan…",
};
