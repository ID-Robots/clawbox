---
name: reminders
description: "Remind me…", "every Monday at 9…", "each day send me…", list or cancel reminders — natural language to scheduled jobs delivered to this chat.
---

# Reminders and recurring jobs

1. Turn the request into a schedule in the owner's time zone (ask only if it is unknown and the time matters):
   one-off → a single run at that time; recurring → a cron expression (e.g. Monday 09:00 = `0 9 * * 1`).
2. Create it with your `cron` tool. The job's message says exactly what to do when it fires (a plain reminder
   text, or a task such as "run the inbox-triage skill" or "top 3 news on <topic> with links"), and it delivers
   to the chat the owner is using now.
3. Reply with: what, when (next run in local time), and the job id.
4. "List my reminders" → list jobs, one line each with next run. "Cancel X" → remove that job and confirm.
5. Done = the job appears in the cron list with the right next run time.
