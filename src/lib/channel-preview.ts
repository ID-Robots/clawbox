// Preview channels: guided setups that ship switched OFF.
//
// A channel is a preview while something it needs on the box is still an open
// decision, not a code question — Signal needs `signal-cli` (a JVM build and a
// JRE on the Jetson, RAM unmeasured), Teams needs a public HTTPS endpoint the
// box does not open by itself. The code is complete and tested either way;
// what the flag withholds is the offer, so no owner is walked into a setup the
// box cannot finish.
//
// Turning one on is one line in /home/clawbox/clawbox/.env (owner-editable,
// loaded by clawbox-setup.service) and a restart of that service:
//
//     CLAWBOX_PREVIEW_CHANNELS=signal,msteams
//
// Removing the line turns it off again; nothing else is written. The routes
// check the flag themselves (a hidden row is not a gate), and the hub reads
// /setup-api/channels/preview to decide which rows to show.

export const PREVIEW_CHANNELS_ENV = "CLAWBOX_PREVIEW_CHANNELS";

export type PreviewChannel = "signal" | "msteams";

/** The environment the flag is read from — process.env, or a test's own. */
type Env = Readonly<Record<string, string | undefined>>;

export const PREVIEW_CHANNELS: readonly PreviewChannel[] = ["signal", "msteams"];

/** The preview channels this box's environment switches on. */
export function enabledPreviewChannels(env: Env = process.env): PreviewChannel[] {
  const raw = env[PREVIEW_CHANNELS_ENV] ?? "";
  const asked = new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  return PREVIEW_CHANNELS.filter((id) => asked.has(id));
}

export function isPreviewChannelEnabled(id: PreviewChannel, env: Env = process.env): boolean {
  return enabledPreviewChannels(env).includes(id);
}
