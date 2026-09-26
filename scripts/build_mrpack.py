#!/usr/bin/env python3
"""Build a Modrinth modpack (.mrpack) from pack/pack.json.

Resolves every mod and shaderpack against the Modrinth API for the configured
Minecraft version + loader, pulls in required dependencies, and writes a
standard .mrpack (modrinth.index.json + overrides/) that any Modrinth-format
launcher (Modrinth App, Prism, ATLauncher, ...) can import.

Standard library only. Usage:
    python3 scripts/build_mrpack.py [--out dist]
"""

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

from fabric_meta import modules_in_jar, satisfies

ROOT = Path(__file__).resolve().parent.parent
PACK_DIR = ROOT / "pack"
API = "https://api.modrinth.com/v2"
FABRIC_META = "https://meta.fabricmc.net/v2/versions/loader"
USER_AGENT = "ineedtostopforgetingmygms-glitch/work-please (mrpack builder)"
SHADER_LOADERS = {"iris", "optifine", "canvas"}


def get_json(url, retries=4):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == retries or e.code not in (429, 500, 502, 503, 504):
                raise
        except urllib.error.URLError:
            if attempt == retries:
                raise
        time.sleep(2 ** (attempt + 1))


def q(value):
    return urllib.parse.quote(json.dumps(value))


def order_candidates(versions):
    """Newest release first, then betas, then alphas (API lists newest first)."""
    rank = {"release": 0, "beta": 1, "alpha": 2}
    return sorted(versions, key=lambda v: rank.get(v["version_type"], 3))


def pick_version(versions, game_version=None):
    if game_version:
        versions = [v for v in versions if game_version in v["game_versions"]]
    ordered = order_candidates(versions)
    return ordered[0] if ordered else None


def primary_file(version):
    files = version["files"]
    return next((f for f in files if f["primary"]), files[0])


def download(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return resp.read()


class Resolver:
    """Greedy resolver: mods earlier in pack.json win version conflicts.

    Each candidate jar's fabric.mod.json (plus nested jars) is checked against
    everything already chosen, so the result is a set Fabric Loader accepts.
    """

    MAX_CANDIDATES = 40

    def __init__(self, cfg, loader_version):
        self.mc = cfg["minecraft"]
        self.loader = cfg["loader"]
        self.env = {"minecraft": self.mc, "java": str(cfg.get("java", 21)),
                    "fabricloader": loader_version, "fabric-loader": loader_version}
        self.builtin = set(self.env) | {"mixinextras"}  # bundled with Fabric Loader
        self.projects = {}   # project_id -> project json
        self.chosen = {}     # project_id -> (kind, version)
        self.modules = []    # Fabric modules of every chosen mod
        self.provided = {}   # mod id -> version
        self.warnings = []

    def project(self, id_or_slug):
        proj = get_json(f"{API}/project/{id_or_slug}")
        if proj:
            self.projects[proj["id"]] = proj
        return proj

    def _lookup(self, mod_id, extra):
        return self.env.get(mod_id) or self.provided.get(mod_id) or extra.get(mod_id)

    def conflicts(self, mods):
        """Return a reason string if these modules clash with the chosen set."""
        new_ids = {i: m.version for m in mods for i in m.ids}
        for m in mods:
            for dep, pred in m.depends.items():
                have = self._lookup(dep, new_ids)
                if have is not None and not satisfies(have, pred):
                    return f"{m.id} needs {dep} {pred}, have {have}"
            for dep, pred in m.breaks.items():
                have = self.provided.get(dep) or new_ids.get(dep)
                if have is not None and dep not in m.ids and satisfies(have, pred):
                    return f"{m.id} breaks {dep} {pred}"
        for c in self.modules:
            for dep, pred in c.depends.items():
                if dep in new_ids and dep not in self.provided and not satisfies(new_ids[dep], pred):
                    return f"{c.id} needs {dep} {pred}, candidate has {new_ids[dep]}"
            for dep, pred in c.breaks.items():
                if dep in new_ids and dep not in self.provided and satisfies(new_ids[dep], pred):
                    return f"{c.id} breaks {dep} {pred}"
        return None

    def mod_version(self, project_id):
        url = (f"{API}/project/{project_id}/version"
               f"?loaders={q([self.loader])}&game_versions={q([self.mc])}")
        rejected = []
        for v in order_candidates(get_json(url) or [])[:self.MAX_CANDIDATES]:
            mods = modules_in_jar(download(primary_file(v)["url"]))
            reason = self.conflicts(mods)
            if reason is None:
                return v, mods, rejected
            rejected.append(f"{v['version_number']}: {reason}")
        return None, [], rejected

    def shader_version(self, project_id):
        versions = get_json(f"{API}/project/{project_id}/version") or []
        versions = [v for v in versions if SHADER_LOADERS & set(v["loaders"])]
        # Shaderpacks are largely version-agnostic under Iris: prefer an exact
        # game-version match, otherwise take the newest build.
        return pick_version(versions, self.mc) or pick_version(versions)

    def add(self, slug, kind, optional=False, reason=""):
        proj = self.project(slug)
        if not proj:
            return self._miss(f"{kind} '{slug}' not found on Modrinth", optional)
        if proj["id"] in self.chosen:
            return True
        if kind == "shader":
            version, mods, rejected = self.shader_version(proj["id"]), [], []
        else:
            version, mods, rejected = self.mod_version(proj["id"])
        for r in rejected[:3]:
            print(f"      skip {proj['slug']} {r}")
        if not version:
            return self._miss(
                f"{kind} '{proj['slug']}' has no compatible {self.loader} build for {self.mc}",
                optional)
        self.chosen[proj["id"]] = (kind, version)
        self.modules.extend(mods)
        for m in mods:
            for i in m.ids:
                self.provided.setdefault(i, m.version)
        tag = f" (dependency of {reason})" if reason else ""
        print(f"  + {proj['slug']:<24} {version['version_number']}{tag}")
        if kind == "mod":
            self._deps(version, proj["slug"])
        return True

    def _deps(self, version, parent):
        for dep in version["dependencies"]:
            if dep["dependency_type"] != "required":
                continue
            pid = dep.get("project_id")
            if not pid and dep.get("version_id"):
                v = get_json(f"{API}/version/{dep['version_id']}")
                pid = v and v["project_id"]
            if not pid:
                self.warnings.append(
                    f"{parent}: external dependency '{dep.get('file_name')}' skipped")
                continue
            if pid not in self.chosen:
                self.add(pid, "mod", optional=False, reason=parent)

    def _miss(self, msg, optional):
        if optional:
            self.warnings.append(f"skipped optional {msg}")
            print(f"  - {msg} (optional, skipped)")
            return False
        raise SystemExit(f"ERROR: {msg}")

    def validate(self):
        """Final pass: every Fabric dependency present and satisfied, no breaks."""
        errors = []
        for m in self.modules:
            for dep, pred in m.depends.items():
                have = self._lookup(dep, {})
                if have is None:
                    if dep not in self.builtin:
                        errors.append(f"{m.id} requires missing mod '{dep}' {pred}")
                elif not satisfies(have, pred):
                    errors.append(f"{m.id} requires {dep} {pred}, have {have}")
            for dep, pred in m.breaks.items():
                have = self.provided.get(dep)
                if have is not None and dep not in m.ids and satisfies(have, pred):
                    errors.append(f"{m.id} breaks {dep} {have}")
        for pid, (_, version) in self.chosen.items():
            for dep in version["dependencies"]:
                if dep["dependency_type"] == "incompatible" and dep.get("project_id") in self.chosen:
                    errors.append(f"{self.projects[pid]['slug']} is incompatible with "
                                  f"{self.projects[dep['project_id']]['slug']}")
        if errors:
            raise SystemExit("ERROR: unresolvable mod set:\n  " + "\n  ".join(errors))


def env_for(kind, project):
    if kind == "shader":
        return {"client": "required", "server": "unsupported"}
    server = project.get("server_side", "unsupported")
    server = {"required": "required", "optional": "optional"}.get(server, "unsupported")
    return {"client": "required", "server": server}


def fabric_loader_version(pinned):
    if pinned and pinned != "latest":
        return pinned
    loaders = get_json(FABRIC_META)
    return next(l["version"] for l in loaders if l.get("stable"))


def build(out_dir):
    cfg = json.loads((PACK_DIR / "pack.json").read_text())
    loader_ver = fabric_loader_version(cfg.get("fabric_loader"))
    res = Resolver(cfg, loader_ver)

    print(f"Resolving for Minecraft {cfg['minecraft']} / {cfg['loader']}")
    print("Mods:")
    for m in cfg["mods"]:
        res.add(m["slug"], "mod", m.get("optional", False))
    print("Shaders:")
    for s in cfg["shaders"]:
        res.add(s["slug"], "shader", s.get("optional", False))
    res.validate()

    files, shader_files = [], {}
    for pid, (kind, version) in res.chosen.items():
        proj = res.projects[pid]
        f = primary_file(version)
        folder = "shaderpacks" if kind == "shader" else "mods"
        files.append({
            "path": f"{folder}/{f['filename']}",
            "hashes": {"sha1": f["hashes"]["sha1"], "sha512": f["hashes"]["sha512"]},
            "env": env_for(kind, proj),
            "downloads": [f["url"]],
            "fileSize": f["size"],
        })
        if kind == "shader":
            shader_files[proj["slug"]] = f["filename"]
    files.sort(key=lambda x: x["path"].lower())

    index = {
        "formatVersion": 1,
        "game": "minecraft",
        "versionId": cfg["version"],
        "name": cfg["name"],
        "summary": cfg["summary"],
        "files": files,
        "dependencies": {"minecraft": cfg["minecraft"], "fabric-loader": loader_ver},
    }

    # Iris config: enable shaders and select the default pack out of the box.
    default_shader = shader_files[cfg["default_shader"]]
    iris_props = (
        "# Generated by build_mrpack.py\n"
        "enableShaders=true\n"
        f"shaderPack={default_shader}\n"
        "disableUpdateMessage=true\n"
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    safe_name = cfg["name"].replace(" ", "-")
    out = out_dir / f"{safe_name}-{cfg['version']}+mc{cfg['minecraft']}.mrpack"
    overrides = PACK_DIR / "overrides"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("modrinth.index.json", json.dumps(index, indent=2))
        for p in sorted(overrides.rglob("*")):
            if p.is_file():
                z.write(p, f"overrides/{p.relative_to(overrides).as_posix()}")
        z.writestr("overrides/config/iris.properties", iris_props)

    # Machine-readable manifest for CI (smoke test) and humans.
    (out_dir / "manifest.json").write_text(json.dumps({
        "mrpack": out.name,
        "minecraft": cfg["minecraft"],
        "fabric_loader": loader_ver,
        "default_shader": default_shader,
        "files": [{"path": f["path"], "url": f["downloads"][0], "sha1": f["hashes"]["sha1"]}
                  for f in files],
    }, indent=2))

    print(f"\nFabric Loader {loader_ver}")
    print(f"{len(files)} files -> {out.relative_to(ROOT) if out.is_relative_to(ROOT) else out}")
    for w in res.warnings:
        print(f"WARNING: {w}")
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=ROOT / "dist")
    args = ap.parse_args()
    build(args.out.resolve())


if __name__ == "__main__":
    sys.exit(main())
