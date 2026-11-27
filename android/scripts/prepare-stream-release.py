"""Build a public Stream APK and stage the matching update channel for GitHub."""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from zipfile import ZipFile


ANDROID = Path(__file__).resolve().parents[1]
SIGNER = "e18a0400c26f87a816203c03a9733e96370c7a4e61bc77aea05972d56af99adb"


def main():
    windows = os.name == "nt"
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        raise SystemExit("Set ANDROID_HOME to the Android SDK directory.")
    signer = Path(sdk) / "build-tools" / "36.0.0" / ("apksigner.bat" if windows else "apksigner")
    wrapper = [str(ANDROID / "gradlew.bat")] if windows else ["sh", str(ANDROID / "gradlew")]
    subprocess.run(wrapper + [":app:assembleRelease", "-PtchatPersonalProfile=false"], cwd=ANDROID, check=True)

    output = ANDROID / "app/build/outputs"
    source = output / "apk/release"
    metadata = json.loads((source / "output-metadata.json").read_text(encoding="utf-8"))
    if metadata["applicationId"] != "com.tchat.stream" or metadata["variantName"] != "release":
        raise SystemExit("Expected the TChat Stream release variant.")
    entry, = metadata["elements"]
    name = entry["versionName"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", name):
        raise SystemExit("Use a three-part Android version name.")
    apk = source / entry["outputFile"]
    verification = subprocess.check_output([str(signer), "verify", "--print-certs", str(apk)], text=True)
    if re.findall(r"certificate SHA-256 digest: ([0-9a-f]+)", verification) != [SIGNER]:
        raise SystemExit("The APK must use the existing public Stream signing certificate.")
    with ZipFile(apk) as archive:
        if any(p == "assets/alerts/profile.json" or p.startswith("assets/alerts/media/") for p in archive.namelist()):
            raise SystemExit("Personal alert assets are present in the APK.")

    digest = hashlib.sha256()
    with apk.open("rb") as contents:
        for block in iter(lambda: contents.read(1024 * 1024), b""):
            digest.update(block)
    channel = dict(versionCode=entry["versionCode"], versionName=name, size=apk.stat().st_size, sha256=digest.hexdigest())
    staged = output / "stream-release"
    staged.mkdir(exist_ok=True)
    shutil.copyfile(apk, staged / f"TChat-Stream-{name}.apk")
    (staged / "stream-release.json").write_text(json.dumps(channel, indent=2) + "\n", encoding="utf-8")
    print(f"Ready in {staged}")


if __name__ == "__main__":
    main()
