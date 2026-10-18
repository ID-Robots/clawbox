"""Hidden acceptance check for the static site (stdlib only).

usage: python3 -I __acceptance__/check_site.py [project_dir]   (default: cwd)
Checks: pricing.html with Basic/Pro/Team cards, nav link to pricing.html on every
page, a ~600px max-width media query that touches the nav and the cards, balanced
tags, and that every local href/src target exists.
"""
import os
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.getcwd())
PAGES = ["index.html", "about.html", "pricing.html"]
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
        "source", "track", "wbr", "param", "keygen"}
# Elements whose end tag HTML allows to be omitted.
OPTIONAL_END = {"html", "head", "body", "p", "li", "dt", "dd", "option", "optgroup",
                "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "caption",
                "rt", "rp"}
fails = []


class Page(HTMLParser):
    def __init__(self, name):
        super().__init__(convert_charrefs=True)
        self.name = name
        self.stack = []          # [tag, attrs, text_parts, is_card, label]
        self.errors = []
        self.links = []          # (attr, value)
        self.cards = []          # label (first heading, else first text) of each card-like element
        self.nav_hrefs = []
        self.in_nav = 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        for key in ("href", "src"):
            if a.get(key):
                self.links.append((key, a[key]))
        if tag == "a" and self.in_nav and a.get("href"):
            self.nav_hrefs.append(a["href"])
        if tag in VOID:
            return
        if tag == "nav":
            self.in_nav += 1
        classes = (a.get("class") or "").lower().split()
        is_card = any("card" in c for c in classes)
        self.stack.append([tag, a, [], is_card, None])

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID and self.stack and self.stack[-1][0] == tag:
            self._close(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        names = [f[0] for f in self.stack]
        if tag not in names:
            self.errors.append(f"stray </{tag}> at line {self.getpos()[0]}")
            return
        while self.stack and self.stack[-1][0] != tag:
            open_tag = self.stack[-1][0]
            if open_tag not in OPTIONAL_END:
                self.errors.append(f"<{open_tag}> not closed before </{tag}> (line {self.getpos()[0]})")
            self._close(open_tag)
        self._close(tag)

    def _close(self, tag):
        frame = self.stack.pop()
        if frame[0] == "nav":
            self.in_nav -= 1
        text = " ".join(" ".join(frame[2]).split())
        if self.stack:
            self.stack[-1][2].append(text)
        if re.fullmatch(r"h[1-6]", frame[0]) and text:
            for anc in self.stack:
                if anc[4] is None or not anc[4][0]:
                    anc[4] = (True, text)
        if frame[3]:
            self.cards.append(frame[4][1] if frame[4] else text)

    def handle_data(self, data):
        if self.stack:
            self.stack[-1][2].append(data)
            if data.strip():
                for anc in self.stack:
                    if anc[4] is None:
                        anc[4] = (False, data.strip())

    def finish(self):
        self.close()
        for frame in reversed(list(self.stack)):
            if frame[0] not in OPTIONAL_END:
                self.errors.append(f"<{frame[0]}> never closed")
            self._close(frame[0])


def local_target(value):
    v = value.strip()
    if not v or v.startswith(("#", "//", "data:", "mailto:", "tel:", "javascript:")):
        return None
    parts = urlsplit(v)
    if parts.scheme:
        return None
    return unquote(parts.path) or None


parsed = {}
for page in PAGES:
    path = os.path.join(ROOT, page)
    if not os.path.isfile(path):
        fails.append(f"{page} missing")
        continue
    p = Page(page)
    with open(path, encoding="utf-8") as fh:
        p.feed(fh.read())
    p.finish()
    parsed[page] = p
    for e in p.errors[:5]:
        fails.append(f"{page}: {e}")
    for key, value in p.links:
        target = local_target(value)
        if target is None:
            continue
        base = ROOT if target.startswith("/") else os.path.dirname(path)
        full = os.path.normpath(os.path.join(base, target.lstrip("/")))
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.exists(full):
            fails.append(f"{page}: {key}=\"{value}\" points to a missing file")
    if not any(re.sub(r"^(\./|/)", "", urlsplit(h).path) == "pricing.html" for h in p.nav_hrefs):
        fails.append(f"{page}: <nav> has no link to pricing.html")

pricing = parsed.get("pricing.html")
if pricing:
    for name in ("Basic", "Pro", "Team"):
        if not any(re.search(rf"\b{name}\b", label) for label in pricing.cards):
            fails.append(f"pricing.html: no card (element with a *card* class) headed {name}")

css_path = os.path.join(ROOT, "style.css")
css = open(css_path, encoding="utf-8").read() if os.path.isfile(css_path) else ""
css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
blocks = []
for m in re.finditer(r"@media([^{]*)\{", css):
    depth, i = 1, m.end()
    while i < len(css) and depth:
        depth += {"{": 1, "}": -1}.get(css[i], 0)
        i += 1
    blocks.append((m.group(1), css[m.end():i]))


def narrow(cond):
    for px in re.findall(r"max-width\s*:\s*(\d+(?:\.\d+)?)px", cond):
        if 480 <= float(px) <= 768:
            return True
    for px in re.findall(r"width\s*<=?\s*(\d+(?:\.\d+)?)px", cond):
        if 480 <= float(px) <= 768:
            return True
    return False


good = [body for cond, body in blocks if narrow(cond)]
if not good:
    fails.append("style.css: no max-width media query around 600px")
elif not any(re.search(r"\bnav\b", b) for b in good) or not any("card" in b for b in good):
    fails.append("style.css: the narrow-screen media query does not restyle both the nav and the cards")

if fails:
    print("FAIL")
    for f in fails:
        print(" -", f)
    sys.exit(1)
print("PASS")
