#!/usr/bin/env python3
"""Exercise snapshot adoption, real Pkl/YAML generation, lint and drift checks."""

from pathlib import Path
import subprocess
import sys
import tempfile


ROOT = Path(__file__).resolve().parents[2]


def main():
    with tempfile.TemporaryDirectory(prefix="shared-workflows-") as temporary:
        repo = Path(temporary)
        subprocess.run(["git", "init", "-q", str(repo)], check=True)
        (repo / ".cache").mkdir()
        cache = ROOT / ".cache/workflow-tools"
        cache.mkdir(parents=True, exist_ok=True)
        (repo / ".cache/workflow-tools").symlink_to(cache, target_is_directory=True)
        subprocess.run([sys.executable, str(ROOT / "scripts/sync-workflows.py"), "--repo", str(repo)], check=True)
        github = repo / ".github"
        (github / "index.pkl").write_text('import "vendor/platform-tools/pkl/opentofu.pkl"\nimport "vendor/platform-tools/pkl/actionlint.pkl"\noutput {\n  files {\n    ["workflows/opentofu.yml"] = opentofu.output\n    ["actionlint.yml"] = actionlint.output\n  }\n}\n')
        script = github / "vendor/platform-tools/render_workflows.py"
        command = [sys.executable, str(script), "--repo", str(repo)]
        subprocess.run(command, check=True)
        subprocess.run([*command, "--check", "--lint"], check=True)
        subprocess.run([*command, "--check"], check=True)  # Proven unchanged inputs reuse the check.
        target = github / "workflows/opentofu.yml"
        generated = target.read_bytes()
        target.write_bytes(generated + b"# deliberate output drift\n")
        failure = subprocess.run([*command, "--check"], capture_output=True, text=True)
        if failure.returncode == 0 or "Workflow YAML drifted" not in failure.stderr:
            raise AssertionError(f"Output drift was not detected: {failure.stdout} {failure.stderr}")
        target.write_bytes(generated)
        stale = github / "workflows/stale.yml"
        stale.write_bytes(generated)
        failure = subprocess.run([*command, "--check"], capture_output=True, text=True)
        if failure.returncode == 0 or "stale generated file" not in failure.stderr:
            raise AssertionError("Stale generated YAML was not detected")
        subprocess.run(command, check=True)
        if stale.exists():
            raise AssertionError("Render did not remove stale generated YAML")
        subprocess.run([*command, "--check"], check=True)
        runner_policy = github / "vendor/platform-tools/pkl/runners.pkl"
        original = runner_policy.read_bytes()
        runner_policy.write_bytes(original + b"\n// accidental edit\n")
        failure = subprocess.run([*command, "--check"], capture_output=True, text=True)
        if failure.returncode == 0 or "snapshot changed" not in failure.stderr:
            raise AssertionError("An edited dependency snapshot was not rejected")
        runner_policy.write_bytes(original)
        print("Shared workflow generation, lint, cached checks and drift detection passed")


if __name__ == "__main__":
    main()
