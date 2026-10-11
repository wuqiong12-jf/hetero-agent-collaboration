"""Regression checks for the isolated, no-model verification utility itself."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import uuid

SCRIPT = Path(__file__).with_name("verify-harness-readonly.py")
SPEC = importlib.util.spec_from_file_location("relay_readonly_verifier", SCRIPT)
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


def complete_report():
    return {"version": 1, "providerRequests": 0, "modelRuns": 0,
            "readOnly": {"tools": ["read", "pwsh"], "freshHome": True, "homeRemoved": True,
                         "fileProtection": {"idleAgent": True, "readSucceeded": True, "writeDenied": True,
                                            "editDenied": True, "contentsRetained": True},
                         "sentinelsStarted": False, "unknownTools": {name: True for name in VERIFY.BLOCKED_TOOLS}},
            "workspaceWrite": {"tools": ["read", *VERIFY.BLOCKED_TOOLS, *VERIFY.SENTINELS],
                               "originalHome": True, "sentinelsStarted": True}}


class VerifierTests(unittest.TestCase):
    def test_complete_report_requires_positive_controls_and_zero_inference(self):
        VERIFY.validate_report(complete_report())
        for field in ("providerRequests", "modelRuns"):
            for amount in (1, False, None):
                report = complete_report()
                report[field] = amount
                with self.subTest(field=field, amount=amount), self.assertRaises(ValueError):
                    VERIFY.validate_report(report)

    def test_every_blocked_tool_must_be_present_in_write_control(self):
        for name in VERIFY.BLOCKED_TOOLS:
            report = complete_report()
            report["workspaceWrite"]["tools"].remove(name)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "built-in"):
                VERIFY.validate_report(report)
        for field in complete_report()["readOnly"]["fileProtection"]:
            report = complete_report()
            report["readOnly"]["fileProtection"][field] = False
            with self.subTest(fileProtection=field), self.assertRaisesRegex(ValueError, "protection"):
                VERIFY.validate_report(report)

    def test_inventory_and_dispatch_both_have_to_reject_readonly_tools(self):
        for name in (*VERIFY.BLOCKED_TOOLS, *VERIFY.SENTINELS):
            report = complete_report()
            report["readOnly"]["tools"].append(name)
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "exposed"):
                VERIFY.validate_report(report)
        for name in VERIFY.BLOCKED_TOOLS:
            report = complete_report()
            report["readOnly"]["unknownTools"][name] = False
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "UNKNOWN_TOOL"):
                VERIFY.validate_report(report)

    def test_fresh_home_cleanup_and_sentinel_control_are_required(self):
        for mode, field, value in (("readOnly", "freshHome", False), ("readOnly", "homeRemoved", False),
                                   ("readOnly", "sentinelsStarted", True), ("workspaceWrite", "originalHome", False),
                                   ("workspaceWrite", "sentinelsStarted", False)):
            report = complete_report()
            report[mode][field] = value
            with self.subTest(mode=mode, field=field), self.assertRaises(ValueError):
                VERIFY.validate_report(report)

    def test_fixture_removal_refuses_unowned_or_retargeted_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            root = Path(tempfile.mkdtemp(prefix=VERIFY.PREFIX, dir=parent))
            nonce = uuid.uuid4().hex
            (root / ".relay-fixture-owner").write_text(nonce, encoding="ascii")
            VERIFY.assert_owned_root(root, parent, nonce)
            for expected_parent, expected_nonce in ((parent.parent, nonce), (parent, "wrong")):
                with self.assertRaises(ValueError):
                    VERIFY.remove_owned_root(root, expected_parent, expected_nonce)
                self.assertTrue(root.is_dir())
            VERIFY.remove_owned_root(root, parent, nonce)
            self.assertFalse(root.exists())

    def test_isolated_environment_refuses_ambient_credentials_and_restores(self):
        saved = dict(os.environ)
        try:
            os.environ["OPENAI_API_KEY"] = "ambient-fixture-must-not-leak"
            os.environ["DEEPSEEK_API_KEY"] = "ambient-fixture-must-not-leak"
            os.environ["DSH_HOME"] = "ambient-fixture-home"
            os.environ["NODE_OPTIONS"] = "ambient-fixture-loader"
            os.environ["HTTPS_PROXY"] = "ambient-fixture-proxy"
            with tempfile.TemporaryDirectory() as temporary:
                with VERIFY.isolated_environment(Path(temporary), "http://127.0.0.1:1234/v1"):
                    self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "relay-synthetic-denied-inference")
                    for name in ("OPENAI_API_KEY", "DSH_HOME", "NODE_OPTIONS", "HTTPS_PROXY"):
                        self.assertNotIn(name, os.environ)
                    if os.name == "nt":
                        self.assertIn("SYSTEMROOT", os.environ)
                    self.assertEqual(os.environ["DSH_TELEMETRY_DISABLED"], "1")
                self.assertEqual(os.environ["DEEPSEEK_API_KEY"], "ambient-fixture-must-not-leak")
                self.assertEqual(os.environ["DSH_HOME"], "ambient-fixture-home")
        finally:
            os.environ.clear()
            os.environ.update(saved)

    def test_verify_uses_production_home_and_policy_without_prompt(self):
        bridge = VERIFY.load_bridge()
        starts = []
        closes = []

        class FakeHarness:
            def __init__(self, **config):
                self.config = config
                starts.append(config)

            def start(self):
                selected = Path(self.config["dsh_home"])
                root = Path(self.config["cwd"]).parent
                readonly = selected.name.startswith("relay-harness-readonly-")
                key = "readOnly" if readonly else "workspaceWrite"
                policy = Path(self.config["patches"][0]).read_text(encoding="utf-8")
                self_mode = "read-only" if readonly else "workspace-write"
                self.assertions(self_mode, policy)
                if not readonly:
                    for index in range(2):
                        (root / f"sentinel-{index}.started").write_text("fixture-started", encoding="utf-8")
                inventory = complete_report()[key]
                (root / f"{key}.json").write_text(json.dumps({"tools": inventory["tools"],
                    "unknown": inventory.get("unknownTools", {}), "unavailable": {},
                    "fileProtection": inventory.get("fileProtection")}), encoding="utf-8")

            @staticmethod
            def assertions(mode, policy):
                if bridge.permission_patch(mode) != policy:
                    raise AssertionError("Verifier did not use the production policy")
                if os.environ.get("DEEPSEEK_BASE_URL", "").startswith("http://127.0.0.1:") is not True:
                    raise AssertionError("Verifier allowed an external provider URL")

            def close(self):
                closes.append(self.config)

            def run(self, *_args, **_kwargs):
                raise AssertionError("Verifier must never prompt a model")

        with tempfile.TemporaryDirectory() as temporary:
            options = SimpleNamespace(temp_parent=Path(temporary), bin=Path(temporary) / "runtime.exe", timeout_seconds=1)
            report = VERIFY.verify(options, bridge=bridge, harness_class=FakeHarness)
            VERIFY.validate_report(report)
            self.assertEqual(len(starts), 2)
            self.assertEqual(len(closes), 2)
            self.assertEqual(list(Path(temporary).iterdir()), [])
            self.assertEqual(report["providerRequests"], 0)

    def test_failed_initialization_closes_runtime_and_removes_fixture(self):
        closes = []

        class FailingHarness:
            def __init__(self, **_config):
                pass

            def start(self):
                raise RuntimeError("synthetic initialization failure")

            def close(self):
                closes.append(True)

        environment = dict(os.environ)
        with tempfile.TemporaryDirectory() as temporary:
            options = SimpleNamespace(temp_parent=Path(temporary), bin=Path(temporary) / "runtime.exe", timeout_seconds=1)
            with self.assertRaisesRegex(RuntimeError, "synthetic initialization failure"):
                VERIFY.verify(options, bridge=VERIFY.load_bridge(), harness_class=FailingHarness)
            self.assertEqual(closes, [True])
            self.assertEqual(list(Path(temporary).iterdir()), [])
        self.assertEqual(dict(os.environ), environment)

    def test_one_inherited_sentinel_start_alone_fails_readonly_verification(self):
        class PartialSentinelHarness:
            def __init__(self, **config):
                self.config = config

            def start(self):
                root = Path(self.config["cwd"]).parent
                readonly = Path(self.config["dsh_home"]).name.startswith("relay-harness-readonly-")
                key = "readOnly" if readonly else "workspaceWrite"
                # Only one inherited marker appears in read-only mode. It
                # must fail even when the inventory does not advertise it.
                (root / "sentinel-0.started").write_text("fixture-started", encoding="utf-8")
                if not readonly:
                    (root / "sentinel-1.started").write_text("fixture-started", encoding="utf-8")
                inventory = complete_report()[key]
                (root / f"{key}.json").write_text(json.dumps({"tools": inventory["tools"],
                    "unknown": inventory.get("unknownTools", {}), "unavailable": {},
                    "fileProtection": inventory.get("fileProtection")}), encoding="utf-8")

            def close(self):
                pass

        with tempfile.TemporaryDirectory() as temporary:
            options = SimpleNamespace(temp_parent=Path(temporary), bin=Path(temporary) / "runtime.exe", timeout_seconds=1)
            with self.assertRaisesRegex(ValueError, "Inherited plugin control"):
                VERIFY.verify(options, bridge=VERIFY.load_bridge(), harness_class=PartialSentinelHarness)
            self.assertEqual(list(Path(temporary).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
