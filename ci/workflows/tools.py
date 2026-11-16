"""Checksum-verified CLI provisioning adapted from agent's pinned-tool scripts."""

import hashlib
import json
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


BUNDLE = Path(__file__).resolve().parent


def repository():
    return Path(subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True
    ).strip())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify_bundle():
    lock = BUNDLE / "bundle.lock.json"
    if not lock.exists():
        if BUNDLE.name == "workflows" and BUNDLE.parent.name == "ci":
            return  # The source library has no export lock.
        raise ValueError("Missing shared workflow lock; refresh from platform-tools")
    content = json.loads(lock.read_text())
    files = content["files"]
    if content["schemaVersion"] != 1 or content["sha256"] != digest(
        json.dumps(files, sort_keys=True, separators=(",", ":")).encode()
    ):
        raise ValueError("Invalid shared workflow lock; refresh from platform-tools")
    for name, expected in files.items():
        filename = (BUNDLE / name).resolve()
        if not filename.is_relative_to(BUNDLE) or digest(filename.read_bytes()) != expected:
            raise ValueError(f"Shared workflow snapshot changed: {name}; refresh from platform-tools")
    actual = {str(p.relative_to(BUNDLE)) for p in BUNDLE.rglob("*")
              if p.is_file() and "__pycache__" not in p.parts and p.name != "bundle.lock.json"}
    if actual != files.keys():
        raise ValueError("Shared workflow snapshot file list changed; refresh from platform-tools")


def cache_directory(repo):
    result = repo / ".cache/workflow-tools"
    result.mkdir(parents=True, exist_ok=True)
    return result


def tool(name, repo):
    spec = json.loads((BUNDLE / "tools.json").read_text())[name]

    def matches(filename):
        try:
            output = subprocess.check_output(
                [str(filename), *spec["versionArgs"]], text=True, stderr=subprocess.STDOUT
            )
        except (OSError, subprocess.CalledProcessError):
            return False
        return re.search(r"(?<![\d.])" + re.escape(spec["version"]) + r"(?![\d.])", output) is not None

    installed = shutil.which(name)
    if installed and matches(installed):
        return installed
    destination = cache_directory(repo) / "bin" / f"{name}-{spec['version']}"
    if destination.exists() and matches(destination):
        return str(destination)
    machine = {"aarch64": "arm64", "AMD64": "x86_64"}.get(platform.machine(), platform.machine())
    target = f"{platform.system()}-{machine}"
    if target not in spec["assets"]:
        raise ValueError(f"No pinned {name} binary for {target}")
    asset = spec["assets"][target]
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(f"Install {name} {spec['version']} ({target})", flush=True)
    with tempfile.TemporaryDirectory(prefix="workflow-tool-") as temporary:
        archive = Path(temporary) / "download"
        request = urllib.request.Request(asset["url"], headers={"User-Agent": "platform-tools-workflows"})
        with urllib.request.urlopen(request, timeout=120) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        if digest(archive.read_bytes()) != asset["sha256"]:
            raise ValueError(f"SHA-256 mismatch for {name} {spec['version']}")
        if "member" in asset:
            with tarfile.open(archive) as package:
                with package.extractfile(asset["member"]) as source, destination.open("wb") as output:
                    shutil.copyfileobj(source, output)
        else:
            shutil.copyfile(archive, destination)
    destination.chmod(0o755)
    if not matches(destination):
        raise ValueError(f"Downloaded {name} does not report {spec['version']}")
    return str(destination)
