/**
 * English copy for the ClawBox AI pitch on Settings → Providers — the card an
 * UNLINKED box shows, and nothing else does.
 *
 * The owner's decision of 2026-09-15: a box with a ClawBox AI subscription
 * runs the cloud models by default and only goes local when the owner says
 * so; a box without one is told that ClawBox AI is the best experience and
 * given the way to get it — with the route to the on-device models beside it,
 * so an owner who wants to stay local is pointed at the tab that sets that up
 * rather than left to find it.
 *
 * BOTH HALVES ARE THE POINT. A pitch with no local route would read as a box
 * that does not work without a subscription, which is not what it was sold as;
 * a local route with no pitch is what the box shipped with, and said nothing
 * about the better option at all.
 */
export const clawaiPitchEn: Record<string, string> = {
  "settings.clawaiPitch.title": "Use ClawBox AI for the best experience",
  "settings.clawaiPitch.body":
    "A ClawBox AI subscription runs the chat, the voice, transcription and memory search on models far larger than this box can hold, and sets all of them up for you. It is what a subscriber's box uses by default.",
  "settings.clawaiPitch.connect": "Connect ClawBox AI",
  "settings.clawaiPitch.plans": "See plans and pricing",
  "settings.clawaiPitch.localTitle": "Would you rather keep everything on this box?",
  "settings.clawaiPitch.localBody":
    "ClawBox can run its own models on the device instead, so nothing leaves it. They are smaller and slower than the cloud ones, and you choose and install them yourself.",
  "settings.clawaiPitch.localAction": "Set up Local AI",
};
