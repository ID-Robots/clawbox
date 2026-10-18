"""Structural acceptance check for the tabulate refactor (the test suite is a separate step).

usage (in the project root): python3 -I __acceptance__/tabulate_check.py __acceptance__/tabulate-names.json

- tabulate/__init__.py is under 400 lines
- at least 4 real submodules in tabulate/ (>= 40 non-blank lines each, version.py not counted)
- every name tabulate v0.9.0 itself defined (functions, classes, constants, public or
  underscore-prefixed; stdlib re-imports excluded) is still importable from `tabulate`
- `python tabulate/__init__.py` (the CLI entry the tests use) still works
"""
import json
import os
import pathlib
import subprocess
import sys

names = set(json.load(open(sys.argv[1])))
root = pathlib.Path(os.environ.get("PROJECT") or os.getcwd())
pkg = root / "tabulate"
fail = []

init = pkg / "__init__.py"
n_init = len(init.read_text(encoding="utf-8").splitlines())
if n_init >= 400:
    fail.append(f"tabulate/__init__.py has {n_init} lines (must be < 400)")

real = []
for p in sorted(pkg.rglob("*.py")):
    if p.name in ("__init__.py", "version.py", "__main__.py") or "__pycache__" in p.parts:
        continue
    lines = [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
    if len(lines) >= 40:
        real.append(str(p.relative_to(pkg)))
if len(real) < 4:
    fail.append(f"only {len(real)} substantial submodules: {real}")

env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
code = "import tabulate,json;print(json.dumps(sorted(n for n in dir(tabulate) if not n.startswith('__'))))"
r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, cwd=root, env=env)
if r.returncode != 0:
    fail.append("import tabulate failed: " + r.stderr.strip()[-300:])
else:
    got = set(json.loads(r.stdout))
    missing = names - got
    if missing:
        fail.append(f"{len(missing)} names lost: " + ", ".join(sorted(missing)[:15]))

data = "a b\n1 2\n"
want = "  a    b\n---  ---\n  1    2"
r = subprocess.run([sys.executable, "tabulate/__init__.py", "-1"], input=data, capture_output=True, text=True, cwd=root, env=env)
if r.returncode != 0 or r.stdout.rstrip("\n") != want:
    fail.append("CLI `python tabulate/__init__.py -1` broken: " + (r.stderr.strip()[-300:] or repr(r.stdout[:200])))

print("PASS" if not fail else "FAIL:\n - " + "\n - ".join(fail))
sys.exit(1 if fail else 0)
