import unittest
from fastapi import HTTPException
from backend.quality import default_checklist, evaluate


class QualityTest(unittest.TestCase):
    def setUp(self):
        self.config = default_checklist()
        self.conv = {"conversation_id": "test-ru", "transcript": [
            {"speaker": "client", "timestamp": "00:00", "text": "Сколько стоит тариф?"},
            {"speaker": "operator", "timestamp": "00:03", "text": "Здравствуйте, меня зовут Алия."},
        ]}

    def answer(self, value, reason="Доказательство: сообщение оператора"):
        return {"value": value, "reason": reason, "evidence_index": 1}

    def test_full_score_and_flag(self):
        answers = {c["id"]: self.answer(20 if c["id"] == "consultation" else 10 if c["id"] == "clarity"
                                         else "no" if c["type"] == "flag" else "yes")
                   for c in self.config["criteria"]}
        result = evaluate(self.conv, self.config, answers)
        self.assertEqual(result["score"], 100)
        self.assertFalse(result["gross_violation"])
        answers["critical"]["value"] = "yes"
        result = evaluate(self.conv, self.config, answers)
        self.assertEqual(result["score"], 100)  # Грубая ошибка отдельно, без вычета.
        self.assertTrue(result["gross_violation"])

    def test_na_redistribution(self):
        vals = {"contact": "yes", "needs": "yes", "identity": "na", "consultation": 20,
                "empathy": "yes", "clarity": 10, "closing": "yes", "critical": "no"}
        answers = {k: self.answer(v) for k, v in vals.items()}
        result = evaluate(self.conv, self.config, answers)
        self.assertEqual(result["score"], 100)
        self.assertEqual(result["applicable_weight"], 80)
        answers["contact"]["value"] = "no"
        result = evaluate(self.conv, self.config, answers)
        self.assertEqual(result["score"], 87.5)

    def test_disallowed_scale_and_na(self):
        vals = {"contact": "yes", "needs": "yes", "identity": "na", "consultation": 20,
                "empathy": "yes", "clarity": 10, "closing": "yes", "critical": "no"}
        answers = {k: self.answer(v) for k, v in vals.items()}
        answers["clarity"]["value"] = 8
        with self.assertRaises(HTTPException):
            evaluate(self.conv, self.config, answers)
        answers["clarity"]["value"] = "na"
        with self.assertRaises(HTTPException):
            evaluate(self.conv, self.config, answers)


if __name__ == "__main__":
    unittest.main()
