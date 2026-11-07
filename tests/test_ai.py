import json
import os
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from backend.ai import answer_schema, build_messages, evaluate_ai, can_send_to_ai, is_configured, get_model
from backend.quality import default_checklist


class FakeResponse:
    status_code = 200

    def json(self):
        return {"choices": [{"finish_reason": "stop", "message": {"content": json.dumps({"answers": self.answers})}}],
                "model": "qwen/qwen3.8-27b", "usage": {"prompt_tokens": 80, "completion_tokens": 200}}


class AiTest(unittest.TestCase):
    def setUp(self):
        self.config = default_checklist()
        self.conv = {"conversation_id": "synthetic-ru", "channel": "agent chat", "language": "RU", "transcript": [
            {"speaker": "client", "timestamp": "00:00", "text": "Во сколько вы работаете?"},
            {"speaker": "operator", "timestamp": "00:02", "text": "Здравствуйте! Я Алия, мы работаем 9-18."},
        ]}
        self.answers = {}
        for c in self.config["criteria"]:
            val = 20 if c["id"] == "consultation" else 10 if c["id"] == "clarity" else (
                "no" if c["id"] == "critical" else "na" if c["id"] in ("identity", "needs") else "yes")
            self.answers[c["id"]] = {"value": val, "reason": "Ответ проверен по реплике #2", "evidence_index": 1}

    def test_groq_configuration(self):
        with patch.dict(os.environ, {"GROQ_API_KEY": "test-key", "GROQ_MODEL": "qwen/qwen3.8-27b"}):
            self.assertTrue(is_configured())
            self.assertEqual(get_model(), "qwen/qwen3.8-27b")

    def test_dynamic_schema(self):
        schema = answer_schema(self.config, 2)
        self.assertEqual(len(schema["properties"]["answers"]["properties"]), 8)
        self.assertIn("na", schema["properties"]["answers"]["properties"]["identity"]["properties"]["value"]["enum"])
        self.assertNotIn("na", schema["properties"]["answers"]["properties"]["empathy"]["properties"]["value"]["enum"])
        self.assertIn("10", build_messages(self.conv, self.config)[-1]["content"])
        scale = schema["properties"]["answers"]["properties"]["consultation"]["properties"]["value"]
        self.assertEqual(scale["anyOf"][0]["type"], "integer")
        self.assertEqual(scale["anyOf"][1]["enum"], ["na"])

    def test_real_calls_blocked(self):
        real = {**self.conv, "channel": "voice call"}
        with patch.dict(os.environ, {"CQA_ALLOW_REAL_CALLS": "false"}):
            self.assertFalse(can_send_to_ai(real))
        with patch.dict(os.environ, {"CQA_ALLOW_REAL_CALLS": "true"}):
            self.assertTrue(can_send_to_ai(real))

    def test_valid_ai_result_uses_python_calculator(self):
        fake = FakeResponse()
        fake.answers = self.answers
        with patch.dict(os.environ, {"GROQ_API_KEY": "fake-for-test", "GROQ_MODEL": "qwen/qwen3.8-27b"}), \
                patch("backend.ai.requests.post", return_value=fake) as post:
            result = evaluate_ai(self.conv, self.config)
        self.assertEqual(result["score"], 100)
        self.assertEqual(result["mode"], "ai")
        self.assertEqual(result["applicable_weight"], 65)
        self.assertEqual(post.call_args.kwargs["json"]["model"], "qwen/qwen3.8-27b")
        self.assertEqual(post.call_args.args[0], "https://api.groq.com/openai/v1/chat/completions")

    def test_ai_fabrication_rejected(self):
        fake = FakeResponse()
        fake.answers = dict(self.answers)
        fake.answers["clarity"] = {"value": 8, "reason": "Неправильный балл", "evidence_index": 1}
        with patch.dict(os.environ, {"GROQ_API_KEY": "fake-for-test"}), \
                patch("backend.ai.requests.post", return_value=fake):
            with self.assertRaises(HTTPException) as err:
                evaluate_ai(self.conv, self.config)
        self.assertEqual(err.exception.status_code, 502)


if __name__ == "__main__":
    unittest.main()
