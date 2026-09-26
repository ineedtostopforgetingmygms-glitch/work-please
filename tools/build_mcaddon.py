#!/usr/bin/env python3
"""Packs the behavior and resource packs into dist/IndependentVillagers_v<version>.mcaddon.

    python3 tools/build_mcaddon.py
"""
import json
import os
import zipfile

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
PACKS = ["IndependentVillagers_BP", "IndependentVillagers_RP"]


def main():
    with open(os.path.join(ROOT, PACKS[0], "manifest.json"), encoding="utf-8") as f:
        version = ".".join(map(str, json.load(f)["header"]["version"]))
    out_dir = os.path.join(ROOT, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"IndependentVillagers_v{version}.mcaddon")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for pack in PACKS:
            for folder, _, files in os.walk(os.path.join(ROOT, pack)):
                for name in sorted(files):
                    path = os.path.join(folder, name)
                    z.write(path, os.path.relpath(path, ROOT))
    print(out)


if __name__ == "__main__":
    main()
