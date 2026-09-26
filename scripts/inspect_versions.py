#!/usr/bin/env python3
"""Print recent Modrinth versions of mods with their fabric.mod.json constraints.

Maintenance helper for picking compatible pins in pack/pack.json.
Usage: python3 scripts/inspect_versions.py 1.21.1 iris sodium sodium-extra ...
"""

import io
import json
import sys
import urllib.request
import zipfile

from build_mrpack import API, USER_AGENT, get_json, primary_file, q


def fabric_meta(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    data = urllib.request.urlopen(req, timeout=60).read()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return json.loads(z.read("fabric.mod.json"), strict=False)


def main():
    mc, slugs = sys.argv[1], sys.argv[2:]
    for slug in slugs:
        versions = get_json(f"{API}/project/{slug}/version"
                            f"?loaders={q(['fabric'])}&game_versions={q([mc])}") or []
        print(f"\n=== {slug}: {len(versions)} versions for {mc}")
        for v in versions[:6]:
            meta = fabric_meta(primary_file(v)["url"])
            print(f"  {v['version_number']} [{v['version_type']}] {v['date_published'][:10]}"
                  f" fmj={meta.get('version')}")
            for key in ("depends", "breaks"):
                if meta.get(key):
                    print(f"      {key}: {json.dumps(meta[key])}")


if __name__ == "__main__":
    main()
