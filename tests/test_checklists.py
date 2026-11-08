"""Несколько чек-листов: создание, выбор, переименование, удаление, правило N/A."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from backend import checklists, main, quality


class ChecklistLibraryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        folder = Path(self.tmp.name)
        self.patchers = [
            patch.object(quality, "CONFIG_FILE", folder / "checklist.json"),
            patch.object(checklists, "LIBRARY_FILE", folder / "checklists.json"),
        ]
        for item in self.patchers:
            item.start()
        self.client = TestClient(main.app)

    def tearDown(self):
        for item in self.patchers:
            item.stop()
        self.tmp.cleanup()

    def test_library_starts_with_current_checklist(self):
        # Сохранение до первого открытия библиотеки не должно возвращать техническое имя
        config = self.client.get("/api/checklist").json()
        self.assertEqual(self.client.put("/api/checklist", json=config).json()["name"], "Основной")
        lib = self.client.get("/api/checklists").json()
        self.assertEqual(lib["active"], "main")
        self.assertEqual(lib["items"][0]["name"], "Основной")
        self.assertEqual(lib["items"][0]["count"], 8)

    def test_create_switch_and_save(self):
        created = self.client.post("/api/checklists", json={"name": "Звонки", "source": "blank"}).json()
        new_id = created["library"]["active"]
        self.assertNotEqual(new_id, "main")
        self.assertEqual(len(self.client.get("/api/checklist").json()["criteria"]), 1)
        # Сохранение меняет активный чек-лист и его копию в библиотеке
        config = self.client.get("/api/checklist").json()
        config["criteria"][0]["name"] = "Приветствие"
        saved = self.client.put("/api/checklist", json=config)
        self.assertEqual(saved.status_code, 200, saved.text)
        self.assertEqual(saved.json()["name"], "Звонки")  # старое техническое имя не перезаписывает название
        # Переключение обратно на «Основной» возвращает 8 критериев и повышает версию
        before = self.client.get("/api/checklist").json()["version"]
        switched = self.client.post("/api/checklists/main/activate").json()
        self.assertEqual(len(switched["checklist"]["criteria"]), 8)
        self.assertGreater(switched["checklist"]["version"], before)
        # И снова на новый — сохранённое название критерия на месте
        again = self.client.post(f"/api/checklists/{new_id}/activate").json()
        self.assertEqual(again["checklist"]["criteria"][0]["name"], "Приветствие")

    def test_rename_and_delete(self):
        new_id = self.client.post("/api/checklists", json={"name": "Копия", "source": "current"}).json()["library"]["active"]
        self.assertEqual(self.client.delete(f"/api/checklists/{new_id}").status_code, 409)  # активный
        lib = self.client.patch("/api/checklists/main", json={"name": "Чаты"}).json()
        self.assertEqual(next(i for i in lib["items"] if i["id"] == "main")["name"], "Чаты")
        self.client.post("/api/checklists/main/activate")
        lib = self.client.delete(f"/api/checklists/{new_id}").json()
        self.assertEqual([i["id"] for i in lib["items"]], ["main"])
        self.assertEqual(self.client.post("/api/checklists", json={"name": ""}).status_code, 422)

    def test_na_rule_required_when_na_allowed(self):
        config = self.client.get("/api/checklist").json()
        contact = next(c for c in config["criteria"] if c["id"] == "contact")
        contact["allow_na"] = True
        contact["na_rule"] = ""
        r = self.client.put("/api/checklist", json=config)
        self.assertEqual(r.status_code, 422)
        self.assertIn("N/A", r.json()["detail"])


if __name__ == "__main__":
    unittest.main()
