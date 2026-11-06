---
name: email-outreach
description: "Write / send an email to…", "ask X for a quote", follow-ups — draft, show, send only after the owner says yes, optional follow-up reminder.
---

# Email outreach

1. Collect: recipient, purpose, language, tone. Use what the owner said; default to polite and short.
2. Draft subject + body (under 150 words unless asked). Show it in the chat exactly as it will be sent, with the
   recipient, and ask "Send it?".
3. Send only after an explicit yes, with MCP `email_send`. Edits → show the new draft again.
4. Report the result the tool returned (sent / queued for approval / error). If `email_send` says the owner must
   approve with a code, tell the owner that — do not ask for or guess the code.
5. If the owner wants a follow-up ("remind me if no answer in 3 days"), create it with the `reminders` skill.
6. No email account linked → say it is linked once in Settings → Email, then you can send.
