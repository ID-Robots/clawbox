"""What a Hermes checkout offers, read from its own source at that commit.

    python3 -I hermes_surface.py <checkout> <usage.json> > hermes-surface.json

Run it under `env -i HOME=<tmp> HERMES_HOME=<tmp>/.hermes` with the checkout's
parent as cwd: Hermes code runs here only at IMPORT time (argparse
construction, DEFAULT_CONFIG and its key validator, the FastAPI app object), no
`hermes` command is executed, and nothing outside the temporary home is read
or written. The committed OpenRPC contract is read as JSON.

No dependency is installed. A third-party module the import pulls in is
replaced by a permissive stand-in (and FastAPI's by one that records routes),
which is enough for what is read here: verified against a full venv at
v0.21.7, the argparse tree, the config tables and the route list come out
identical (the four FastAPI-generated /docs routes aside).
"""
import argparse
import importlib.abc
import importlib.machinery
import json
import os
import sys
import types

checkout, usage_path = sys.argv[1], sys.argv[2]


# ── stand-ins for third-party modules ────────────────────────────────────────
class _Stub(type):
    """Any attribute, call, subclass, iteration or decoration works and does nothing."""

    def __getattr__(cls, name):
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _make(f"{cls.__name__}.{name}")

    def __call__(cls, *a, **k):
        if len(a) == 1 and callable(a[0]) and not k:
            return a[0]
        return _make(cls.__name__ + "()")

    def __iter__(cls):
        return iter(())

    def __getitem__(cls, k):
        return _make(cls.__name__ + "[]")

    def __or__(cls, o):
        return cls

    def __ror__(cls, o):
        return cls

    def __bool__(cls):
        return False

    def __mro_entries__(cls, bases):
        return (object,)


def _make(name):
    return _Stub(name.replace(".", "_"), (), {})


class _Route:
    def __init__(self, methods, path, kind):
        self.methods, self.path, self.kind = methods, path, kind


class _Router:
    """FastAPI's APIRouter/FastAPI as far as registering routes goes."""

    def __init__(self, *a, prefix="", **k):
        self.prefix = prefix or ""
        self.routes = []
        self.router = self

    def _add(self, methods, path, kind="APIRoute"):
        self.routes.append(_Route(methods, self.prefix + path, kind))

    def api_route(self, path, *a, methods=None, **k):
        def deco(fn):
            self._add(sorted(methods or ["GET"]), path)
            return fn
        return deco

    def add_api_route(self, path, endpoint=None, *a, methods=None, **k):
        self._add(sorted(methods or ["GET"]), path)

    def add_route(self, path, endpoint=None, methods=None, *a, **k):
        self._add(sorted(methods or ["GET"]), path, "Route")

    def add_api_websocket_route(self, path, *a, **k):
        self._add(["WS"], path, "WebSocketRoute")

    def websocket(self, path, *a, **k):
        def deco(fn):
            self._add(["WS"], path, "WebSocketRoute")
            return fn
        return deco

    def include_router(self, router, *a, prefix="", **k):
        for r in router.routes:
            self.routes.append(_Route(r.methods, prefix + r.path, r.kind))

    def mount(self, path, app=None, *a, **k):
        self.routes.append(_Route(["*"], path, "Mount"))

    def __getattr__(self, name):
        if name in ("get", "post", "put", "delete", "patch", "head", "options"):
            def method(path, *a, **k):
                def deco(fn):
                    self._add([name.upper()], path)
                    return fn
                return deco
            return method

        def passthrough(*a, **k):
            if len(a) == 1 and callable(a[0]) and not k:
                return a[0]
            return lambda fn: fn
        return passthrough


class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Stand in for any module that is neither the checkout's own nor the standard library's."""

    def __init__(self, roots):
        self.roots = roots

    def find_spec(self, fullname, path, target=None):
        top = fullname.split(".")[0]
        if top in self.roots or top in sys.stdlib_module_names:
            return None
        for finder in sys.meta_path:
            if finder is self:
                continue
            try:
                if finder.find_spec(fullname, path, target) is not None:
                    return None
            except Exception:
                pass
        return importlib.machinery.ModuleSpec(fullname, self, is_package=True)

    def create_module(self, spec):
        module = types.ModuleType(spec.name)
        module.__path__ = []
        if spec.name == "fastapi":
            module.FastAPI = module.APIRouter = _Router
        module.__getattr__ = lambda n, _s=spec.name: _make(f"{_s}.{n}")
        return module

    def exec_module(self, module):
        pass


sys.path.insert(0, checkout)
roots = {n[:-3] if n.endswith(".py") else n for n in os.listdir(checkout)}
sys.meta_path.append(_Finder(roots))
usage = json.load(open(usage_path))
out = {}

# ── CLI: the whole argparse tree (plus `hermes pm`, dispatched before argparse) ─
def walk(parser, path, rows):
    options, subs = [], []
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            by_id = {}
            for name, sub in action.choices.items():
                by_id.setdefault(id(sub), [sub, []])[1].append(name)
            subs.extend(by_id.values())
        elif not isinstance(action, argparse._HelpAction):
            options.append({"flags": list(action.option_strings) or [action.dest], "positional": not action.option_strings,
                            "nargs": action.nargs if not isinstance(action.nargs, int) else str(action.nargs)})
    rows.append({"path": " ".join(path), "aliases": [], "options": options})
    for sub, names in subs:
        at = len(rows)
        walk(sub, path + [names[0]], rows)
        rows[at]["aliases"] = names[1:]


rows = []
from hermes_cli import main as hermes_main  # noqa: E402

built = hermes_main._build_cli_parser()
walk(built[0] if isinstance(built, tuple) else built, ["hermes"], rows)


class _Grab(Exception):
    pass


_parse_args = argparse.ArgumentParser.parse_args
argparse.ArgumentParser.parse_args = lambda self, *a, **k: (_ for _ in ()).throw(_Grab(self))
try:
    from pm import cli as pm_cli

    pm_cli.main([])
except _Grab as grabbed:
    walk(grabbed.args[0], ["hermes", "pm"], rows)
except Exception:
    pass
finally:
    argparse.ArgumentParser.parse_args = _parse_args
out["cli"] = rows

# `hermes chat` options argparse accepts but the gateway-routed runtime refuses.
try:
    from hermes_cli import gateway_chat as gateway_chat
except ImportError:
    out["chatRules"] = {"present": False}
else:
    flag = lambda n: ("-" if len(n) == 1 else "--") + n.replace("_", "-")  # noqa: E731
    out["chatRules"] = {"present": True,
                        "refused": sorted(flag(n) for n in getattr(gateway_chat, "_UNSUPPORTED", ())),
                        "frozenOnResume": sorted(flag(n) for n in getattr(gateway_chat, "_POLICY", ()))}

# ── config: Hermes's own validator, asked about every key ClawBox names ──────
from hermes_cli import config as hermes_config  # noqa: E402

verdicts = {}
for u in usage["usages"]:
    if u["harness"] != "hermes" or u["kind"] != "config" or u["name"] in verdicts:
        continue
    key = u["name"]
    if key.replace("_", "").isupper():  # an UPPER_SNAKE name goes to .env, not config.yaml
        verdicts[key] = {"env": True}
        continue
    known, suggestion = hermes_config._validate_config_key(key)
    wrong_prefix = getattr(hermes_config, "_is_wrong_prefix_suggestion", lambda *_: False)
    verdicts[key] = {"known": bool(known), "suggestion": suggestion,
                     "refused": (not known) and bool(wrong_prefix(key, suggestion))}
out["config"] = verdicts
try:
    from hermes_cli import config_defaults as hermes_defaults
except ImportError:  # older trees kept DEFAULT_CONFIG in config.py
    hermes_defaults = hermes_config
out["configVersion"] = hermes_defaults.DEFAULT_CONFIG.get("_config_version")

# ── the dashboard's JSON-RPC contract, as committed upstream ─────────────────
contract_path = os.path.join(checkout, "apps", "shared", "src", "gateway-contract.openrpc.json")
rpc = {}
if os.path.exists(contract_path):
    doc = json.load(open(contract_path))
    for m in doc.get("methods", []):
        rpc.setdefault(m["name"], []).append("method")
    for kind in ("x-server-requests", "x-notifications", "x-canonical-methods"):
        items = doc.get(kind) or []
        for name, _ in items.items() if isinstance(items, dict) else [(i.get("name"), i) for i in items]:
            rpc.setdefault(str(name), []).append(kind)
out["openrpc"] = rpc if os.path.exists(contract_path) else None

# ── the dashboard's REST and WebSocket routes ────────────────────────────────
from hermes_cli import web_server  # noqa: E402

out["routes"] = sorted({(",".join(r.methods), r.path) for r in web_server.app.routes if isinstance(r, _Route)})
json.dump(out, sys.stdout, indent=1, sort_keys=True)
sys.stdout.write("\n")
