from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import validate_dream as vd  # noqa: E402


class DreamValidatorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.examples = ROOT / "examples"

    def load(self, name: str):
        return json.loads((self.examples / name).read_text(encoding="utf-8"))

    def assert_valid(self, name: str) -> None:
        errors = vd.validate_batch(self.load(name), self.load("context.json"))
        self.assertEqual([], errors, "\n".join(errors))

    def assert_invalid_contains(self, batch, context, text: str) -> None:
        errors = vd.validate_batch(batch, context)
        self.assertTrue(any(text in error for error in errors), "\n".join(errors))

    def test_valid_examples(self):
        for name in ("finding.json", "no-finding.json", "blocked.json"):
            with self.subTest(name=name):
                self.assert_valid(name)

    def test_host_cursor_and_context_are_immutable(self):
        batch = self.load("no-finding.json")
        batch["run"]["cursor"]["candidate_after"] = "2099-01-01T00:00:00Z"
        self.assert_invalid_contains(batch, self.load("context.json"), "Host horizon end")

    def test_context_hash_detects_changed_input_manifest(self):
        context = self.load("context.json")
        context["input_manifest"] = []
        self.assert_invalid_contains(self.load("no-finding.json"), context, "canonical Host context")

    def test_extra_run_property_is_rejected(self):
        batch = self.load("no-finding.json")
        batch["run"]["unexpected"] = True
        self.assert_invalid_contains(batch, self.load("context.json"), "unexpected properties")

    def test_unknown_evidence_reference_is_rejected(self):
        batch = self.load("finding.json")
        batch["signal_changes"][0]["revision"]["evidence_ids"] = ["ev-0000000000000000"]
        self.assert_invalid_contains(batch, self.load("context.json"), "not issued by Host")

    def test_unknown_suppression_member_is_rejected(self):
        batch = self.load("no-finding.json")
        batch["run"]["suppression_groups"] = [{
            "id": "sg-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            "canonical_source_key": "github:github.com/example/vigil:commit:abc123",
            "suppressed_source_keys": ["invented:source"],
            "reason": "duplicate",
        }]
        self.assert_invalid_contains(batch, self.load("context.json"), "unknown Host evidence")

    def test_due_forecast_must_be_evaluated(self):
        context = self.load("context.json")
        context["known_state"]["forecasts"] = [{
            "id": "fc-12121212-1212-4121-8121-121212121212",
            "signal_id": "sig-13131313-1313-4131-8131-131313131313",
            "claim": "A due prediction",
            "due_at": "2026-07-18T00:00:00Z",
            "status": "open",
        }]
        context["context_hash"] = vd.context_hash(context)
        batch = self.load("no-finding.json")
        batch["run"]["context_hash"] = context["context_hash"]
        self.assert_invalid_contains(batch, context, "must be evaluated")

    def test_unpaired_supersession_is_rejected(self):
        batch = self.load("finding.json")
        batch["signal_changes"][0]["revision"]["supersedes"] = "sig-14141414-1414-4141-8141-141414141414"
        self.assert_invalid_contains(batch, self.load("context.json"), "paired old")

    def test_promotion_rejects_duplicate_independence_group(self):
        context = self.load("context.json")
        context["evidence_catalog"][1]["independence_group"] = context["evidence_catalog"][0]["independence_group"]
        context["context_hash"] = vd.context_hash(context)
        batch = self.load("finding.json")
        batch["run"]["context_hash"] = context["context_hash"]
        batch["signal_changes"][0]["revision"]["importance"] = 0.5
        self.assert_invalid_contains(batch, context, "promotion evidence gate")

    def test_blocked_batch_cannot_advance_or_change_state(self):
        batch = self.load("finding.json")
        batch["run"]["outcome"] = "blocked_incomplete_sources"
        batch["run"]["cursor"]["advance_on_publish"] = True
        self.assert_invalid_contains(batch, self.load("context.json"), "blocked run must not advance")
        self.assert_invalid_contains(batch, self.load("context.json"), "blocked run cannot contain")


if __name__ == "__main__":
    unittest.main()
