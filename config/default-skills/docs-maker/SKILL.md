---
name: docs-maker
description: "Make an offer / quote / invoice draft / letter / one-pager / spreadsheet" — create DOCX, PDF or XLSX from chat and send the file back.
---

# Docs maker

1. Collect the content: who it is for, items/prices, dates, language. Use the owner's company details if they are
   in memory; otherwise leave clear placeholders and say so.
2. Build the document with tools on the box, in this order of preference:
   - DOCX: python `python-docx`; PDF: convert the DOCX with `libreoffice --headless --convert-to pdf`, or render
     HTML with `pandoc`/`weasyprint`/the browser's PDF print if those are missing.
   - XLSX: python `openpyxl`; fall back to CSV.
   Check which exists before you start (`python3 -c "import docx"`, `command -v libreoffice pandoc`).
3. Quotes and offers: line items with quantity, unit price, total, VAT line if the owner gave a rate, validity
   date, payment terms. Recompute totals in code — never type a sum by hand.
4. Save under `<workspace>/documents/` with a clear name (`offer-<client>-<date>.pdf`), attach it with `message`,
   and reply with one line: what it is and the total.
5. Done = the file is attached and opens (check the PDF has pages: `pdfinfo` or file size > 0).
