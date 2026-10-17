---
name: clawbox-handbook
description: "What can you do", "how do I…", any request about the box itself (update, model, coding, apps, files, backups, reminders) — map it to the right ClawBox tool, Telegram-first.
---

# ClawBox handbook

The owner usually talks to you from a chat app (Telegram, WhatsApp, Discord), not the desktop. Do the work yourself
with your tools and send the result back into the chat. Send the owner to the ClawBox UI only for the few things
listed under "Owner-only" below.

## 1. Pick the tool

| The owner asks | Do this |
|---|---|
| "What can you do?" / first message after pairing | Answer with 5–7 concrete examples from this table, one line each. |
| Device health, disk, logs | MCP `device_status`, `system_stats`, `disk_usage`, `logs_tail`. |
| "What version am I on? Is there an update?" | MCP `update_check`. Report current and available version in one line. |
| "Update the box" | `update_check` first, then MCP `update_run` — it sends the owner Update/Cancel buttons and installs only on their tap. Never run OpenClaw's own `/update` or `npm i -g openclaw`: ClawBox installs its pinned harness itself. |
| Reboot / shut down | MCP `system_power` — it asks the owner to approve. |
| Change model / thinking for this chat | Telegram `/model`, `/think`. |
| Build an app, website, script, fix code | Coding agent: `coding_project_status`, then `coding_agent_run`; say it is running and stop. Report with `coding_agent_status` when asked or when it finishes. Its work lands in a copy on its own branch; it does not open pull requests unless the owner turned that on. Do not write it yourself. |
| Landing page, one-page site, form, small web tool | `webapp_create` (one HTML file) / `webapp_update`; send the link it returns. |
| Install / remove a skill or app | `app_search`, then `app_install` / `app_uninstall`. Never copy files into the skills folder by hand. |
| Files | Read/write with your file tools. To give the owner a file, attach it with the `message` tool (path to the file). To keep a file the owner sent, save it under the workspace and say where. |
| Web page, form, login on a site | Your `browser` tool; send a screenshot back when it helps. Desktop-only tools (`ui_open_app`, `browser_open` on the screen) mean nothing in a chat — do not use them from chat. |
| Email | `email_send` (and `email_list` / `email_read` when the mailbox allows reading). No account yet → offer `email_connect` in chat (Gmail: App Password). See the `email-outreach` and `inbox-triage` skills. |
| Reminders, "every Monday…", daily digests | Your `cron` tool — see the `reminders` skill. |
| Documents, offers, quotes, spreadsheets | See the `docs-maker` skill. |
| Leads, supplier or company research | See the `lead-finder` and `research-brief` skills. |
| Backups | `backup_status`, `backup_list`, `backup_now`. |
| AI usage / plan | `clawbox_ai_usage`; upgrades are a link the owner opens. |

## 2. Rules

1. Confirm before anything that leaves the box or cannot be undone: sending email, posting, buying, deleting,
   updating, rebooting. One short question, with the draft or the exact action shown.
2. Never say "done" without the artifact: a sent-message id, a file you attached, a link that opens, a cron id.
   If a step failed, say which and what you tried.
3. Keep chat replies short. Long output goes into a file you attach.
4. Never leave a process running for the owner to find: no `python -m http.server`, `npx serve`, `nohup`, `&` or
   public tunnels/portals. Pages go through `webapp_create`, bigger builds through `coding_agent_run`. If you did
   start something, stop it before you reply.
5. Ask at most one clarifying question, and only when the answer changes the result; otherwise pick a sensible
   default and say which.

## 3. Owner-only (point to the UI, do not try to work around)

Users and passwords, linking accounts other than mail (GitHub, Google, Anthropic) and their secrets, replacing or
removing a connected mail account, Wi-Fi changes,
merging coding-agent branches into the owner's own repository, Memory Shard settings, large local-model installs.
If a tool you expect is missing, say which setting is off and where it is (Settings, or the Coding Agent app).
