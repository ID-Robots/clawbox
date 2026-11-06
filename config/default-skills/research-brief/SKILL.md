---
name: research-brief
description: "Research suppliers / competitors / a company / a market", "compare options" — short cited brief with a comparison table.
---

# Research brief

1. Fix the question: what is being compared, where (country/region), how many options (default 3–5), what
   matters (price, MOQ, delivery, contacts, reviews).
2. Search with `web_search` in the local language and English; read the sources with `web_fetch`/`browser`.
   Prefer the company's own pages, official registers and recent articles.
3. Output: a table (one row per option, the asked columns + source URL) and 3–5 bullets with the recommendation
   and open questions. Mark any price as "hint" with its date and source; never invent numbers.
4. Short brief → in the chat. Longer → a PDF/DOCX via the `docs-maker` skill, attached.
5. Done = every row has at least one source link that opens.
