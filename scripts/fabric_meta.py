"""Minimal Fabric Loader metadata + version-predicate handling.

Enough of fabric.mod.json semantics to pick mod versions that Fabric Loader
will accept: semantic-version comparison, the predicate syntax used in
"depends"/"breaks" (>=, <, ~, ^, =, x-wildcards, space = AND, list = OR),
and nested jar-in-jar modules.
"""

import io
import json
import re
import zipfile

_WILDCARDS = {"x", "X", "*"}


def parse_version(text):
    """Return (core, prerelease) or None when text isn't semantic-version-like."""
    text = text.strip().split("+", 1)[0]
    core, _, pre = text.partition("-")
    parts = core.split(".")
    if not parts or not all(p.isdigit() or p in _WILDCARDS for p in parts):
        return None
    return parts, (pre.split(".") if pre else None)


def _cmp_pre(a, b):
    if a is None or b is None:
        return (a is None) - (b is None)  # a release sorts after any prerelease
    for x, y in zip(a, b):
        if x == y:
            continue
        if x.isdigit() and y.isdigit():
            return (int(x) > int(y)) - (int(x) < int(y))
        if x.isdigit() != y.isdigit():
            return -1 if x.isdigit() else 1
        return (x > y) - (x < y)
    return (len(a) > len(b)) - (len(a) < len(b))


def compare(a, b):
    ca, cb = [int(p) for p in a[0]], [int(p) for p in b[0]]
    n = max(len(ca), len(cb))
    ca, cb = ca + [0] * (n - len(ca)), cb + [0] * (n - len(cb))
    if ca != cb:
        return (ca > cb) - (ca < cb)
    return _cmp_pre(a[1], b[1])


def _term_ok(version, term):
    if term in ("", "*"):
        return True
    m = re.match(r"^(>=|<=|>|<|=|~|\^)?(.*)$", term)
    op, target_text = m.group(1) or "=", m.group(2)
    v, t = parse_version(version), parse_version(target_text)
    if v is None or t is None or any(p in _WILDCARDS for p in v[0]):
        # Non-semantic versions: Fabric only supports exact equality.
        return op != "=" or version.split("+")[0] == target_text.split("+")[0] or t is None
    wild = [i for i, p in enumerate(t[0]) if p in _WILDCARDS]
    if wild:  # "1.21.x" -> prefix match on the concrete components
        prefix = [int(p) for p in t[0][:wild[0]]]
        return [int(p) for p in v[0][:len(prefix)]] == prefix
    c = compare(v, t)
    if op == "=":
        return c == 0
    if op == ">=":
        return c >= 0
    if op == "<=":
        return c <= 0
    if op == ">":
        return c > 0
    if op == "<":
        return c < 0
    core = [int(p) for p in t[0]]
    if op == "~":  # same major.minor
        upper = (core + [0])[:2]
        upper[1] += 1
    else:          # "^": same major
        upper = [core[0] + 1]
    return c >= 0 and compare(v, ([str(x) for x in upper], None)) < 0


def satisfies(version, predicate):
    """predicate: str (space-separated AND) or list of str (OR)."""
    preds = predicate if isinstance(predicate, list) else [predicate]
    return any(all(_term_ok(version, t) for t in p.split()) for p in preds)


class Module:
    __slots__ = ("id", "version", "depends", "breaks", "provides")

    def __init__(self, fmj):
        self.id = fmj["id"]
        self.version = str(fmj.get("version", "0"))
        self.depends = fmj.get("depends", {}) or {}
        self.breaks = fmj.get("breaks", {}) or {}
        self.provides = list(fmj.get("provides", []) or [])

    @property
    def ids(self):
        return [self.id] + self.provides


def _load_fmj(raw):
    text = raw.decode("utf-8-sig", errors="replace")
    try:
        return json.loads(text, strict=False)
    except json.JSONDecodeError:
        text = re.sub(r"^\s*//.*$", "", text, flags=re.M)  # tolerate line comments
        return json.loads(text, strict=False)


def modules_in_jar(data):
    """All Fabric modules in a jar, including nested jar-in-jar modules."""
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        if "fabric.mod.json" not in z.namelist():
            return out
        fmj = _load_fmj(z.read("fabric.mod.json"))
        out.append(Module(fmj))
        for nested in fmj.get("jars", []) or []:
            try:
                out.extend(modules_in_jar(z.read(nested["file"])))
            except (KeyError, zipfile.BadZipFile):
                pass
    return out
