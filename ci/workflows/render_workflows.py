#!/usr/bin/env python3
"""Render/check a consumer's .github/index.pkl using the shared pinned tools."""

import argparse
import hashlib
from pathlib import Path
import subprocess
import tempfile

from tools import BUNDLE, cache_directory, repository, tool, verify_bundle


def fingerprint(repo):
    inputs = {p for p in BUNDLE.rglob("*") if p.is_file() and "__pycache__" not in p.parts}
    for candidate in (repo / ".github").rglob("*"):
        if candidate.is_file() and (
            candidate.suffix in {".pkl", ".yml", ".yaml", ".json"}
            or candidate.name.startswith("PklProject")
        ):
            inputs.add(candidate)
    wrapper = repo / "scripts/render-workflows.sh"
    if wrapper.exists():
        inputs.add(wrapper)
    result = hashlib.sha256()
    for filename in sorted(inputs):
        # Use stable names when a consumer checkout moves between machines.
        prefix = "bundle/" + str(filename.relative_to(BUNDLE)) if filename.is_relative_to(BUNDLE) else str(filename.relative_to(repo))
        result.update(prefix.encode() + b"\0" + filename.read_bytes() + b"\0")
    return result.hexdigest()


def generated_files(root):
    return {p.relative_to(root): p for p in root.rglob("*") if p.is_file() and p.suffix in {".yml", ".yaml"}}


def render(repo, check=False):
    stamp = cache_directory(repo) / "render-check" / fingerprint(repo)
    if check and stamp.exists():
        print("Workflow inputs and outputs match the previous successful render check")
        return
    pkl = tool("pkl", repo)
    yamlfmt = tool("yamlfmt", repo)
    index = repo / ".github/index.pkl"
    if not index.is_file():
        raise ValueError(f"Missing Pkl entrypoint: {index}")
    with tempfile.TemporaryDirectory(prefix="render-workflows-") as temporary:
        output = Path(temporary)
        subprocess.run([
            pkl, "eval", "--project-dir", str(BUNDLE),
            "--cache-dir", str(cache_directory(repo) / "packages"),
            "-m", str(output), str(index),
        ], cwd=repo, check=True, stdout=subprocess.DEVNULL)
        rendered = generated_files(output)
        if not rendered:
            raise ValueError("Pkl produced no YAML files")
        problems = []
        for relative, filename in sorted(rendered.items()):
            subprocess.run([yamlfmt, "-conf", str(BUNDLE / "yamlfmt.yml"), str(filename)], check=True)
            target = repo / ".github" / relative
            if check:
                if not target.exists() or filename.read_bytes() != target.read_bytes():
                    problems.append(str(target.relative_to(repo)))
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(filename.read_bytes())
                print(f"Generated {target.relative_to(repo)}")
        for relative, filename in generated_files(repo / ".github").items():
            if "/vendor/" in "/" + str(relative):
                continue
            if relative not in rendered and filename.read_text().startswith("# Generated") and "Regenerate with `scripts/render-workflows.sh`" in filename.read_text():
                if check:
                    problems.append(f"{filename.relative_to(repo)} (stale generated file)")
                else:
                    filename.unlink()
                    print(f"Removed stale {filename.relative_to(repo)}")
        if problems:
            raise ValueError("Workflow YAML drifted: " + ", ".join(problems) + "; run scripts/render-workflows.sh")
    if check:
        stamp.parent.mkdir(parents=True, exist_ok=True)
        stamp.touch()
        print("Workflow YAML matches Pkl")


def lint(repo):
    actionlint = tool("actionlint", repo)
    shellcheck = tool("shellcheck", repo)
    subprocess.run([actionlint, "-shellcheck", shellcheck], cwd=repo, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--lint", action="store_true")
    arguments = parser.parse_args()
    verify_bundle()
    repo = (arguments.repo or repository()).resolve()
    if arguments.check or not arguments.lint:
        render(repo, check=arguments.check)
    if arguments.lint:
        lint(repo)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
