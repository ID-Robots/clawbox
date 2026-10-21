// ClawBox's realtime voice provider, as an OpenClaw plugin.
//
// WHAT IT IS FOR. Talk mode — a live spoken conversation instead of
// hold-to-talk — on a Max box, with no OpenAI key on the box. Every realtime
// provider the pinned core bundles mints its session secret from an OpenAI
// Platform key the box holds; this one asks the ClawBox AI proxy for a
// short-lived secret with the box's ClawBox AI token instead. See
// realtime-bridge.mjs for the proxy contract and the bridge.
//
// HARNESS FIRST. The seam is the core's own: `api.registerRealtimeVoiceProvider`
// (docs/plugins/sdk-overview/capabilities.md, "Duplex realtime voice
// sessions"), selected by the core's own `talk.realtime.provider`, declared in
// the manifest's `contracts.realtimeVoiceProviders` as the capability docs ask.
// It imports nothing from `openclaw/plugin-sdk/realtime-voice*`: those subpaths
// are private to official plugins at the pin, and a plain descriptor is all the
// registration takes.
//
// DEPLOYED like clawbox-path-guard: copied out of the checkout by
// gateway-pre-start.sh on every boot, and enabled only on a box whose
// `talk.realtime` that script armed — a Max box whose realtime Talk is not
// switched off.

import { buildClawboxRealtimeProvider } from "./realtime-bridge.mjs";

/** The plugin id, which must match `openclaw.plugin.json` and the config key. */
const PLUGIN_ID = "clawbox-realtime-voice";

const clawboxRealtimeVoicePlugin = {
  id: PLUGIN_ID,
  name: "ClawBox realtime voice",
  description: "Realtime Talk through the ClawBox AI proxy, with no OpenAI key on the box.",
  register(api) {
    api.registerRealtimeVoiceProvider(buildClawboxRealtimeProvider());
  },
};

// The loader follows only the `default` and `module` export keys, and its one
// hard requirement is that `register` is a function.
export default clawboxRealtimeVoicePlugin;
