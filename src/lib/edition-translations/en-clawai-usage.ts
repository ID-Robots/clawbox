/**
 * ClawBox AI's rolling allowances, as the owner reads them: the usage card in
 * Settings → Providers (`clawaiUsage.*`) and the chat's sentence when a turn is
 * refused because one of them is spent (`chat.allowance*`).
 *
 * "Frees up at", never "resets at": the windows roll — the oldest usage ages
 * out — so nothing resets, and the instant is when enough comes back.
 *
 * Plans are named as the customer knows them ("Free", "Pro", "Max"), passed in
 * as {plan} from the portal's own display name.
 */
export const clawaiUsageEn: Record<string, string> = {
  "clawaiUsage.title": "ClawBox AI usage",
  "clawaiUsage.planName": "{plan} plan",
  "clawaiUsage.loading": "Loading your usage…",

  // The weekly chat pool and the burst ceiling over it.
  "clawaiUsage.weeklyTitle": "Weekly chat allowance",
  "clawaiUsage.burstTitle": "5-hour burst",
  "clawaiUsage.percentUsed": "{percent}% used",
  "clawaiUsage.tokensOf": "{used} of {limit} tokens",
  "clawaiUsage.countOf": "{used} of {limit}",
  "clawaiUsage.minutesOf": "{used} of {limit} min",
  "clawaiUsage.freesUpAt": "Frees up at {time}",
  "clawaiUsage.notInPlan": "Not in your plan",
  "clawaiUsage.notReadable": "Not available right now",

  // The four rolling-week meters.
  "clawaiUsage.metersTitle": "This week",
  "clawaiUsage.meterImages": "Images",
  "clawaiUsage.meterSpeech": "Text-to-speech minutes",
  "clawaiUsage.meterTranscription": "Speech-to-text minutes",
  "clawaiUsage.meterEmbeddings": "Memory indexing",

  // Prepaid credits on a paid plan; Upgrade on Free.
  "clawaiUsage.creditsTitle": "Credits",
  "clawaiUsage.creditsBalance": "Balance",
  "clawaiUsage.creditsUsedThisWeek": "Used from credits this week",
  "clawaiUsage.creditsHint": "Credits are spent only after an allowance runs out.",
  "clawaiUsage.topUp": "Top up",
  "clawaiUsage.upgrade": "Upgrade",
  "clawaiUsage.upgradeHint": "Paid plans have larger weekly allowances and can top up with credits.",
  "clawaiUsage.yearlyOffer": "Save {percent}% with yearly billing",

  // An older portal that still answers with the daily view.
  "clawaiUsage.legacyTitle": "Today's usage",
  "clawaiUsage.legacyResetsIn": "Resets in {time}",
  "clawaiUsage.legacyOverLimit": "Today's limit is reached.",

  // Nothing to draw, and why.
  "clawaiUsage.refused": "ClawBox AI does not share usage details with this box yet. You can see them in your account on clawbox.com.",
  "clawaiUsage.unreachable": "Your usage could not be loaded right now. The card tries again in a minute.",
  "clawaiUsage.openPortal": "Open clawbox.com",

  // A chat turn refused because an allowance is spent.
  "chat.allowanceWeekly": "That message did not go through — this week's ClawBox AI chat allowance is used up.",
  "chat.allowanceBurst": "That message did not go through — the ClawBox AI 5-hour burst limit is reached. Your weekly allowance still has room.",
  "chat.allowanceEmbeddings": "That did not go through — this week's ClawBox AI memory indexing allowance is used up.",
  "chat.allowanceFreesUpAt": "It frees up at {time}.",
  "chat.allowanceFreesUpLater": "It frees up as older usage leaves the rolling window.",
  "chat.allowanceSeeUsage": "Your usage is in Settings, under Providers.",
};
