#!/usr/bin/env python3
"""Launch the built pack headlessly and make sure it reaches the title screen.

Installs every file from the .mrpack (verifying SHA-1), applies overrides,
then starts Minecraft through portablemc under Xvfb with Mesa's software
renderer. Passes once the game logs that it finished starting; fails on a
crash report, a Fabric dependency error, or a timeout.

Usage (CI): xvfb-run -a python3 scripts/smoke_test.py dist/<pack>.mrpack
"""

import hashlib
import json
import subprocess
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GAME_DIR = ROOT / "smoke" / "game"
TIMEOUT = 15 * 60
STARTED = ("Game took ", "Sound engine started")  # ModernFix / vanilla markers
FAILED = ("---- Minecraft Crash Report ----", "Incompatible mods found",
          "Mod resolution failed", "Could not execute entrypoint")
INTERESTING = ("iris", "shader", "distant", "error", "exception", "warn] [mixin")


def install(mrpack):
    with zipfile.ZipFile(mrpack) as z:
        index = json.loads(z.read("modrinth.index.json"))
        for f in index["files"]:
            dest = GAME_DIR / f["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            req = urllib.request.Request(f["downloads"][0], headers={"User-Agent": "mrpack-smoke-test"})
            data = urllib.request.urlopen(req, timeout=60).read()
            if hashlib.sha1(data).hexdigest() != f["hashes"]["sha1"]:
                raise SystemExit(f"SHA-1 mismatch for {f['path']}")
            dest.write_bytes(data)
            print(f"  installed {f['path']}")
        for name in z.namelist():
            if name.startswith("overrides/") and not name.endswith("/"):
                dest = GAME_DIR / name[len("overrides/"):]
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(z.read(name))
    return index["dependencies"]


def main():
    mrpack = Path(sys.argv[1])
    GAME_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Installing {mrpack.name}")
    deps = install(mrpack)
    version = f"fabric:{deps['minecraft']}:{deps['fabric-loader']}"

    log = GAME_DIR / "logs" / "latest.log"
    cmd = ["portablemc", "--main-dir", str(GAME_DIR), "--work-dir", str(GAME_DIR),
           "start", version, "-u", "SmokeTest", "--jvm-args=-Xmx4G -Xms1G"]
    print("Launching:", " ".join(cmd))
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    ok, reason, lines = False, "timeout", []
    deadline = time.time() + TIMEOUT
    for line in proc.stdout:
        lines.append(line)
        print(line, end="")
        if any(m in line for m in FAILED):
            reason = line.strip()
            break
        if any(m in line for m in STARTED):
            ok = True
            # Give Iris a few seconds to compile the shaderpack so it shows in the log.
            time.sleep(20)
            break
        if time.time() > deadline:
            break
    else:
        reason = f"game exited with code {proc.wait()}"

    proc.terminate()
    try:
        proc.wait(timeout=30)
    except subprocess.TimeoutExpired:
        proc.kill()

    if log.exists():
        print("\n==== Relevant latest.log lines ====")
        for line in log.read_text(errors="replace").splitlines():
            if any(k in line.lower() for k in INTERESTING):
                print(line)
    crash_dir = GAME_DIR / "crash-reports"
    if crash_dir.exists():
        for report in crash_dir.iterdir():
            print(f"\n==== {report.name} ====\n{report.read_text(errors='replace')[:6000]}")
            ok = False
            reason = "crash report written"

    print("\nSMOKE TEST", "PASSED: reached title screen" if ok else f"FAILED: {reason}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
