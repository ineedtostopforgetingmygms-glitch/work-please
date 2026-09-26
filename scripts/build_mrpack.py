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


def pick_version(versions, game_version=None):
    """Prefer the newest release, then beta, then alpha."""
    if game_version:
        versions = [v for v in versions if game_version in v["game_versions"]]
    for vtype in ("release", "beta", "alpha"):
        for v in versions:  # API returns newest first
            if v["version_type"] == vtype:
                return v
    return None


def primary_file(version):
    files = version["files"]
    return next((f for f in files if f["primary"]), files[0])


class Resolver:
    def __init__(self, cfg):
        self.mc = cfg["minecraft"]
        self.loader = cfg["loader"]
        self.projects = {}   # project_id -> project json
        self.chosen = {}     # project_id -> (kind, version)
        self.warnings = []

    def project(self, id_or_slug):
        proj = get_json(f"{API}/project/{id_or_slug}")
        if proj:
            self.projects[proj["id"]] = proj
        return proj

    def mod_version(self, project_id):
        url = (f"{API}/project/{project_id}/version"
               f"?loaders={q([self.loader])}&game_versions={q([self.mc])}")
        return pick_version(get_json(url) or [])

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
        version = (self.shader_version if kind == "shader" else self.mod_version)(proj["id"])
        if not version:
            return self._miss(
                f"{kind} '{slug}' has no {self.loader} build for {self.mc}", optional)
        self.chosen[proj["id"]] = (kind, version)
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

    def check_incompatibilities(self):
        for pid, (_, version) in self.chosen.items():
            for dep in version["dependencies"]:
                if dep["dependency_type"] == "incompatible" and dep.get("project_id") in self.chosen:
                    a = self.projects[pid]["slug"]
                    b = self.projects[dep["project_id"]]["slug"]
                    raise SystemExit(f"ERROR: {a} declares itself incompatible with {b}")


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
    res = Resolver(cfg)

    print(f"Resolving for Minecraft {cfg['minecraft']} / {cfg['loader']}")
    print("Mods:")
    for m in cfg["mods"]:
        res.add(m["slug"], "mod", m.get("optional", False))
    print("Shaders:")
    for s in cfg["shaders"]:
        res.add(s["slug"], "shader", s.get("optional", False))
    res.check_incompatibilities()

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

    loader_ver = fabric_loader_version(cfg.get("fabric_loader"))
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
