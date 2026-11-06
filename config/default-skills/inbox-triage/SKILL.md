---
name: inbox-triage
description: "Check my inbox", "what needs a reply", daily mail digest — read-only triage of the linked mailbox into reply-today / FYI / ignore.
---

# Inbox triage

1. List recent mail with MCP `email_list` (default: last 2 days, or since the last digest); open the ones that are
   not obvious newsletters with `email_read`.
2. Sort into three groups: **Reply today** (a person asks a question, a deadline, a customer, an invoice due),
   **FYI** (useful, no action), **Ignore** (newsletters, notifications, promotions).
3. Reply in the chat: Reply-today first, one line each — sender, subject, what they want, suggested answer in a
   few words. Then counts for FYI / Ignore.
4. Read-only: do not delete, archive, mark or answer anything unless the owner asks; replies go through the
   `email-outreach` skill (draft → yes → send).
5. "Do this every morning" → a daily cron via the `reminders` skill whose job runs this skill and delivers to the
   chat.
6. If `email_list` is not offered, reading is off for this mailbox: say it can be switched in Settings → Email.
