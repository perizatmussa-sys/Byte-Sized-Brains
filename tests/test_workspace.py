"""Тесты рабочего пространства: баллы для списка и сводка апелляций."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import ai, appeals, main, quality


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        folder = Path(self.tmp.name)
        self.patchers = [
            patch.object(appeals, "APPEALS_FILE", folder / "appeals.json"),
            patch.object(quality, "RESULTS_FILE", folder / "evaluations.json"),
            patch.object(quality, "CONFIG_FILE", folder / "checklist.json"),
            patch.object(ai, "AI_RESULTS_FILE", folder / "ai_evaluations.json"),
            patch.object(main, "DATA_FILE", folder / "dev_records.json"),
            patch.object(main, "CUSTOM_FILE", folder / "custom_records.json"),
        ]
        for item in self.patchers:
            item.start()
        self.conversation = {
            "conversation_id": "case-01", "language": "RU", "channel": "agent chat",
            "transcript": [
                {"speaker": "client", "text": "Есть вопрос по брокерскому счёту."},
                {"speaker": "operator", "text": "Здравствуйте, меня зовут Айгуль."},
                {"speaker": "operator", "text": "Открыть счёт можно в приложении."},
            ],
        }
        other = {"conversation_id": "case-02", "language": "KZ", "channel": "voice call", "transcript": [
            {"speaker": "operator", "text": "Сәлеметсіз бе"}]}
        quality.save_json(main.DATA_FILE, [self.conversation, other])
        values = {"contact": "yes", "needs": "yes", "identity": "yes", "consultation": 20,
                  "empathy": "yes", "clarity": 10, "closing": "no", "critical": "no"}
        answers = {k: {"value": v, "reason": "Проверено", "evidence_index": 1} for k, v in values.items()}
        result = quality.evaluate(self.conversation, quality.checklist(), answers)
        result["mode"] = "manual"
        quality.save_evaluation(result)
        self.client = TestClient(main.app)

    def tearDown(self):
        for item in self.patchers:
            item.stop()
        self.tmp.cleanup()

    def test_scores_primary_and_percent(self):
        scores = self.client.get("/api/scores").json()
        self.assertEqual(scores["case-01"]["primary"], "manual")
        self.assertIsNotNone(scores["case-01"]["score"])
        rows = {r["id"]: r for r in scores["case-01"]["sources"]["manual"]["criteria"]}
        self.assertEqual(rows["contact"]["percent"], 100.0)
        self.assertEqual(rows["closing"]["percent"], 0.0)
        self.assertIsNone(rows["critical"]["percent"])  # флаг без баллов
        self.assertIsNone(scores["case-02"]["primary"])
        self.assertEqual(scores["case-02"]["kind"], "call")

    def test_final_score_after_appeal_wins(self):
        appeal = self.client.post("/api/appeals", json={
            "conversation_id": "case-01", "source": "manual", "criterion_id": "closing",
            "comment": "Оператор попрощался"}).json()
        pending = self.client.get("/api/appeals/all").json()
        self.assertEqual([a["status"] for a in pending], ["pending"])
        self.assertNotIn("original_result", pending[0])
        decided = self.client.post(f"/api/appeals/{appeal['id']}/decision", json={
            "action": "change", "new_value": "yes", "reason": "Есть прощание", "evidence_index": 2})
        self.assertEqual(decided.status_code, 200, decided.text)
        scores = self.client.get("/api/scores").json()
        self.assertEqual(scores["case-01"]["primary"], "final")
        self.assertEqual(scores["case-01"]["score"], decided.json()["final_score"])

    def test_list_has_search_text(self):
        item = next(c for c in self.client.get("/api/conversations").json() if c["conversation_id"] == "case-01")
        self.assertIn("айгуль", item["search_text"])


if __name__ == "__main__":
    unittest.main()
