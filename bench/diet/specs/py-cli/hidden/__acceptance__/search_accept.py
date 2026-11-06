"""Hidden acceptance tests for `python -m notes search <text>`.

Run from the project root: python3 __acceptance__/search_accept.py
The notes store is the in-memory list in notes/store.py, so no data dir is needed;
each call runs in a fresh interpreter with the project root as cwd.
"""
import os
import subprocess
import sys
import unittest

ROOT = os.environ.get("PROJECT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def search(*args):
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    r = subprocess.run([sys.executable, "-m", "notes", "search", *args], cwd=ROOT,
                       capture_output=True, text=True, env=env, timeout=30)
    lines = [ln.rstrip() for ln in r.stdout.splitlines() if ln.strip()]
    return r, lines


class SearchAcceptance(unittest.TestCase):
    def test_body_match_case_insensitive(self):
        r, lines = search("BREAD")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(lines, ["1: Groceries", "3: Ideas"])

    def test_title_match(self):
        r, lines = search("meet")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(lines, ["2: Meeting"])

    def test_title_or_body_each_once(self):
        # "idea" is in note 3's title only; "a" hits every note but each is listed once
        _, lines = search("idea")
        self.assertEqual(lines, ["3: Ideas"])
        _, lines = search("a")
        self.assertEqual(lines, ["1: Groceries", "2: Meeting", "3: Ideas"])

    def test_text_with_spaces(self):
        _, lines = search("the ROADMAP")
        self.assertEqual(lines, ["2: Meeting"])

    def test_no_matches(self):
        r, lines = search("zzz-nothing")
        self.assertEqual(lines, ["no matches"])
        self.assertEqual(r.stderr.strip(), "")

    def test_existing_commands_unchanged(self):
        env = dict(os.environ)
        r = subprocess.run([sys.executable, "-m", "notes", "list"], cwd=ROOT, capture_output=True, text=True, env=env)
        self.assertEqual(r.stdout.splitlines(), ["1: Groceries", "2: Meeting", "3: Ideas"])


if __name__ == "__main__":
    unittest.main()
