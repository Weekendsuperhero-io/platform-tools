#!/usr/bin/env python3
"""Export a content-pinned shared workflow snapshot into a consuming repository."""

import argparse
import hashlib
import json
from pathlib import Path


SOURCE = Path(__file__).resolve().parent.parent / "ci/workflows"


def synchronize(repo, check=False):
    destination = repo.resolve() / ".github/vendor/platform-tools"
    files = {str(filename.relative_to(SOURCE)): filename.read_bytes()
             for filename in sorted(SOURCE.rglob("*"))
             if filename.is_file() and "__pycache__" not in filename.parts}
    hashes = {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}
    lock = {
        "schemaVersion": 1,
        "source": "Weekendsuperhero-io/platform-tools/ci/workflows",
        "sha256": hashlib.sha256(json.dumps(hashes, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
        "files": hashes,
    }
    files["bundle.lock.json"] = (json.dumps(lock, indent=2) + "\n").encode()
    previous = destination / "bundle.lock.json"
    old_files = json.loads(previous.read_text())["files"] if previous.exists() else {}
    changed = []
    for name, data in files.items():
        target = destination / name
        if not target.exists() or target.read_bytes() != data:
            changed.append(name)
            if not check:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
    for name in old_files.keys() - files.keys():
        target = (destination / name).resolve()
        if not target.is_relative_to(destination):
            raise ValueError(f"Unsafe path in previous snapshot: {name}")
        if target.exists():
            changed.append(name)
            if not check:
                target.unlink()
    if check and changed:
        raise ValueError("Shared workflow snapshot differs: " + ", ".join(changed))
    print(f"Shared workflow snapshot {lock['sha256']} ({len(hashes)} files)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    synchronize(arguments.repo, check=arguments.check)
