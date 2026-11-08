"""Тесты апелляций. Все данные временные; AI API не вызывается."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from fastapi.testclient import TestClient

from backend import ai, appeals, main, quality


class AppealsTests(unittest.TestCase):
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
                {"speaker": "client", "timestamp": "00:01", "text": "Есть вопрос по брокерскому счёту."},
                {"speaker": "operator", "timestamp": "00:02", "text": "Здравствуйте, меня зовут Айгуль."},
                {"speaker": "operator", "timestamp": "00:03", "text": "Открыть счёт можно в приложении."},
            ],
        }
        quality.save_json(main.DATA_FILE, [self.conversation])
        self.config = quality.default_checklist()
        values = {"contact": "yes", "needs": "yes", "identity": "yes", "consultation": 20,
                  "empathy": "yes", "clarity": 10, "closing": "yes", "critical": "no"}
        self.answers = {key: {"value": v, "reason": "Проверено в репликах диалога", "evidence_index": 1}
                        for key, v in values.items()}
        self.base = quality.evaluate(self.conversation, self.config, self.answers)
        self.base["mode"] = "manual"
        quality.save_evaluation(self.base)

    def tearDown(self):
        for item in reversed(self.patchers):
            item.stop()
        self.tmp.cleanup()

    def create(self, criterion="consultation", source="manual"):
        return appeals.create_appeal({
            "conversation_id": "case-01", "source": source,
            "criterion_id": criterion, "comment": "Оператор ответил подробнее, чем оценил AI",
        })

    def decide(self, id, action="change", new_value=10, reason="Учтены все важные реплики"):
        return appeals.decide_appeal(
            id, {"action": action, "new_value": new_value, "evidence_index": 2, "reason": reason},
            lambda _: self.conversation,
        )

    def test_create_does_not_change_original_score(self):
        item = self.create()
        self.assertEqual(item["status"], "pending")
        self.assertEqual(item["original_score"], 100)
        self.assertEqual(len(appeals.list_appeals("case-01")), 1)
        self.assertEqual(quality.saved_evaluations()["case-01"]["score"], 100)

    def test_change_grade_recalculates_and_keeps_original(self):
        item = self.create()
        updated = self.decide(item["id"])
        self.assertEqual(updated["status"], "resolved")
        self.assertEqual(updated["final_score"], 90)
        self.assertEqual(updated["final_result"]["score"], 90)
        self.assertEqual(updated["final_result"]["original_score"], 100)
        self.assertEqual(quality.saved_evaluations()["case-01"]["score"], 100)
        self.assertEqual(updated["final_result"]["criteria"][3]["value"], 10)

    def test_confirm_preserves_original_grade(self):
        item = self.create("closing")
        reviewed = self.decide(item["id"], action="confirm")
        self.assertEqual(reviewed["final_score"], 100)
        self.assertEqual(reviewed["decision"]["action"], "confirm")

    def test_na_recalculates_weight(self):
        initial = dict(self.answers)
        initial["contact"] = {**initial["contact"], "value": "no"}
        changed = quality.evaluate(self.conversation, self.config, initial)
        changed["mode"] = "manual"
        quality.save_evaluation(changed)
        item = self.create("identity")
        updated = self.decide(item["id"], new_value="na")
        self.assertEqual(updated["final_result"]["applicable_weight"], 80)
        self.assertEqual(updated["final_score"], 87.5)
        self.assertEqual(quality.saved_evaluations()["case-01"]["score"], 90)

    def test_multiple_appeals_share_same_final_result(self):
        first = self.create("consultation")
        self.decide(first["id"], new_value=10)
        second = self.create("contact")
        last = self.decide(second["id"], new_value="no")
        self.assertEqual(last["final_score"], 80)
        self.assertEqual(last["final_result"]["reviewed_changes"], 2)

    def test_invalid_grade_rejected_without_resolving(self):
        item = self.create("clarity")
        with self.assertRaises(HTTPException) as error:
            self.decide(item["id"], new_value=8)
        self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(appeals.list_appeals("case-01")[0]["status"], "pending")

    def test_duplicate_pending_and_double_decision_rejected(self):
        item = self.create()
        with self.assertRaises(HTTPException) as duplicate:
            self.create()
        self.assertEqual(duplicate.exception.status_code, 409)
        self.decide(item["id"], action="confirm")
        with self.assertRaises(HTTPException) as duplicate_decision:
            self.decide(item["id"], action="confirm")
        self.assertEqual(duplicate_decision.exception.status_code, 409)

    def test_groq_and_gemini_are_separate_sources(self):
        for source in ("groq", "gemini"):
            ai_result = {**self.base, "mode": "ai", "provider": source}
            ai.save_ai_evaluation(ai_result)
        a = self.create(source="groq")
        b = self.create(source="gemini")
        self.decide(a["id"], new_value=10)
        self.assertEqual(b["status"], "pending")
        self.assertEqual(ai.saved_for_conversation("case-01")["groq"]["score"], 100)
        self.assertEqual(ai.saved_for_conversation("case-01")["gemini"]["score"], 100)

    def test_http_endpoints(self):
        client = TestClient(main.app)
        created = client.post("/api/appeals", json={"conversation_id": "case-01", "source": "manual",
                                                   "criterion_id": "consultation", "comment": "Неправильная оценка"})
        self.assertEqual(created.status_code, 200)
        appeal_id = created.json()["id"]
        history = client.get("/api/appeals", params={"conversation_id": "case-01"})
        self.assertEqual(history.status_code, 200)
        self.assertEqual(len(history.json()), 1)
        decision = client.post(f"/api/appeals/{appeal_id}/decision", json={
            "action": "change", "new_value": 15,
            "evidence_index": 2, "reason": "Пропущена только мелочь"})
        self.assertEqual(decision.status_code, 200)
        self.assertEqual(decision.json()["final_score"], 95)

    def test_old_result_same_version_supported(self):
        old = dict(self.base)
        old.pop("checklist_snapshot")
        quality.save_evaluation(old)
        self.assertEqual(self.create()["status"], "pending")

    def test_old_result_changed_version_requires_new_evaluation(self):
        old = dict(self.base)
        old.pop("checklist_snapshot")
        quality.save_evaluation(old)
        changed = quality.default_checklist()
        changed["version"] = 2
        quality.save_json(quality.CONFIG_FILE, changed)
        with self.assertRaises(HTTPException) as exc:
            self.create()
        self.assertEqual(exc.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
