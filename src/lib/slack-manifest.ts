// The Slack app manifest the Settings pane offers for pasting into
// api.slack.com/apps → Create New App → From a manifest.
//
// Each harness has its own native answer, and the pane shows that one:
//   * Hermes generates it: `hermes slack manifest --name <name>` prints the
//     manifest for its own Slack adapter (scopes, events, its slash commands).
//   * OpenClaw has no CLI for it; its Slack plugin documents the manifest
//     instead (channels/slack/setup.md, "Recommended", Socket Mode). That
//     manifest is reproduced below with only the display names changed.

import { runHermesCli } from "@/lib/hermes-cli";
import type { Harness } from "@/lib/harness";

const APP_NAME = "ClawBox";
const MANIFEST_TIMEOUT_MS = 60_000;

/** OpenClaw's recommended Socket Mode manifest (pinned plugin docs). */
export const OPENCLAW_SLACK_MANIFEST = Object.freeze({
  display_information: {
    name: APP_NAME,
    description: "Your ClawBox assistant in Slack",
  },
  features: {
    bot_user: { display_name: APP_NAME, always_online: true },
    app_home: {
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
    agent_view: {
      agent_description: "ClawBox connects Slack Agent View conversations to its assistant.",
      suggested_prompts: [
        { title: "What can you do?", message: "What can you help me with?" },
        { title: "Summarize this channel", message: "Summarize the recent activity in this channel." },
        { title: "Draft a reply", message: "Help me draft a reply." },
      ],
    },
    slash_commands: [
      { command: "/openclaw", description: "Send a message to the assistant", should_escape: false },
    ],
  },
  oauth_config: {
    scopes: {
      bot: [
        "app_mentions:read",
        "assistant:write",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "emoji:read",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "pins:read",
        "pins:write",
        "reactions:read",
        "reactions:write",
        "usergroups:read",
        "users:read",
      ],
    },
  },
  settings: {
    socket_mode_enabled: true,
    event_subscriptions: {
      bot_events: [
        "app_home_opened",
        "app_mention",
        "app_context_changed",
        "agent_session_stopped",
        "agent_session_title_changed",
        "channel_rename",
        "member_joined_channel",
        "member_left_channel",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "pin_added",
        "pin_removed",
        "reaction_added",
        "reaction_removed",
      ],
    },
  },
});

/**
 * The same manifest without OpenClaw's slash command — what a Hermes box falls
 * back to when its own generator cannot be run, so the owner is never handed a
 * `/openclaw` command nothing on the box answers.
 */
function neutralManifest(): Record<string, unknown> {
  const { slash_commands: _openclawOnly, ...features } = OPENCLAW_SLACK_MANIFEST.features;
  const scopes = OPENCLAW_SLACK_MANIFEST.oauth_config.scopes.bot.filter((s) => s !== "commands");
  return {
    ...OPENCLAW_SLACK_MANIFEST,
    features,
    oauth_config: { scopes: { bot: scopes } },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SlackManifestResult {
  /** Pretty-printed JSON, ready to paste. */
  manifest: string;
  /** Where it came from: Hermes' generator, OpenClaw's docs, or the fallback. */
  source: "hermes" | "openclaw" | "fallback";
}

/** The manifest for the active harness. Never throws. */
export async function readSlackManifest(harness: Harness): Promise<SlackManifestResult> {
  if (harness !== "hermes") {
    return { manifest: JSON.stringify(OPENCLAW_SLACK_MANIFEST, null, 2), source: "openclaw" };
  }
  try {
    const res = await runHermesCli(["slack", "manifest", "--name", APP_NAME], {
      timeoutMs: MANIFEST_TIMEOUT_MS,
    });
    if (res.code === 0) {
      const parsed: unknown = JSON.parse(res.stdout);
      // A manifest is an object with Slack's top-level keys; anything else is
      // not something to hand the owner for pasting.
      if (isRecord(parsed) && isRecord(parsed.display_information) && isRecord(parsed.settings)) {
        return { manifest: JSON.stringify(parsed, null, 2), source: "hermes" };
      }
    }
  } catch {
    // CLI missing, timed out, or printed something that is not JSON.
  }
  return { manifest: JSON.stringify(neutralManifest(), null, 2), source: "fallback" };
}
