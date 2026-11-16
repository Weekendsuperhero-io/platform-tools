"""Behavioral checks for discovery, failure reporting and snapshot refresh."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ci/workflows"))
import opentofu

spec = importlib.util.spec_from_file_location("sync_workflows", ROOT / "scripts/sync-workflows.py")
sync_workflows = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync_workflows)


class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name).resolve()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True)

    def tracked(self, name, content=""):
        target = self.repo / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        subprocess.run(["git", "add", "-f", "--", name], cwd=self.repo, check=True)
        return target

    def test_discovers_new_roots_modules_and_tests_without_an_inventory(self):
        self.tracked("infrastructure/bootstrap/main.tf")
        self.tracked("infrastructure/bootstrap/tests/plan.tftest.hcl")
        self.tracked("infrastructure/modules/domain/main.tf")
        self.tracked("infrastructure/modules/domain/outputs.tf")
        self.tracked("infrastructure/domains/new.example/main.tofu")
        self.tracked("infrastructure/json/main.tf.json")
        self.tracked("infrastructure/vars/terraform.tfvars")
        self.tracked("infrastructure/bootstrap/.terraform/modules/remote/main.tf")
        untracked = self.repo / "infrastructure/untracked/main.tf"
        untracked.parent.mkdir()
        untracked.write_text("")
        result = opentofu.discover(self.repo, "infrastructure")
        self.assertEqual(result["configurations"], [
            {"path": "infrastructure/bootstrap", "test": True},
            {"path": "infrastructure/domains/new.example", "test": False},
            {"path": "infrastructure/json", "test": False},
            {"path": "infrastructure/modules/domain", "test": False},
        ])

    def test_empty_discovery_fails_instead_of_reporting_green(self):
        with self.assertRaisesRegex(ValueError, "No tracked"):
            opentofu.discover(self.repo, "infrastructure")

    def test_discovery_cannot_walk_outside_repository(self):
        with self.assertRaisesRegex(ValueError, "inside the repository"):
            opentofu.discover(self.repo, "../outside")

    def test_failed_init_and_validate_do_not_skip_later_configurations(self):
        for name in ["bad-init", "bad-validate", "good"]:
            self.tracked(f"infrastructure/{name}/main.tf")
            self.tracked(f"infrastructure/{name}/tests/plan.tftest.hcl")
        self.tracked("infrastructure/good/.terraform.lock.hcl")
        manifest = opentofu.discover(self.repo, "infrastructure")
        calls = []

        def invoke(arguments, **kwargs):
            directory = kwargs["cwd"].name
            calls.append((directory, arguments[1], kwargs["env"]["TF_DATA_DIR"]))
            self.assertEqual(kwargs["env"]["TF_INPUT"], "false")
            if arguments[1] == "init":
                self.assertIn("-backend=false", arguments)
                if directory == "good":
                    self.assertIn("-lockfile=readonly", arguments)
            failed = (directory, arguments[1]) in {("bad-init", "init"), ("bad-validate", "validate")}
            return subprocess.CompletedProcess(arguments, 1 if failed else 0)

        with mock.patch.object(opentofu.subprocess, "run", side_effect=invoke), mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(opentofu.run_checks(self.repo, manifest, jobs=1), 1)
        self.assertEqual([(name, stage) for name, stage, _ in calls], [
            ("bad-init", "init"), ("bad-validate", "init"), ("bad-validate", "validate"),
            ("good", "init"), ("good", "validate"), ("good", "test"),
        ])
        self.assertIn("| infrastructure/bad-init | failed | skipped | skipped |", output.getvalue())
        self.assertIn("| infrastructure/good | passed | passed | passed |", output.getvalue())
        self.assertEqual(len({directory for _, _, directory in calls}), 3)

    def test_configurations_run_at_once_and_report_in_manifest_order(self):
        names = ["a", "b", "c", "d"]
        for name in names:
            self.tracked(f"infrastructure/{name}/main.tf")
        manifest = opentofu.discover(self.repo, "infrastructure")
        all_in_init = threading.Barrier(len(names), timeout=10)
        calls = []

        def invoke(arguments, **kwargs):
            directory = kwargs["cwd"].name
            calls.append((directory, arguments[1]))
            if arguments[1] == "init":
                all_in_init.wait()  # Passes only if all four are in init together.
            failed = (directory, arguments[1]) == ("b", "validate")
            return subprocess.CompletedProcess(arguments, int(failed), stdout=f"{directory} {arguments[1]}\n")

        with mock.patch.object(opentofu.subprocess, "run", side_effect=invoke), mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(opentofu.run_checks(self.repo, manifest, jobs=4), 1)
        for name in names:
            self.assertEqual([stage for directory, stage in calls if directory == name], ["init", "validate"])
        text = output.getvalue()
        groups = [line for line in text.splitlines() if line.startswith("::group::")]
        self.assertEqual(groups, [f"::group::infrastructure/{name}" for name in names])
        self.assertIn("::group::infrastructure/b\nb init\nb validate\n::error::infrastructure/b: tofu validate failed\n::endgroup::", text)
        self.assertIn("| infrastructure/b | passed | failed | skipped |", text)

    def test_job_count_comes_from_the_environment_and_must_be_positive(self):
        with mock.patch.dict(os.environ, {"OPENTOFU_CHECK_JOBS": "3"}, clear=True):
            self.assertEqual(opentofu.worker_count(), 3)
        for bad in ["0", "many"]:
            with mock.patch.dict(os.environ, {"OPENTOFU_CHECK_JOBS": bad}, clear=True), self.assertRaises(ValueError):
                opentofu.worker_count()

    def test_test_failures_are_reported_in_job_summary(self):
        self.tracked("infrastructure/module/main.tf")
        self.tracked("infrastructure/module/tests/plan.tftest.hcl")
        manifest = opentofu.discover(self.repo, "infrastructure")
        summary = self.repo / "summary.md"
        def invoke(arguments, **kwargs):
            return subprocess.CompletedProcess(arguments, int(arguments[1] == "test"))
        with mock.patch.object(opentofu.subprocess, "run", side_effect=invoke), mock.patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}, clear=True), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(opentofu.run_checks(self.repo, manifest), 1)
        self.assertIn("passed | passed | failed", summary.read_text())

    def test_success_without_tests_does_not_invoke_test(self):
        self.tracked("infrastructure/module/main.tf")
        manifest = opentofu.discover(self.repo, "infrastructure")
        with mock.patch.object(opentofu.subprocess, "run", return_value=subprocess.CompletedProcess([], 0)) as invoke, mock.patch.dict(os.environ, {}, clear=True), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(opentofu.run_checks(self.repo, manifest), 0)
        self.assertEqual([call.args[0][1] for call in invoke.call_args_list], ["init", "validate"])

    def test_snapshot_refresh_is_deterministic_and_detects_edits(self):
        with contextlib.redirect_stdout(io.StringIO()):
            sync_workflows.synchronize(self.repo)
            lock = self.repo / ".github/vendor/platform-tools/bundle.lock.json"
            original = lock.read_bytes()
            sync_workflows.synchronize(self.repo, check=True)
            sync_workflows.synchronize(self.repo)
            self.assertEqual(lock.read_bytes(), original)
            source = self.repo / ".github/vendor/platform-tools/pkl/runners.pkl"
            source.write_text("edited snapshot")
            with self.assertRaisesRegex(ValueError, "snapshot differs"):
                sync_workflows.synchronize(self.repo, check=True)
            sync_workflows.synchronize(self.repo)
            self.assertEqual(lock.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
