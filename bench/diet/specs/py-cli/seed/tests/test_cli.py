import io
import unittest
from contextlib import redirect_stdout

from notes.cli import main


class ListTest(unittest.TestCase):
    def test_list(self):
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(main(["list"]), 0)
        self.assertIn("1: Groceries", out.getvalue())


if __name__ == "__main__":
    unittest.main()
