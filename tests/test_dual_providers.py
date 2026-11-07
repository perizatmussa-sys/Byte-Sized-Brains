"""Тесты двух AI без настоящих ключей и без интернет-запросов."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException

from backend import ai
from backend.quality import default_checklist


class FakeResponse:
    def __init__(self, data=None, code=200):
        self.status_code = code
        self.data = data or {}

    def json(self):
        return self.data


class DualProviderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.saved_file = patch.object(ai, "AI_RESULTS_FILE", Path(self.temp.name) / "ai_evaluations.json")
        self.saved_file.start()
        self.config = default_checklist()
        self.conv = {"conversation_id": "sample-ru-01", "channel": "agent chat", "language": "RU", "transcript": [
            {"speaker": "client", "timestamp": "00:01", "text": "Какой график работы?"},
            {"speaker": "operator", "timestamp": "00:02", "text": "Здравствуйте, я Алия. С 9 до 18."},
        ]}
        self.answers = {}
        for c in self.config["criteria"]:
            value = ("no" if c["id"] == "critical" else
                     "na" if c["id"] in ("needs", "identity") else
                     max(c["scale"]) if c["type"] == "scale" else "yes")
            self.answers[c["id"]] = {"value": value, "reason": "Опирается на реплику 2", "evidence_index": 1}
        self.env = patch.dict(os.environ, {"GROQ_API_KEY": "fake-groq", "GEMINI_API_KEY": "fake-gemini",
                                        "GROQ_MODEL": "qwen/qwen3.8-27b", "GEMINI_MODEL": "gemini-3.5-flash-lite",
                                        "CQA_ALLOW_REAL_CALLS": "false"})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.saved_file.stop()
        self.temp.cleanup()

    def groq_response(self):
        return FakeResponse({"model": "qwen/qwen3.8-27b", "choices": [{"finish_reason": "stop", "message": {
            "content": json.dumps({"answers": self.answers})}}],
            "usage": {"prompt_tokens": 150, "completion_tokens": 200, "total_tokens": 350}})

    def gemini_response(self):
        return FakeResponse({"candidates": [{"finishReason": "STOP", "content": {"parts": [
            {"text": json.dumps({"answers": self.answers})}]}}],
            "usageMetadata": {"promptTokenCount": 140, "candidatesTokenCount": 190, "totalTokenCount": 330}})

    def test_gemini_request_format_and_scoring(self):
        with patch("backend.ai.requests.post", return_value=self.gemini_response()) as post:
            result = ai.assess_one(self.conv, self.config, "gemini")
        self.assertEqual(result["provider"], "gemini")
        self.assertEqual(result["score"], 100.0)
        self.assertEqual(result["usage"]["total_tokens"], 330)
        self.assertEqual(post.call_args.kwargs["headers"]["x-goog-api-key"], "fake-gemini")
        self.assertEqual(post.call_args.kwargs["json"]["generationConfig"]["responseMimeType"], "application/json")
        self.assertIn("gemini-3.5-flash-lite:generateContent", post.call_args.args[0])

    def test_auto_fallback_on_groq_429(self):
        with patch("backend.ai.requests.post", side_effect=[FakeResponse(code=429), self.gemini_response()]) as post:
            result = ai.assess_one(self.conv, self.config, provider="auto")
        self.assertEqual(post.call_count, 2)
        self.assertEqual(result["provider"], "gemini")
        self.assertTrue(result["fallback_used"])
        self.assertIn("429", result["fallback_errors"][0])

    def test_compare_and_cache_no_second_api_call(self):
        with patch("backend.ai.requests.post", side_effect=[self.groq_response(), self.gemini_response()]) as post:
            first = ai.compare_models(self.conv, self.config)
            second = ai.compare_models(self.conv, self.config)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(set(first["results"]), {"groq", "gemini"})
        self.assertEqual(first["score_difference"], 0)
        self.assertTrue(second["results"]["groq"]["cached"])
        self.assertTrue(second["results"]["gemini"]["cached"])
        stored = ai.saved_for_conversation(self.conv["conversation_id"])
        self.assertEqual(set(stored), {"groq", "gemini"})

    def test_new_checklist_invalidates_cache(self):
        with patch("backend.ai.requests.post", side_effect=[self.groq_response(), self.groq_response()]) as post:
            ai.assess_one(self.conv, self.config, "groq")
            edited = dict(self.config)
            edited["version"] = 2
            ai.assess_one(self.conv, edited, "groq")
        self.assertEqual(post.call_count, 2)

    def test_real_calls_protected_for_both(self):
        real = {**self.conv, "channel": "voice call"}
        with patch("backend.ai.requests.post") as post:
            with self.assertRaises(HTTPException) as err:
                ai.compare_models(real, self.config)
            self.assertEqual(err.exception.status_code, 403)
            post.assert_not_called()

    def test_malformed_ai_score_rejected(self):
        wrong = self.gemini_response()
        bad = dict(self.answers)
        bad["clarity"] = {"value": 8, "reason": "Так решила модель", "evidence_index": 1}
        wrong.data["candidates"][0]["content"]["parts"][0]["text"] = json.dumps({"answers": bad})
        with patch("backend.ai.requests.post", return_value=wrong):
            with self.assertRaises(HTTPException) as err:
                ai.assess_one(self.conv, self.config, "gemini")
        self.assertEqual(err.exception.status_code, 502)
        self.assertEqual(ai.saved_ai_evaluations(), {})


if __name__ == "__main__":
    unittest.main()
