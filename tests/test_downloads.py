"""Тесты библиотеки скриптов: тип звонок/переписка и скачивание."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import main, quality


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.patcher = patch.object(main, "DATA_FILE", Path(self.tmp.name) / "dev_records.json")
        self.patcher.start()
        self.custom_patcher = patch.object(main, "CUSTOM_FILE", Path(self.tmp.name) / "custom_records.json")
        self.custom_patcher.start()
        records = [
            {"conversation_id": "chat-1", "language": "RU", "channel": "agent chat", "transcript": [
                {"speaker": "client", "timestamp": "00:00", "text": "Привет"},
                {"speaker": "operator", "timestamp": "00:01", "text": "Здравствуйте!"}]},
            {"conversation_id": "call-1", "language": "KZ", "channel": "voice call", "transcript": [
                {"speaker": "operator", "text": "Сәлеметсіз бе"}]},
        ]
        quality.save_json(main.DATA_FILE, records)
        self.client = TestClient(main.app)

    def tearDown(self):
        self.patcher.stop()
        self.custom_patcher.stop()
        self.tmp.cleanup()

    def test_list_has_kind(self):
        kinds = {c["conversation_id"]: c["kind"] for c in self.client.get("/api/conversations").json()}
        self.assertEqual(kinds, {"chat-1": "chat", "call-1": "call"})

    def test_single_download_txt_and_json(self):
        response = self.client.get("/api/conversations/chat-1/download?format=txt")
        self.assertEqual(response.status_code, 200)
        self.assertIn('filename="chat-1.txt"', response.headers["content-disposition"])
        self.assertIn("#2 [00:01] operator: Здравствуйте!", response.text)
        data = self.client.get("/api/conversations/call-1/download?format=json").json()
        self.assertEqual(data["conversation_id"], "call-1")

    def test_export_filters_by_kind(self):
        calls = json.loads(self.client.get("/api/export?kind=call&format=json").text)
        self.assertEqual([r["conversation_id"] for r in calls], ["call-1"])
        everything = self.client.get("/api/export?kind=all&format=txt").text
        self.assertIn("chat-1", everything)
        self.assertIn("call-1", everything)

    def test_bad_params_and_missing(self):
        self.assertEqual(self.client.get("/api/export?kind=fax").status_code, 400)
        self.assertEqual(self.client.get("/api/conversations/nope/download").status_code, 404)


if __name__ == "__main__":
    unittest.main()
