"""Апелляции на оценки CQA: первоначальная оценка -> спор -> решение.

Модуль не отправляет запросы к AI. Первоначальные AI/ручные оценки
остаются неизменными; финальное решение и перерасчёт хранятся отдельно.
"""
from __future__ import annotations

import copy
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from fastapi import HTTPException

from .ai import saved_for_conversation
from .quality import checklist, evaluate, load_json, save_json, saved_evaluations

APPEALS_FILE = Path(__file__).resolve().parent.parent / "data" / "appeals.json"
_WRITE_LOCK = threading.Lock()
SOURCES = ("manual", "groq", "gemini")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load() -> list[dict[str, Any]]:
    values = load_json(APPEALS_FILE, [])
    if not isinstance(values, list):
        raise HTTPException(500, "Файл апелляций повреждён.")
    return values


def _source_result(conversation_id: str, source: str) -> dict[str, Any]:
    if source not in SOURCES:
        raise HTTPException(422, "Источник оценки: manual, groq или gemini.")
    if source == "manual":
        result = saved_evaluations().get(conversation_id)
    else:
        result = saved_for_conversation(conversation_id).get(source)
    if not isinstance(result, dict) or not isinstance(result.get("criteria"), list):
        raise HTTPException(404, f"Для {source} ещё нет сохранённой оценки этого диалога.")
    return result


def _checklist_for_result(result: dict[str, Any]) -> dict[str, Any]:
    """Не применять новый чек-лист к старой оценке после его изменения."""
    saved = result.get("checklist_snapshot")
    if isinstance(saved, dict) and isinstance(saved.get("criteria"), list):
        return copy.deepcopy(saved)
    current = checklist()
    if current.get("version") != result.get("checklist_version"):
        raise HTTPException(
            409,
            "Оценка сделана по старому чек-листу без сохранённой конфигурации. "
            "Оцените диалог заново, затем подайте апелляцию.",
        )
    # Старые записи Stage 4 не содержат снимка чек-листа; если версия
    # совпадает, проверяем, что IDs, веса и типы оценки всё ещё те же.
    stored_rows = result.get("criteria", [])
    current_rows = current["criteria"]
    if len(stored_rows) != len(current_rows):
        raise HTTPException(409, "Состав критериев изменился. Нужна новая оценка.")
    for old, new in zip(stored_rows, current_rows):
        if (old.get("id"), old.get("weight"), old.get("type")) != (
            new.get("id"), new.get("weight"), new.get("type")
        ):
            raise HTTPException(409, "Критерии оценки изменились. Нужна новая оценка.")
    return current


def _target_row(result: dict[str, Any], criterion_id: str) -> dict[str, Any]:
    row = next((c for c in result["criteria"] if c.get("id") == criterion_id), None)
    if row is None:
        raise HTTPException(422, "Такого критерия нет в выбранной оценке.")
    return row


def _nonempty(value: Any, field: str) -> str:
    if not isinstance(value, str):
        raise HTTPException(422, f"{field}: введите текст.")
    value = value.strip()
    if not 3 <= len(value) <= 2000:
        raise HTTPException(422, f"{field}: требуется от 3 до 2000 символов.")
    return value


def _get_base(appeal: dict[str, Any]) -> dict[str, Any]:
    original = appeal.get("original_result")
    if not isinstance(original, dict):
        raise HTTPException(500, "Отсутствует исходная оценка апелляции.")
    return copy.deepcopy(original)


def _same_base(a: dict[str, Any], b: dict[str, Any]) -> bool:
    return (a.get("conversation_id") == b.get("conversation_id")
            and a.get("source") == b.get("source")
            and a.get("base_created_at") == b.get("base_created_at"))


def appeal_items(appeal: dict[str, Any]) -> list[dict[str, Any]]:
    """Критерии апелляции. Старые записи (один критерий) приводятся к списку."""
    items = appeal.get("items")
    if isinstance(items, list) and items:
        return items
    return [{"criterion_id": appeal.get("criterion_id"), "criterion_name": appeal.get("criterion_name"),
             "comment": appeal.get("comment"), "decision": appeal.get("decision")}]


def _with_items(appeal: dict[str, Any]) -> dict[str, Any]:
    out = dict(appeal)
    out["items"] = appeal_items(appeal)
    return out


def list_appeals(conversation_id: str) -> list[dict[str, Any]]:
    return [_with_items(a) for a in _load() if a.get("conversation_id") == conversation_id][::-1]


def get_appeal(appeal_id: str) -> dict[str, Any]:
    item = next((a for a in _load() if a.get("id") == appeal_id), None)
    if item is None:
        raise HTTPException(404, "Апелляция не найдена.")
    return _with_items(item)


def create_appeal(payload: dict[str, Any]) -> dict[str, Any]:
    """Одна апелляция может оспаривать несколько критериев одной оценки.

    Новый формат: {"items": [{"criterion_id", "comment"}, ...], "comment": общий комментарий}.
    Старый формат с одним criterion_id и comment тоже принимается.
    """
    conversation_id = str(payload.get("conversation_id", "")).strip()
    source = str(payload.get("source", "")).strip()
    if not conversation_id:
        raise HTTPException(422, "Выберите диалог.")
    raw_items = payload.get("items")
    if raw_items is None:
        raw_items = [{"criterion_id": payload.get("criterion_id"), "comment": payload.get("comment")}]
    if not isinstance(raw_items, list) or not raw_items:
        raise HTTPException(422, "Выберите хотя бы один критерий.")

    base = _source_result(conversation_id, source)
    # Прежде чем принимать спор, убеждаемся, что можем безопасно пересчитать итог.
    config = _checklist_for_result(base)
    general = str(payload.get("comment") or "").strip()
    items, seen = [], set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise HTTPException(422, "Неверный формат критерия апелляции.")
        criterion_id = str(raw.get("criterion_id", "")).strip()
        if criterion_id in seen:
            raise HTTPException(422, "Один и тот же критерий указан дважды.")
        seen.add(criterion_id)
        row = _target_row(base, criterion_id)
        comment = raw.get("comment") or general
        items.append({"criterion_id": criterion_id, "criterion_name": row.get("name", criterion_id),
                      "comment": _nonempty(comment, f"Комментарий к «{row.get('name', criterion_id)}»"),
                      "original_value": row.get("value"), "original_evidence_index": row.get("evidence_index"),
                      "decision": None})
    if len(general) > 2000:
        raise HTTPException(422, "Общий комментарий: не больше 2000 символов.")
    record = {
        "id": str(uuid.uuid4()),
        "conversation_id": conversation_id,
        "source": source,
        "items": items,
        # Поля для совместимости со старым форматом (один критерий).
        "criterion_id": items[0]["criterion_id"],
        "criterion_name": ", ".join(i["criterion_name"] for i in items),
        "comment": general or items[0]["comment"],
        "status": "pending",
        "created_at": _now(),
        "base_created_at": base.get("created_at"),
        "original_score": base.get("score"),
        "original_result": copy.deepcopy(base),
        "checklist_snapshot": config,
        "decision": None,
        "final_result": None,
    }
    with _WRITE_LOCK:
        all_appeals = _load()
        for other in all_appeals:
            if other.get("status") == "pending" and _same_base(other, record):
                busy = seen & {i.get("criterion_id") for i in appeal_items(other)}
                if busy:
                    raise HTTPException(409, "По этому критерию уже есть открытая апелляция.")
        all_appeals.append(record)
        save_json(APPEALS_FILE, all_appeals)
    return _with_items(record)


def _recalculate(base: dict[str, Any], config: dict[str, Any], conversation: dict,
                 completed: list[dict[str, Any]]) -> dict[str, Any]:
    answers = {
        row["id"]: {"value": row["value"], "reason": row["reason"],
                    "evidence_index": row["evidence_index"]}
        for row in base["criteria"]
    }
    changes = 0
    for appeal in sorted(completed, key=lambda x: x.get("decided_at") or ""):
        for item in appeal_items(appeal):
            decision = item.get("decision") or {}
            if decision.get("action") == "change":
                changes += 1
                answers[item["criterion_id"]] = {
                    "value": decision["new_value"],
                    "reason": f"Проверяющий: {decision['reason']}",
                    "evidence_index": decision["evidence_index"],
                }
    if changes == 0:
        final = copy.deepcopy(base)
    else:
        final = evaluate(conversation, config, answers)
    final["mode"] = "reviewed"
    final["source"] = completed[0]["source"] if completed else base.get("source", base.get("provider", "manual"))
    final["original_score"] = base.get("score")
    final["reviewed_changes"] = changes
    return final


def _decide_item(item: dict[str, Any], raw: dict[str, Any], base: dict[str, Any], conv: dict) -> dict[str, Any]:
    action = str(raw.get("action", "")).strip()
    name = item.get("criterion_name") or item.get("criterion_id")
    if action not in ("confirm", "change"):
        raise HTTPException(422, f"«{name}»: выберите решение — подтвердить или изменить.")
    reason = _nonempty(raw.get("reason"), f"Причина решения по «{name}»")
    original_row = _target_row(base, item["criterion_id"])
    new_value = original_row["value"]
    evidence_index = original_row["evidence_index"]
    if action == "change":
        new_value = raw.get("new_value")
        if new_value == original_row["value"]:
            raise HTTPException(422, f"«{name}»: оценка не изменилась. Выберите «Подтвердить».")
        raw_index = raw.get("evidence_index", evidence_index)
        if type(raw_index) is not int or not 0 <= raw_index < len(conv.get("transcript", [])):
            raise HTTPException(422, f"«{name}»: выберите существующую реплику-доказательство.")
        evidence_index = raw_index
    return {"action": action, "reason": reason, "old_value": original_row["value"],
            "new_value": new_value, "evidence_index": evidence_index}


def decide_appeal(appeal_id: str, payload: dict[str, Any],
                  conversation_finder: Callable[[str], dict[str, Any]]) -> dict[str, Any]:
    """Решение проверяющего по ВСЕМ критериям апелляции сразу.

    Новый формат: {"decisions": [{"criterion_id", "action", "reason", "new_value", "evidence_index"}]}.
    Для апелляции с одним критерием подходит и старый формат {"action", "reason", ...}.
    """
    with _WRITE_LOCK:
        all_appeals = _load()
        stored = next((a for a in all_appeals if a.get("id") == appeal_id), None)
        if stored is None:
            raise HTTPException(404, "Апелляция не найдена.")
        if stored["status"] != "pending":
            raise HTTPException(409, "По этой апелляции уже принято решение.")
        conv = conversation_finder(stored["conversation_id"])
        base = _get_base(stored)
        items = copy.deepcopy(appeal_items(stored))
        decisions = payload.get("decisions")
        if decisions is None:
            if len(items) != 1:
                raise HTTPException(422, "Укажите решение по каждому критерию апелляции.")
            decisions = [{**payload, "criterion_id": items[0]["criterion_id"]}]
        if not isinstance(decisions, list):
            raise HTTPException(422, "decisions должен быть списком.")
        by_id = {str(d.get("criterion_id")): d for d in decisions if isinstance(d, dict)}
        for item in items:
            raw = by_id.get(item["criterion_id"])
            if raw is None:
                raise HTTPException(422, f"Нет решения по критерию «{item.get('criterion_name')}».")
            item["decision"] = _decide_item(item, raw, base, conv)

        proposal = copy.deepcopy(stored)
        proposal["items"] = items
        proposal["decision"] = items[0]["decision"]
        proposal["decided_at"] = _now()
        proposal["status"] = "resolved"

        # Все решения для той же ИСХОДНОЙ оценки учитываются совместно.
        previous_resolved = [a for a in all_appeals if a.get("status") == "resolved" and _same_base(a, stored)]
        completed = previous_resolved + [proposal]
        final = _recalculate(base, stored["checklist_snapshot"], conv, completed)
        proposal["final_result"] = final
        proposal["final_score"] = final.get("score")
        all_appeals[all_appeals.index(stored)] = proposal
        save_json(APPEALS_FILE, all_appeals)
    return _with_items(proposal)
