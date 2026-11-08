"""Offline tests for the CQA Appendix 1.0 exporter; no API keys or network needed."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import cqa_results_export as e


IDS = ["contact", "needs", "identity", "consultation", "empathy", "clarity", "closing", "critical"]
TYPES = ["yes_no", "yes_no", "yes_no", "scale", "yes_no", "scale", "yes_no", "flag"]
WEIGHTS = [10, 15, 20, 20, 15, 15, 5, 0]
NAS = [False, True, True, True, False, False, True, False]


def config():
    return {"version": 1, "name": "CQA", "criteria": [
        {"id": i, "type": t, "weight": w, "allow_na": na,
         "scale": [0, 5, 10, 15, 20] if i == "consultation" else [0, 4, 7, 10] if i == "clarity" else [],
         "name": i, "section": "default", "rule": "test", "na_rule": "test" if na else ""}
        for i, t, w, na in zip(IDS, TYPES, WEIGHTS, NAS)
    ]}


def record(cid="c1"):
    return {"conversation_id": cid,
            "channel": "agent chat", "transcript": [{"speaker": "operator", "text": "Привет"},
                                                   {"speaker": "client", "text": "Спасибо"}]}


def evaluation(cid="c1", na=False):
    vals = ["yes", "na" if na else "yes", "na" if na else "yes", 15,
            "no", 7, "yes", "no"]
    rows = [{"id": cid_, "value": v, "reason": "Test reason", "evidence_index": 0}
            for cid_, v in zip(IDS, vals)]
    # Without N/A: 10+15+20+15+0+10.5+5=75.5; with N/A: 10+15+0+10.5+5=40.5/65*100=62.31
    score = 62.31 if na else 75.5
    return {"conversation_id": cid, "criteria": rows, "score": score,
            "gross_violation": False, "model": "test_model"}


class ExportTests(unittest.TestCase):
    def test_checklist_mapping(self):
        e.check_official_checklist(config())
        bad = config()
        bad["criteria"].append({"id": "passion"})
        with self.assertRaises(e.ExportError):
            e.check_official_checklist(bad)

    def test_convert_and_score(self):
        result = e.convert_evaluation(evaluation(), record())
        self.assertEqual([x["criterion_id"] for x in result["criteria"]], list(e.OFFICIAL_ORDER))
        self.assertEqual(result["criteria"][1]["criterion_id"], "discovery")
        self.assertEqual(result["criteria"][1]["value"], True)
        self.assertEqual(result["criteria"][0]["evidence_turns"], [1])
        self.assertEqual(result["score"], {"final_score": 75.5, "critical_flag": False})

    def test_na_reweighted(self):
        r = e.convert_evaluation(evaluation(na=True), record())
        self.assertEqual(r["criteria"][1]["value"], None)
        self.assertEqual(r["score"]["final_score"], 62.31)

    def test_reject_invalid_value_and_evidence(self):
        wrong = evaluation()
        wrong["criteria"][5]["value"] = 9
        with self.assertRaises(e.ExportError):
            e.convert_evaluation(wrong, record())
        wrong = evaluation()
        wrong["criteria"][2]["evidence_index"] = 100
        with self.assertRaises(e.ExportError):
            e.convert_evaluation(wrong, record())

    def test_dev_prod_records(self):
        with tempfile.TemporaryDirectory() as tmp:
            td = Path(tmp)
            (td / "dev_records.json").write_text(json.dumps([record(str(i)) for i in range(65)]))
            prod = [{**record(f"p{i}"), "origin": "NEW"} for i in range(10)] + [{**record("x"), "origin": "USER"}]
            (td / "custom_records.json").write_text(json.dumps(prod))
            with patch.object(e, "DATA", td):
                self.assertEqual(len(e.source_records("dev")), 65)
                self.assertEqual(len(e.source_records("prod", "NEW")), 10)
                with self.assertRaises(e.ExportError):
                    e.source_records("prod", "OTHER")

    def test_document_with_errors(self):
        rows = [record("c1"), record("c2")]
        document = {"schema_version": "1.0", "team_name": e.TEAM,
                    "model": {"mode": "external_api", "name": "test_model"},
                    "results": [e.convert_evaluation(evaluation(), rows[0]),
                                e.make_error("c2", "Model unavailable")]}
        self.assertEqual(e.verify_submission(document, rows), (1, 1))
        document["results"][1]["conversation_id"] = "c1"
        with self.assertRaises(e.ExportError):
            e.verify_submission(document, rows)


if __name__ == "__main__":
    unittest.main()

class IntegrationTests(unittest.TestCase):
    def test_export_dev_mock_ai_65_and_reuse_checkpoint(self):
        # simulate exactly the same function signatures as backend.ai and backend.quality
        import sys
        import types
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            data = root / "data"
            data.mkdir()
            records = [record(f"dev-{i:03d}") for i in range(65)]
            (data / "dev_records.json").write_text(json.dumps(records))
            calls = []
            quality_module = types.ModuleType("backend.quality")
            quality_module.checklist = config
            ai_module = types.ModuleType("backend.ai")

            def assess_one(rec, configuration, provider="auto", force=False):
                calls.append(rec["conversation_id"])
                return evaluation(rec["conversation_id"])

            ai_module.assess_one = assess_one
            ai_module.saved_for_conversation = lambda cid: {"groq": evaluation(cid)}
            ai_module.get_model = lambda p: "test_model"
            with (patch.object(e, "ROOT", root), patch.object(e, "DATA", data),
                  patch.object(e, "RESULTS", root / "results"),
                  patch.dict(sys.modules, {"backend.quality": quality_module, "backend.ai": ai_module})):
                partial = e.export("dev", delay=0, max_new=3)
                self.assertTrue(partial["partial"])
                self.assertEqual(len(calls), 3)
                self.assertFalse((root / "results/dev/results.json").exists())
                result = e.export("dev", delay=0)
                self.assertEqual(len(result["results"]), 65)
                self.assertEqual(len(calls), 65)
                self.assertEqual((root / "results/dev/results.json").exists(), True)
                self.assertEqual(e.verify_submission(result, records), (65, 0))
                e.export("dev", delay=0)
                self.assertEqual(len(calls), 65)  # second run reuses checkpoint
                loaded = e.export("dev", only_validate=True)
                self.assertEqual(len(loaded["results"]), 65)
