"""Настраиваемый чек-лист и детерминированный подсчёт CQA.

ВНИМАНИЕ: этот модуль НЕ оценивает диалоги автоматически.
Он проверяет ответы проверяющего/AI и считает баллы по правилам PDF.
"""
from __future__ import annotations

import copy
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "data" / "checklist.json"
RESULTS_FILE = ROOT / "data" / "evaluations.json"

DEFAULT_CRITERIA: list[dict[str, Any]] = [
    {"id": "contact", "section": "Начало и понимание запроса", "name": "Установление контакта", "weight": 10,
     "type": "yes_no", "allow_na": False, "scale": [],
     "rule": "Да: оператор поздоровался на языке клиента и представился в первом ответе.", "na_rule": ""},
    {"id": "needs", "section": "Начало и понимание запроса", "name": "Выявление потребности", "weight": 15,
     "type": "yes_no", "allow_na": True, "scale": [],
     "rule": "Да: учёл известные детали и уточнил недостающие до ответа.",
     "na_rule": "Данных для ответа хватало с самого начала."},
    {"id": "identity", "section": "Безопасность и решение", "name": "Идентификация", "weight": 20,
     "type": "yes_no", "allow_na": True, "scale": [],
     "rule": "Да: проверка личности подтверждена до раскрытия данных или защищённого действия.",
     "na_rule": "Запрос не требовал идентификации."},
    {"id": "consultation", "section": "Безопасность и решение", "name": "Корректная и полная консультация", "weight": 20,
     "type": "scale", "allow_na": True, "scale": [0, 5, 10, 15, 20],
     "rule": "20 — всё закрыто; 15 — пропущена второстепенная деталь; 10 — существенный вопрос открыт; 5 — общая подсказка; 0 — ответа нет или ошибка.",
     "na_rule": "Чат закончился до того, как клиент сформулировал запрос."},
    {"id": "empathy", "section": "Ведение и завершение", "name": "Эмпатия и клиентоориентированность", "weight": 15,
     "type": "yes_no", "allow_na": False, "scale": [],
     "rule": "Да: оператор вежлив и реагирует на конкретную проблему или неудобство клиента.", "na_rule": ""},
    {"id": "clarity", "section": "Ведение и завершение", "name": "Управление диалогом, скорость и грамотность", "weight": 15,
     "type": "scale", "allow_na": False, "scale": [0, 4, 7, 10],
     "rule": "10 — ясные ответы и предупреждение об ожидании; 7 — один сбой; 4 — клиент переспрашивает; 0 — ход диалога непонятен.", "na_rule": ""},
    {"id": "closing", "section": "Ведение и завершение", "name": "Завершение", "weight": 5,
     "type": "yes_no", "allow_na": True, "scale": [],
     "rule": "Да: оператор подвёл итог или предложил помощь и попрощался.",
     "na_rule": "Чат оборвался до возможности завершения."},
    {"id": "critical", "section": "Грубые нарушения", "name": "Грубые ошибки", "weight": 0,
     "type": "flag", "allow_na": False, "scale": [],
     "rule": "Да: есть оскорбление, платная услуга в обход компании или раскрытие конфиденциальной информации.", "na_rule": ""},
]


def default_checklist() -> dict[str, Any]:
    return {"version": 1, "name": "CQA Chat Quality Checklist", "criteria": copy.deepcopy(DEFAULT_CRITERIA)}


def save_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return copy.deepcopy(default)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=500, detail=f"Повреждён локальный файл {path.name}.") from exc


def checklist() -> dict[str, Any]:
    return load_json(CONFIG_FILE, default_checklist())


def validate_checklist(body: dict[str, Any]) -> dict[str, Any]:
    criteria = body.get("criteria")
    if not isinstance(criteria, list) or not criteria:
        raise HTTPException(422, "Добавьте хотя бы один критерий.")
    ids = set()
    cleaned = []
    for i, c in enumerate(criteria):
        if not isinstance(c, dict):
            raise HTTPException(422, f"Критерий #{i+1}: неверный формат.")
        ident = str(c.get("id", "")).strip()
        name = str(c.get("name", "")).strip()
        if not ident or not ident.replace("_", "").replace("-", "").isalnum() or ident in ids:
            raise HTTPException(422, f"Критерий #{i+1}: ID пустой, неправильный или повторяется.")
        ids.add(ident)
        if not name:
            raise HTTPException(422, f"Критерий {ident}: название обязательно.")
        ctype = c.get("type")
        if ctype not in ("yes_no", "scale", "flag"):
            raise HTTPException(422, f"Критерий {ident}: неизвестный тип.")
        raw_weight = c.get("weight", 0)
        if type(raw_weight) is not int:
            raise HTTPException(422, f"Критерий {ident}: вес должен быть целым числом.")
        weight = raw_weight
        if weight < 0 or weight > 100:
            raise HTTPException(422, f"Критерий {ident}: вес 0–100.")
        if ctype == "flag" and weight != 0:
            raise HTTPException(422, f"Критерий {ident}: флаг должен иметь вес 0.")
        if ctype != "flag" and weight == 0:
            raise HTTPException(422, f"Критерий {ident}: критерий с баллами должен иметь положительный вес.")
        allowed_na = bool(c.get("allow_na", False))
        if ctype == "flag" and allowed_na:
            raise HTTPException(422, f"Критерий {ident}: флаг не допускает N/A.")
        raw_scale = c.get("scale", [])
        if ctype == "scale":
            if not isinstance(raw_scale, list) or len(raw_scale) < 2 or not all(type(x) is int and x >= 0 for x in raw_scale):
                raise HTTPException(422, f"Критерий {ident}: нужна шкала из минимум двух целых значений.")
            scale = sorted(set(raw_scale))
            if len(scale) != len(raw_scale) or scale[0] != 0 or scale[-1] == 0:
                raise HTTPException(422, f"Критерий {ident}: шкала должна начинаться с 0 и не содержать повторений.")
        else:
            scale = []
        cleaned.append({"id": ident, "section": str(c.get("section", "Другое")).strip() or "Другое",
                        "name": name, "weight": weight, "type": ctype, "allow_na": allowed_na,
                        "scale": scale, "rule": str(c.get("rule", "")).strip(),
                        "na_rule": str(c.get("na_rule", "")).strip() if allowed_na else ""})
    if not any(c["weight"] > 0 for c in cleaned):
        raise HTTPException(422, "Добавьте хотя бы один критерий с весом.")
    return {"version": int(checklist().get("version", 1)) + 1,
            "name": str(body.get("name", "CQA Checklist")).strip() or "CQA Checklist", "criteria": cleaned}


def evaluate(conversation: dict[str, Any], configuration: dict[str, Any], answers: dict[str, Any]) -> dict[str, Any]:
    """Проверка данных и математика. Не делает никаких выводов о качестве сам по себе."""
    if not isinstance(answers, dict):
        raise HTTPException(422, "Нужен объект answers: {criterion_id: {...}}.")
    transcript = conversation.get("transcript", [])
    out = []
    raw_points = 0.0
    applicable_weight = 0.0
    sections: dict[str, dict[str, float]] = {}
    for criterion in configuration["criteria"]:
        ident = criterion["id"]
        answer = answers.get(ident)
        if not isinstance(answer, dict):
            raise HTTPException(422, f"Не заполнен критерий «{criterion['name']}».")
        value = answer.get("value")
        reason = str(answer.get("reason", "")).strip()
        if not reason:
            raise HTTPException(422, f"Укажите объяснение для «{criterion['name']}».")
        raw_evidence = answer.get("evidence_index")
        if type(raw_evidence) is not int or raw_evidence < 0 or raw_evidence >= len(transcript):
            raise HTTPException(422, f"Укажите существующую реплику-доказательство для «{criterion['name']}».")
        if value == "na":
            if not criterion["allow_na"]:
                raise HTTPException(422, f"N/A недопустим для «{criterion['name']}».")
            points = None
        elif criterion["type"] in ("yes_no", "flag"):
            if value not in ("yes", "no"):
                raise HTTPException(422, f"Для «{criterion['name']}» выберите Да или Нет.")
            points = (criterion["weight"] if value == "yes" else 0.0) if criterion["type"] == "yes_no" else None
        else:
            if type(value) is not int or value not in criterion["scale"]:
                raise HTTPException(422, f"Для «{criterion['name']}» выберите допустимое значение шкалы.")
            points = criterion["weight"] * value / criterion["scale"][-1]
        if criterion["weight"] > 0 and value != "na":
            applicable_weight += criterion["weight"]
            raw_points += points
            section = sections.setdefault(criterion["section"], {"earned": 0.0, "maximum": 0.0})
            section["earned"] += points
            section["maximum"] += criterion["weight"]
        out.append({"id": ident, "name": criterion["name"], "section": criterion["section"],
                    "value": value, "weight": criterion["weight"], "points_before_redistribution": points,
                    "reason": reason, "evidence_index": raw_evidence,
                    "evidence": transcript[raw_evidence], "type": criterion["type"]})
    score = round(raw_points / applicable_weight * 100 + 1e-10, 2) if applicable_weight else None
    section_scores = {key: round(value["earned"] / value["maximum"] * 100 + 1e-10, 2)
                      for key, value in sections.items() if value["maximum"] > 0}
    critical = [row for row in out if row["type"] == "flag" and row["value"] == "yes"]
    return {"conversation_id": conversation["conversation_id"], "checklist_name": configuration["name"],
            "checklist_version": configuration["version"], "criteria": out,
            "score": score, "applicable_weight": applicable_weight, "sections": section_scores,
            "gross_violation": bool(critical), "gross_violation_criteria": [c["name"] for c in critical],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "checklist_snapshot": copy.deepcopy(configuration)}


def saved_evaluations() -> dict[str, Any]:
    data = load_json(RESULTS_FILE, {})
    return data if isinstance(data, dict) else {}


def save_evaluation(result: dict[str, Any]) -> None:
    data = saved_evaluations()
    data[result["conversation_id"]] = result
    save_json(RESULTS_FILE, data)
