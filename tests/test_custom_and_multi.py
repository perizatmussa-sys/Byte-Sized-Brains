"""Свои диалоги, контрольный набор по group_id и апелляция по нескольким критериям."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from backend import ai, appeals, main, quality


class CustomAndMultiTests(unittest.TestCase):
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
        quality.save_json(main.DATA_FILE, [{"conversation_id": "dev-1", "language": "RU", "channel": "agent chat",
                                            "transcript": [{"speaker": "client", "text": "Привет"}]}])
        self.client = TestClient(main.app)

    def tearDown(self):
        for item in self.patchers:
            item.stop()
        self.tmp.cleanup()

    def test_parse_text_formats(self):
        rows = main.parse_transcript_text(
            "[00:01] Оператор: Здравствуйте! Меня зовут Вера.\n"
            "Клиент: Хочу вывести деньги\nс брокерского счёта.\n"
            "bot [00:05]: Передаю оператору\n"
            "3. System: Чат закрыт")
        self.assertEqual([r["speaker"] for r in rows], ["operator", "client", "bot", "system"])
        self.assertEqual(rows[0]["timestamp"], "00:01")
        self.assertEqual(rows[1]["text"], "Хочу вывести деньги\nс брокерского счёта.")
        self.assertEqual(rows[2]["timestamp"], "00:05")
        with self.assertRaises(Exception):
            main.parse_transcript_text("просто текст без ролей")

    def test_add_list_and_delete_custom(self):
        r = self.client.post("/api/conversations", json={"text": "Оператор: Добрый день\nКлиент: Спасибо",
                                                         "channel": "chat", "language": "kz"})
        self.assertEqual(r.status_code, 200, r.text)
        cid = r.json()["added"][0]
        self.assertEqual(cid, "my-kz-001")
        items = {c["conversation_id"]: c for c in self.client.get("/api/conversations").json()}
        self.assertEqual(items[cid]["origin"], "custom")
        self.assertEqual(items["dev-1"]["origin"], "DEV")
        # Дубликат ID и удаление DEV запрещены
        dup = self.client.post("/api/conversations", json={"conversation_id": "dev-1", "text": "Клиент: а"})
        self.assertEqual(dup.status_code, 409)
        self.assertEqual(self.client.delete("/api/conversations/dev-1").status_code, 403)
        self.assertEqual(self.client.delete(f"/api/conversations/{cid}").status_code, 200)
        self.assertNotIn(cid, [c["conversation_id"] for c in self.client.get("/api/conversations").json()])

    def test_add_api_format_bulk(self):
        payload = {"isSuccess": True, "data": {"records": [
            {"conversation_id": "ctrl-1", "channel": "voice call", "language": "EN",
             "transcript": [{"timestamp": "2025-01-01T10:00:00+05:00", "speaker": "operator", "text": "Hello"}]},
            {"conversation_id": "ctrl-2", "channel": "agent chat", "language": "RU",
             "transcript": [{"speaker": "client", "text": "Здравствуйте"}]}]}}
        r = self.client.post("/api/conversations", json=payload)
        self.assertEqual(r.json()["added"], ["ctrl-1", "ctrl-2"])
        self.assertEqual(self.client.get("/api/conversations/ctrl-1").json()["transcript"][0]["timestamp"],
                         "2025-01-01T10:00:00+05:00")

    def test_import_control_group_appends(self):
        fake = MagicMock()
        fake.json.return_value = {"isSuccess": True, "data": {"records": [
            {"conversation_id": "c-1", "channel": "agent chat", "language": "RU",
             "transcript": [{"speaker": "operator", "text": "Здравствуйте"}]}]}}
        fake.raise_for_status.return_value = None
        with patch.dict("os.environ", {"CQA_API_URL": "https://example.test/run?sig=abc&group_id=DEV"}), \
                patch.object(main.requests, "get", return_value=fake) as get:
            r = self.client.post("/api/import?group_id=CONTROL")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn("group_id=CONTROL", get.call_args[0][0])
        self.assertNotIn("group_id=DEV", get.call_args[0][0])
        ids = {c["conversation_id"]: c["origin"] for c in self.client.get("/api/conversations").json()}
        self.assertEqual(ids, {"dev-1": "DEV", "c-1": "CONTROL"})

    def _manual_score(self):
        conv = {"conversation_id": "m-1", "language": "RU", "channel": "agent chat", "transcript": [
            {"speaker": "client", "text": "Вопрос по счёту"},
            {"speaker": "operator", "text": "Здравствуйте, меня зовут Айгуль."},
            {"speaker": "operator", "text": "Всего доброго!"}]}
        self.client.post("/api/conversations", json=conv)
        values = {"contact": "yes", "needs": "yes", "identity": "yes", "consultation": 20,
                  "empathy": "no", "clarity": 10, "closing": "no", "critical": "no"}
        answers = {k: {"value": v, "reason": "Проверено", "evidence_index": 1} for k, v in values.items()}
        return self.client.post("/api/evaluations/m-1", json={"answers": answers}).json()

    def test_multi_criteria_appeal(self):
        base = self._manual_score()
        created = self.client.post("/api/appeals", json={
            "conversation_id": "m-1", "source": "manual", "comment": "Оператор был вежлив и попрощался",
            "items": [{"criterion_id": "empathy"}, {"criterion_id": "closing", "comment": "Есть прощание в #3"}]})
        self.assertEqual(created.status_code, 200, created.text)
        appeal = created.json()
        self.assertEqual([i["criterion_id"] for i in appeal["items"]], ["empathy", "closing"])
        self.assertEqual(appeal["items"][0]["comment"], "Оператор был вежлив и попрощался")
        # Пересечение с открытой апелляцией запрещено
        clash = self.client.post("/api/appeals", json={"conversation_id": "m-1", "source": "manual",
                                                       "items": [{"criterion_id": "closing", "comment": "ещё раз"}]})
        self.assertEqual(clash.status_code, 409)
        # Решение нужно по каждому критерию
        partial = self.client.post(f"/api/appeals/{appeal['id']}/decision", json={"decisions": [
            {"criterion_id": "closing", "action": "change", "new_value": "yes", "reason": "Есть прощание", "evidence_index": 2}]})
        self.assertEqual(partial.status_code, 422)
        done = self.client.post(f"/api/appeals/{appeal['id']}/decision", json={"decisions": [
            {"criterion_id": "empathy", "action": "confirm", "reason": "Эмпатии нет"},
            {"criterion_id": "closing", "action": "change", "new_value": "yes", "reason": "Есть прощание", "evidence_index": 2}]})
        self.assertEqual(done.status_code, 200, done.text)
        result = done.json()
        self.assertEqual(result["status"], "resolved")
        self.assertEqual([i["decision"]["action"] for i in result["items"]], ["confirm", "change"])
        self.assertGreater(result["final_score"], base["score"])
        detail = self.client.get(f"/api/appeals/{appeal['id']}").json()
        self.assertEqual(detail["final_score"], result["final_score"])


if __name__ == "__main__":
    unittest.main()
