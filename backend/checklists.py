"""Несколько именованных чек-листов.

Активный чек-лист по-прежнему хранится в data/checklist.json (его читают
оценка, AI и апелляции). Здесь — библиотека всех чек-листов и переключение:
при выборе другой чек-лист копируется в активный с новой версией.
"""
from __future__ import annotations

import copy
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import HTTPException

from . import quality

LIBRARY_FILE = Path(__file__).resolve().parent.parent / "data" / "checklists.json"
DEFAULT_NAME = "Основной"
_LOCK = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _clean_name(value: Any) -> str:
    name = str(value or "").strip()
    if not 1 <= len(name) <= 80:
        raise HTTPException(422, "Название чек-листа: от 1 до 80 символов.")
    return name


def _load() -> dict[str, Any]:
    """Библиотека; при первом запуске создаётся из текущего активного чек-листа."""
    data = quality.load_json(LIBRARY_FILE, None)
    if isinstance(data, dict) and isinstance(data.get("items"), list) and data["items"]:
        return data
    active = quality.checklist()
    name = active.get("name") or DEFAULT_NAME
    if name in ("CQA Chat Quality Checklist", "CQA Checklist"):
        name = DEFAULT_NAME
    item = {"id": "main", "name": name, "criteria": copy.deepcopy(active["criteria"]), "updated_at": _now()}
    return {"active": "main", "items": [item]}


def _save(data: dict[str, Any]) -> None:
    quality.save_json(LIBRARY_FILE, data)


def _find(data: dict[str, Any], checklist_id: str) -> dict[str, Any]:
    item = next((i for i in data["items"] if i.get("id") == checklist_id), None)
    if item is None:
        raise HTTPException(404, "Чек-лист не найден.")
    return item


def _activate(data: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    config = quality.validate_checklist({"name": item["name"], "criteria": item["criteria"]})
    config["library_id"] = item["id"]
    quality.save_json(quality.CONFIG_FILE, config)
    data["active"] = item["id"]
    return config


def summary(data: dict[str, Any] | None = None) -> dict[str, Any]:
    data = data or _load()
    return {"active": data["active"], "items": [
        {"id": i["id"], "name": i["name"], "count": len(i.get("criteria", [])), "updated_at": i.get("updated_at")}
        for i in data["items"]]}


def list_checklists() -> dict[str, Any]:
    with _LOCK:
        data = _load()
        _save(data)
        return summary(data)


def save_active(payload: dict[str, Any]) -> dict[str, Any]:
    """Сохранить изменения активного чек-листа (и его копию в библиотеке)."""
    with _LOCK:
        data = _load()
        item = _find(data, data["active"])
        name = item["name"]  # название меняется только через «Переименовать»
        config = quality.validate_checklist({"name": name, "criteria": payload.get("criteria")})
        config["library_id"] = item["id"]
        quality.save_json(quality.CONFIG_FILE, config)
        item.update(name=name, criteria=copy.deepcopy(config["criteria"]), updated_at=_now())
        _save(data)
        return config


def create(payload: dict[str, Any]) -> dict[str, Any]:
    """Новый чек-лист: копия текущего, исходный из PDF или с одним критерием. Сразу становится активным."""
    source = str(payload.get("source") or "current")
    with _LOCK:
        data = _load()
        name = _clean_name(payload.get("name"))
        if source == "current":
            criteria = copy.deepcopy(quality.checklist()["criteria"])
        elif source == "default":
            criteria = copy.deepcopy(quality.DEFAULT_CRITERIA)
        elif source == "blank":
            criteria = [{"id": "criterion_1", "section": "Основное", "name": "Новый критерий", "weight": 10,
                         "type": "yes_no", "allow_na": False, "scale": [], "rule": "Да: опишите, что считается выполнением.",
                         "na_rule": ""}]
        else:
            raise HTTPException(422, "source: current, default или blank.")
        item = {"id": uuid.uuid4().hex[:10], "name": name, "criteria": criteria, "updated_at": _now()}
        data["items"].append(item)
        config = _activate(data, item)
        _save(data)
        return {"checklist": config, "library": summary(data)}


def activate(checklist_id: str) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        config = _activate(data, _find(data, checklist_id))
        _save(data)
        return {"checklist": config, "library": summary(data)}


def rename(checklist_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        item = _find(data, checklist_id)
        item["name"] = _clean_name(payload.get("name"))
        item["updated_at"] = _now()
        if data["active"] == checklist_id:
            config = quality.checklist()
            config["name"] = item["name"]
            quality.save_json(quality.CONFIG_FILE, config)
        _save(data)
        return summary(data)


def delete(checklist_id: str) -> dict[str, Any]:
    with _LOCK:
        data = _load()
        _find(data, checklist_id)
        if data["active"] == checklist_id:
            raise HTTPException(409, "Нельзя удалить текущий чек-лист. Сначала выберите другой.")
        data["items"] = [i for i in data["items"] if i["id"] != checklist_id]
        _save(data)
        return summary(data)
