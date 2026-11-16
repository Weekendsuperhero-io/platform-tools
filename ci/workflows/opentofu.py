#!/usr/bin/env python3
"""Discover tracked OpenTofu configurations and check them, several at a time, on one runner."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path, PurePosixPath
import subprocess
import tempfile

from tools import repository, verify_bundle


def discover(repo, root):
    base = (repo / root).resolve()
    if not base.is_relative_to(repo) or base == repo:
        raise ValueError("Configuration root must be a directory inside the repository")
    tracked = subprocess.check_output(["git", "ls-files", "-z", "--", str(base.relative_to(repo))], cwd=repo)
    files = [PurePosixPath(name) for name in tracked.decode().split("\0") if name]
    files = [name for name in files if ".terraform" not in name.parts and (repo / name).is_file()]
    configurations = sorted({name.parent for name in files if str(name).endswith((".tf", ".tf.json", ".tofu", ".tofu.json"))})
    if not configurations:
        raise ValueError(f"No tracked OpenTofu configurations found under {root}")
    return {"schemaVersion": 1, "configurations": [
        {"path": str(directory), "test": any(
            str(name).endswith(".tftest.hcl") and name.is_relative_to(directory / "tests")
            for name in files
        )} for directory in configurations
    ]}


def check_one(repo, entry, index, cache, temporary, executable):
    """Run init, validate and any tests for one configuration; return its row and its output."""
    relative = entry["path"]
    directory = (repo / relative).resolve()
    env = dict(os.environ, TF_IN_AUTOMATION="true", TF_INPUT="false", TF_PLUGIN_CACHE_DIR=str(cache), TF_DATA_DIR=str(Path(temporary) / str(index)))
    status = {"path": relative, "init": "skipped", "validate": "skipped", "test": "skipped"}
    commands = [("init", ["init", "-backend=false", "-input=false", "-no-color"]), ("validate", ["validate", "-no-color"])]
    if (directory / ".terraform.lock.hcl").is_file():
        commands[0][1].append("-lockfile=readonly")
    if entry["test"]:
        commands.append(("test", ["test", "-no-color"]))
    output = []
    for stage, arguments in commands:
        result = subprocess.run([executable, *arguments], cwd=directory, env=env, check=False, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        output.append(result.stdout or "")
        status[stage] = "passed" if result.returncode == 0 else "failed"
        if result.returncode:
            output.append(f"::error::{relative}: tofu {stage} failed\n")
            break
    return status, "".join(output)


def worker_count(jobs=None):
    """How many configurations to check at once: the argument, else OPENTOFU_CHECK_JOBS, else every CPU."""
    value = jobs if jobs is not None else os.environ.get("OPENTOFU_CHECK_JOBS") or os.cpu_count() or 1
    try:
        value = int(value)
    except ValueError as error:
        raise ValueError(f"OPENTOFU_CHECK_JOBS must be a whole number, got {value!r}") from error
    if value < 1:
        raise ValueError(f"OPENTOFU_CHECK_JOBS must be at least 1, got {value}")
    return value


def run_checks(repo, manifest, executable="tofu", jobs=None):
    if manifest.get("schemaVersion") != 1 or not manifest.get("configurations"):
        raise ValueError("Invalid or empty OpenTofu discovery manifest")
    entries = manifest["configurations"]
    for entry in entries:
        directory = (repo / entry["path"]).resolve()
        if not directory.is_relative_to(repo) or directory == repo or not directory.is_dir():
            raise ValueError(f"Configuration must be a directory inside the repository: {entry['path']}")
    cache = Path(os.environ.get("TF_PLUGIN_CACHE_DIR", str(repo / ".opentofu-plugin-cache")))
    cache.mkdir(parents=True, exist_ok=True)
    results = []
    # Configurations are checked several at a time, each with its own data
    # directory. They share the provider cache, which OpenTofu locks between
    # processes since 1.10. Each one's output is held until it finishes and
    # printed in manifest order, so a log group is never interleaved.
    with tempfile.TemporaryDirectory(prefix="opentofu-checks-") as temporary, ThreadPoolExecutor(max_workers=min(worker_count(jobs), len(entries))) as pool:
        pending = [pool.submit(check_one, repo, entry, index, cache, temporary, executable) for index, entry in enumerate(entries)]
        for entry, future in zip(entries, pending):
            status, output = future.result()
            print(f"::group::{entry['path']}", flush=True)
            print(output, end="" if output.endswith("\n") or not output else "\n", flush=True)
            print("::endgroup::", flush=True)
            results.append(status)
    failed = any("failed" in row.values() for row in results)
    summary = "| Configuration | Init | Validate | Test |\n| --- | --- | --- | --- |\n"
    summary += "".join(f"| {row['path']} | {row['init']} | {row['validate']} | {row['test']} |\n" for row in results)
    print(summary, flush=True)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as output:
            output.write(summary + "\n")
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path)
    commands = parser.add_subparsers(dest="command", required=True)
    discovery = commands.add_parser("discover")
    discovery.add_argument("--root", default="infrastructure")
    discovery.add_argument("--output", type=Path)
    checks = commands.add_parser("check")
    checks.add_argument("--manifest", type=Path, required=True)
    arguments = parser.parse_args()
    verify_bundle()
    repo = (arguments.repo or repository()).resolve()
    if arguments.command == "discover":
        manifest = discover(repo, arguments.root)
        content = json.dumps(manifest, indent=2) + "\n"
        if arguments.output:
            arguments.output.write_text(content)
        print(content, end="")
        return 0
    return run_checks(repo, json.loads(arguments.manifest.read_text()))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
